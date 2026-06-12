import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
// 30 s: the Rendering eval records a 1 s turntable (possibly twice — the
// mp4→WebM empty-result retry) on a SwiftShader render loop.
const CDP_COMMAND_TIMEOUT_MS = 30000;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('Chrome/Edge executable not found. Install Chrome or Edge to run browser smoke.');
  }
  if (!existsSync(VITE_BIN)) {
    throw new Error('Vite executable not found. Run dependency install before browser smoke.');
  }

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-smoke-'));

  const vite = spawn(process.execPath, [
    VITE_BIN,
    '--host', '127.0.0.1',
    '--port', String(appPort),
    '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', chunk => viteOutput.push(String(chunk)));
  vite.stderr.on('data', chunk => viteOutput.push(String(chunk)));

  const browser = spawn(browserPath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--enable-experimental-web-platform-features',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', chunk => browserStderr.push(String(chunk)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);

    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];

    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args = [] } = msg.params;
        const text = args.map(a => a.value ?? a.description ?? '').join(' ');
        if (type === 'error' && !/Babylon\.js/i.test(text)) failures.push(`console ${type}: ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text
          ?? 'unknown exception'}`);
      }
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error' && !/favicon|Babylon\.js/i.test(e.text)) {
          failures.push(`log error: ${e.text} ${e.url ?? ''}`.trim());
        }
      }
      if (msg.method === 'Inspector.targetCrashed') failures.push('target crashed');
    };

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && document.querySelector('#boot-status') === null
    `), 30000, 'boot completion');
    await waitFor(() => evaluate(cdp, `
      !!window.BABYLON?.Engine
      && !!window.BABYLON?.GridMaterial
      && !!window.BABYLON?.OBJExport
      && !!window.BABYLON?.SceneLoader
    `), 30000, 'local Babylon namespace');
    await waitFor(() => evaluate(cdp, `
      !!document.querySelector('#renderCanvas')
      && !!document.querySelector('.pm-bar')
      && !!document.querySelector('#ol-list')
      && !!document.querySelector('#ap-grid')
      && !!document.querySelector('#rp-print-body')
      && !!document.querySelector('#status-bar')
    `), 30000, 'main UI');

    const snapshot = await evaluate(cdp, `(() => {
      const splitter = document.querySelector('[data-rp-splitter]');
      const firstToggle = document.querySelector('.rp-section-header');
      const before = firstToggle?.getAttribute('aria-expanded');
      firstToggle?.click();
      const collapsed = firstToggle?.getAttribute('aria-expanded');
      firstToggle?.click();
      splitter?.focus();
      const splitBefore = splitter?.getAttribute('aria-valuenow');
      splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const splitAfter = splitter?.getAttribute('aria-valuenow');
      return {
        title: document.title,
        babylon: {
          Engine: !!window.BABYLON?.Engine,
          GridMaterial: !!window.BABYLON?.GridMaterial,
          OBJExport: !!window.BABYLON?.OBJExport,
          SceneLoader: !!window.BABYLON?.SceneLoader,
        },
        canvas: !!document.querySelector('#renderCanvas'),
        toolbar: !!document.querySelector('.pm-bar'),
        outliner: !!document.querySelector('#ol-list'),
        assetGrid: !!document.querySelector('#ap-grid'),
        toastRoot: !!document.querySelector('#toast-container[aria-live]'),
        modalRoot: !!document.querySelector('#modal-root'),
        progressRoot: !!document.querySelector('#progress-root'),
        rightToggles: document.querySelectorAll('.rp-section-header[aria-expanded]').length,
        wsAttr: document.body.dataset.workspace,
        wsButtons: document.querySelectorAll('.ws-switcher .ws-btn').length,
        wsActive: document.querySelector('.ws-switcher .ws-btn.active')?.dataset.ws,
        before,
        collapsed,
        restored: firstToggle?.getAttribute('aria-expanded'),
        splitBefore,
        splitAfter,
      };
    })()`);

    assert(snapshot.title === 'MIXOMESH', 'document title missing');
    assert(snapshot.babylon.Engine, 'BABYLON.Engine missing');
    assert(snapshot.babylon.GridMaterial, 'BABYLON.GridMaterial missing');
    assert(snapshot.babylon.OBJExport, 'BABYLON.OBJExport missing');
    assert(snapshot.babylon.SceneLoader, 'BABYLON.SceneLoader missing');
    assert(snapshot.canvas, 'canvas missing');
    assert(snapshot.toolbar, 'project toolbar missing');
    assert(snapshot.outliner, 'outliner list missing');
    assert(snapshot.assetGrid, 'asset grid missing');
    assert(snapshot.toastRoot, 'toast root missing');
    assert(snapshot.modalRoot, 'modal root missing');
    assert(snapshot.progressRoot, 'progress root missing');
    assert(snapshot.rightToggles >= 3, 'right-panel toggles missing aria-expanded');
    assert(snapshot.wsAttr === 'layout', `body[data-workspace] should default to layout, got ${snapshot.wsAttr}`);
    assert(snapshot.wsButtons === 4, 'workspace switcher pill missing its four buttons (Layout/Shade/Scene/Print)');
    assert(snapshot.wsActive === 'layout', 'Layout pill button should be active by default');
    assert(snapshot.before === 'true' && snapshot.collapsed === 'false' && snapshot.restored === 'true',
      'right-panel toggle did not update aria-expanded');
    assert(snapshot.splitBefore !== snapshot.splitAfter,
      'right splitter keyboard resize did not change aria-valuenow');

    // Scene ▸ Rendering: UI present, render-view frame overlay toggles, and
    // capturePng produces a real PNG (transparent variant has alpha 0 on an
    // empty scene; opaque variant has the backdrop at alpha 255).
    const rendering = await evaluate(cdp, `(async () => {
      const ws = await import('/src/ui/Workspace.js');
      ws.setWorkspace('scene');
      const body = document.querySelector('#rp-scene-body');
      const hasControls = !!body?.querySelector('[data-action="export-png"]')
        && !!body?.querySelector('[data-action="export-video"]')
        && !!body?.querySelector('[data-render-select="toneMapping"]')
        && !!body?.querySelector('[data-ro="width"]');

      const rv = body?.querySelector('[data-action="render-view"]');
      rv?.click();
      const frameEl = document.querySelector('.render-frame');
      const frameShown = !!frameEl && frameEl.style.display !== 'none'
        && frameEl.getBoundingClientRect().width > 10;
      const crosshair = !!frameEl?.querySelector('.render-frame-cross');
      rv?.click();
      const frameHidden = !frameEl || frameEl.style.display === 'none';

      const ro = await import('/src/core/RenderOutput.js');
      const alphaAt = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(2, 2, 1, 1).data[3];
      };
      const tBlob = await ro.capturePng({ width: 64, height: 64, transparent: true });
      const oBlob = await ro.capturePng({ width: 64, height: 64, transparent: false });

      // Turntable: NOT functionally recorded here — realtime MediaRecorder
      // encode of the SwiftShader WebGL canvas wedges the headless renderer
      // (main thread blocks; even timers stop). Machinery is pinned by the
      // RenderMath unit tests + this shape check; the actual encode is a
      // real-GPU/live-Chrome verification.
      const recordable = typeof ro.recordTurntable === 'function'
        && typeof MediaRecorder === 'function'
        && ['video/mp4;codecs=avc3.42E01E', 'video/webm;codecs=vp8', 'video/webm']
          .some(m => MediaRecorder.isTypeSupported(m));

      // Turntable PREVIEW (no MediaRecorder — headless-safe): 1 s sweep must
      // resolve 'done' and restore the whole rig (camera alpha/target + key
      // light direction).
      const sm = await import('/src/core/SceneManager.js');
      const cam = sm.SceneManager.getCamera();
      const keyLight = sm.SceneManager.getScene().getLightByName('key');
      const a0 = cam.alpha;
      const t0 = { x: cam.target.x, z: cam.target.z };
      const d0 = { x: keyLight.direction.x, z: keyLight.direction.z };
      const previewResult = await ro.previewTurntable({ durationS: 1, direction: 'left', ease: true });
      const rigRestored = Math.abs(cam.alpha - a0) < 1e-6
        && Math.abs(cam.target.x - t0.x) < 1e-6 && Math.abs(cam.target.z - t0.z) < 1e-6
        && Math.abs(keyLight.direction.x - d0.x) < 1e-6
        && Math.abs(keyLight.direction.z - d0.z) < 1e-6;

      // Environment floor: enabling creates the shadow-catcher plane with the
      // requested colour + height (0.05 mm anti-z-fight offset below).
      sm.SceneManager.applyRenderSettings({ floorEnabled: true, floorColor: '#ff0000', floorZMM: 10 });
      const scene = sm.SceneManager.getScene();
      const floor = scene.getMeshByName('mx-env-floor');
      const floorOk = !!floor && floor.isEnabled()
        && Math.abs(floor.position.y - 0.00995) < 1e-6
        && floor.material?.diffuseColor?.r === 1 && floor.material?.diffuseColor?.g === 0;
      sm.SceneManager.applyRenderSettings({ floorEnabled: false });
      const floorHidden = !floor.isEnabled();

      ws.setWorkspace('layout');
      return {
        hasControls, frameShown, frameHidden,
        tSize: tBlob.size, tType: tBlob.type, tAlpha: await alphaAt(tBlob),
        oAlpha: await alphaAt(oBlob),
        recordable, floorOk, floorHidden,
        crosshair, previewResult, rigRestored,
      };
    })()`);
    assert(rendering.hasControls, 'Scene ▸ Rendering controls missing');
    assert(rendering.frameShown, 'render-view toggle did not show the frame overlay');
    assert(rendering.frameHidden, 'render-view toggle did not hide the frame overlay');
    assert(rendering.tSize > 100 && rendering.tType === 'image/png', 'transparent capturePng did not return a PNG blob');
    assert(rendering.tAlpha === 0, `transparent capture should have alpha 0, got ${rendering.tAlpha}`);
    assert(rendering.oAlpha === 255, `opaque capture should have alpha 255, got ${rendering.oAlpha}`);
    assert(rendering.recordable, 'turntable machinery unavailable (recordTurntable / MediaRecorder)');
    assert(rendering.floorOk, 'environment floor not created with colour + height');
    assert(rendering.floorHidden, 'environment floor did not disable');
    assert(rendering.crosshair, 'render-frame crosshair missing');
    assert(rendering.previewResult === 'done', `turntable preview should resolve done, got ${rendering.previewResult}`);
    assert(rendering.rigRestored, 'turntable preview did not restore camera + key light');

    if (failures.length) throw new Error(`Browser smoke found runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log('PASS Vite browser smoke');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`Failed to open browser target: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Vite may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Vite app:\n${output.join('').slice(-2000)}`);
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
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const absoluteCandidates = [
    join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    local ? join(local, 'Microsoft/Edge/Application/msedge.exe') : '',
  ];
  const absoluteMatch = absoluteCandidates.find(p => p && existsSync(p));
  if (absoluteMatch) return absoluteMatch;

  for (const command of ['google-chrome', 'chrome', 'chromium', 'msedge']) {
    const resolved = resolveCommand(command);
    if (resolved) return resolved;
  }
  return null;
}

function resolveCommand(command) {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args = process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`];
  const result = spawnSync(resolver, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
}

async function waitForBrowserWs(port, stderr) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint:\n${stderr.join('').slice(-2000)}`);
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', rejectOpen, { once: true });
    });
    return cdp;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: resolvePending, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolvePending(msg.result ?? {});
      } else {
        this.onEvent?.(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePending, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePending(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolveClose => {
      this.ws.addEventListener('close', resolveClose, { once: true });
      this.ws.close();
      setTimeout(resolveClose, 1000);
    });
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      // The page may still be navigating.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeTempDir(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([once(killer, 'exit'), sleep(3000)]);
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  if (child.exitCode == null) await Promise.race([once(child, 'exit'), sleep(3000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

try {
  await main();
} catch (err) {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
