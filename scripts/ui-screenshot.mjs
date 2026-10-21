// One-off UI screenshot: boots the app in headless Chrome (same plumbing as
// tests/browser-smoke.mjs), imports the textured fixture so panels have
// content, selects the mesh, and captures PNGs of the three workspaces.
// Usage: node scripts/ui-screenshot.mjs [outDir]
//
// Responsive captures (overhaul 8.3 / 8.6): SIZES="1366x1024,1024x768,390x844"
// (add a `t` suffix, e.g. 1024x768t, to emulate a coarse touch pointer). Each
// size is captured empty, then with the fixture selected, then with whichever
// sheet / list the layout offers opened. Default out dir becomes .tmp/shots.
// Without SIZES the old four-workspace desktop capture at 1600x950 runs.

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const SIZES = (process.env.SIZES ?? '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
  const m = /^(\d+)x(\d+)(t?)$/i.exec(x);
  if (!m) throw new Error(`bad SIZES entry "${x}" (want WxH or WxHt)`);
  return { w: +m[1], h: +m[2], touch: !!m[3] };
});
const OUT_DIR = resolve(process.argv[2] ?? join(ROOT, SIZES.length ? '.tmp/shots' : 'docs/screens'));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-shot-'));

  const vite = spawn(process.execPath, [
    VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));

  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--window-size=1600,950', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForWs(debugPort);
    // LOCALE=ja|zh-Hant picks the UI language; UI_STYLE=original|new the interface style.
    const query = process.env.LOCALE ? `?locale=${encodeURIComponent(process.env.LOCALE)}` : '';
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html${query}`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 950, deviceScaleFactor: 1, mobile: false,
    });

    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && location.pathname.endsWith('/index.html')
      && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader
    `), 30000, 'app boot');

    // The first-run tour overlays every shot; mark it seen and close it.
    await evaluate(cdp, `(() => { try { localStorage.setItem('mx-onboard-v1', '1'); } catch { /* */ } document.querySelector('.ob-skip')?.click(); })()`);
    if (process.env.UI_STYLE) {
      // Through the app's own setter so listeners (workspace widths) re-apply.
      await evaluate(cdp, `import('/src/core/UiStyle.js').then(m => m.setStyle(${JSON.stringify(process.env.UI_STYLE)}))`);
      await new Promise(r => setTimeout(r, 300));
    }
    if (process.env.PROBE) {
      await new Promise(r => setTimeout(r, 1500));
      console.log('PROBE', await evaluate(cdp, `JSON.stringify({
        style: document.documentElement.dataset.uiStyle,
        font: getComputedStyle(document.body).fontFamily,
        zen: document.fonts.check('12px "Zen Kaku Gothic New"'),
        olVar: getComputedStyle(document.documentElement).getPropertyValue('--outliner-width'),
        cols: getComputedStyle(document.getElementById('app')).gridTemplateColumns,
        bg: getComputedStyle(document.body).backgroundColor,
        inline: document.getElementById('app').getAttribute('style'),
        faces: [...document.fonts].filter(f => f.family.includes('Zen')).map(f => f.status).reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}),
        sheets: [...document.styleSheets].filter(x => (x.href || '').includes('zen') || (x.href||'').includes('style-new')).map(x => x.href),
      })`));
    }

    const setSize = async ({ w, h, touch }) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!touch });
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'pointer', value: touch ? 'coarse' : 'fine' }, { name: 'hover', value: touch ? 'none' : 'hover' }],
      });
      await sleep(500);
    };
    const snap = async (name) => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT_DIR, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`wrote ${file}`);
    };
    // Layout health: horizontal page scroll + visible, non-fixed elements that
    // poke past the right edge (sheets are fixed/translated off-screen on purpose).
    const layoutProbe = () => evaluate(cdp, `(() => {
      const de = document.documentElement;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('#right-panel,#outliner,#asset-panel,#cursor-panel,.sheet-tab,[hidden],svg,#toast-container,#modal-root')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1) bad.push((el.id || String(el.className) || el.tagName).slice(0, 40) + '@' + Math.round(r.right));
        if (bad.length > 8) break;
      }
      return { innerW: innerWidth, docScrollW: de.scrollWidth, hScroll: de.scrollWidth > innerWidth + 1, overflowing: bad };
    })()`);

    for (const size of SIZES) {
      await setSize(size);
      const tag = `${size.w}x${size.h}${size.touch ? 't' : ''}`;
      await snap(`${tag}-0-empty`);
      console.log('LAYOUT', tag, 'empty', JSON.stringify(await layoutProbe()));
    }

    // Content so panels aren't empty: import fixture, select the mesh.
    const setup = await evaluate(cdp, `(async () => {
      try {
        const res = await fetch('/tests/fixtures/textured-quad.glb');
        const blob = await res.blob();
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const meshIds = await AssetLoader.loadFromBlob(blob, 'textured-quad.glb');
        const { Selection } = await import('/src/core/Selection.js');
        Selection.set([meshIds[0]], meshIds[0]);
        return { ok: true };
      } catch (err) { return { error: String(err?.stack ?? err) }; }
    })()`);
    if (setup?.error) throw new Error(`setup failed: ${setup.error}`);
    await sleep(800);   // settle: auto-frame animation + thumbnail
    await evaluate(cdp, `document.querySelector('.ob-skip')?.click()`);

    if (process.env.PROBE) {
      const probe = await evaluate(cdp, `(() => {
        const secs = [...document.querySelectorAll('#rp-properties-body .pp-section')];
        return {
          ws: document.body.dataset.workspace ?? '(unset)',
          n: secs.length,
          names: secs.map(s => s.dataset.section ?? '(none)'),
          display: secs.map(s => getComputedStyle(s).display),
          bodyLen: document.getElementById('rp-properties-body')?.innerHTML.length ?? -1,
        };
      })()`);
      console.log('PROBE', JSON.stringify(probe));
    }

    if (SIZES.length) {
      const click = (sel) => evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
      for (const size of SIZES) {
        const tag = `${size.w}x${size.h}${size.touch ? 't' : ''}`;
        await setSize(size);
        await evaluate(cdp, `(async () => {
          const { Workspace } = await import('/src/ui/Workspace.js');
          Workspace.setWorkspace('layout');
          const { Selection } = await import('/src/core/Selection.js');
          Selection.clear();
        })()`);
        await sleep(300);
        await snap(`${tag}-1-nothing-selected`);
        console.log('LAYOUT', tag, 'nothing', JSON.stringify(await layoutProbe()));
        await evaluate(cdp, `(async () => {
          const { Selection } = await import('/src/core/Selection.js');
          const { getState } = await import('/src/core/StateManager.js');
          const id = Object.keys(getState().scene.objects)[0];
          Selection.set([id], id);
        })()`);
        await sleep(500);
        await snap(`${tag}-2-selected`);
        console.log('LAYOUT', tag, 'selected', JSON.stringify(await layoutProbe()));
        const mode = await evaluate(cdp, `document.body.dataset.layout ?? '(unset)'`);
        console.log('MODE', tag, mode);
        if (mode === 'viewer') {
          if (await click('#viewer-root [data-vm="list"]')) { await sleep(400); await snap(`${tag}-3-object-list`); console.log('LAYOUT', tag, 'list', JSON.stringify(await layoutProbe())); await click('#viewer-root [data-vm="list"]'); }
          // Open-a-file round trip: blank scene, feed a GLB to the viewer's file input.
          await evaluate(cdp, `(async () => { const { resetWorld } = await import('/src/core/persist/ProjectLoader.js'); resetWorld(); })()`);
          await sleep(300);
          await snap(`${tag}-5-home-empty`);
          const doc = await cdp.send('DOM.getDocument', { depth: 1 });
          const fileInput = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#viewer-root .vm-file' });
          await cdp.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [join(ROOT, 'tests/fixtures/textured-quad.glb')] });
          await sleep(1500);
          const opened = await evaluate(cdp, `(async () => { const { getState } = await import('/src/core/StateManager.js'); return { objects: Object.keys(getState().scene.objects).length, vm: document.querySelector('#viewer-root .vm-title')?.textContent }; })()`);
          console.log('OPENED', tag, JSON.stringify(opened));
          await snap(`${tag}-6-opened-file`);
          if (await click('#viewer-root [data-vm="home"]')) { await sleep(400); await snap(`${tag}-4-home`); console.log('LAYOUT', tag, 'home', JSON.stringify(await layoutProbe())); await click('#viewer-root [data-vm="back"]'); }
        } else if (mode !== 'full') {
          for (const which of ['inspector', 'outliner', 'assets']) {
            if (await click(`[data-sheet-toggle="${which}"]`)) {
              await sleep(500);
              await snap(`${tag}-3-sheet-${which}`);
              console.log('LAYOUT', tag, which, JSON.stringify(await layoutProbe()));
              await click(`[data-sheet-toggle="${which}"]`);
              await sleep(300);
            }
          }
        }
      }
      await cdp.close();
      return;
    }

    for (const ws of ['layout', 'shade', 'scene', 'print']) {
      await evaluate(cdp, `(async () => {
        const { Workspace } = await import('/src/ui/Workspace.js');
        Workspace.setWorkspace('${ws}');
        if ('${ws}' === 'print') {
          // Export tab + scroll the cost card into view so the shot shows it.
          document.querySelector('#rp-print-body [data-tab="export"]')?.click();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          document.querySelector('.pp-cost-mode')?.scrollIntoView({ block: 'center' });
        }
      })()`);
      await sleep(400);
      if (process.env.PROBE) {
        const p = await evaluate(cdp, `(() => {
          const body = document.getElementById('rp-properties-body');
          const obj = body?.querySelector('[data-section="object"]');
          const row = obj?.querySelector('.pp-row');
          const name = obj?.querySelector('#pp-name');
          const r = (el) => el ? { d: getComputedStyle(el).display, h: el.offsetHeight, w: el.offsetWidth } : null;
          return {
            ws: document.body.dataset.workspace,
            body: r(body), obj: r(obj), row: r(row), name: r(name),
            bodyScrollH: body?.scrollHeight,
          };
        })()`);
        console.log('PROBE', JSON.stringify(p));
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT_DIR, `ui-${ws}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`wrote ${file}`);
    }
    await cdp.close();
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ── plumbing (mirrors tests/browser-smoke.mjs) ───────────────────────────

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`open target: ${res.status}`);
  return await res.json();
}

async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`vite timeout:\n${output.join('').slice(-2000)}`);
}

async function waitForWs(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('devtools timeout');
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

function findBrowser() {
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const candidates = [
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Google/Chrome/Application/chrome.exe'),
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const hit = candidates.find(p => p && existsSync(p));
  if (hit) return hit;
  for (const cmd of ['google-chrome', 'chrome', 'chromium', 'msedge']) {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'sh',
      process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) {
      const line = r.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (line) return line;
    }
  }
  return null;
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return cdp;
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result ?? {});
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); }, 30000);
      this.pending.set(id, {
        res: v => { clearTimeout(t); res(v); },
        rej: e => { clearTimeout(t); rej(e); },
      });
    });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(res => {
      this.ws.addEventListener('close', res, { once: true });
      this.ws.close();
      setTimeout(res, 1000);
    });
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* booting */ }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([once(killer, 'exit'), sleep(3000)]);
    } catch { try { child.kill(); } catch { /* gone */ } }
  } else {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  if (child.exitCode == null) await Promise.race([once(child, 'exit'), sleep(3000)]);
}

try {
  await main();
} catch (err) {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
