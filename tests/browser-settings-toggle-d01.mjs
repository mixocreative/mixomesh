// cia D-01: per-user settings changed through toggle BUTTONS (and the viewport
// strip) must reach localStorage and survive a reload. Drives real clicks; never
// calls SettingsStore.save().
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#rp-scene-body [data-overlay="grid"]')`;

const READ = `(async () => {
  const sm = await import('/src/core/StateManager.js');
  const s = sm.getState();
  const raw = localStorage.getItem('mx-settings-v1');
  const st = raw ? JSON.parse(raw).settings : {};
  return JSON.stringify({
    live: {
      grid: s.scene.overlays.grid, axes: s.scene.overlays.axes, printPreview: s.scene.overlays.printPreview,
      shadows: s.scene.render.shadowsEnabled, vignette: s.scene.render.vignette,
      transparent: s.scene.renderOut.transparent, ease: s.scene.renderOut.turntable.ease,
    },
    stored: {
      grid: st.overlays?.grid, axes: st.overlays?.axes, printPreview: st.overlays?.printPreview,
      shadows: st.render?.shadowsEnabled, vignette: st.render?.vignette,
      transparent: st.renderOut?.transparent, ease: st.renderOut?.turntable?.ease,
    },
    hasBlob: !!raw,
  });
})()`;

const CLICKS = {
  grid: `document.querySelector('#rp-scene-body [data-overlay="grid"]')`,
  axes: `document.querySelector('#viewport-toggles [data-feature="axes"]')`,
  shadows: `document.querySelector('#rp-scene-body [data-render-toggle="shadowsEnabled"]')`,
  vignette: `document.querySelector('#rp-scene-body [data-render-toggle="vignette"]')`,
  transparent: `document.querySelector('#rp-scene-body [data-ro-toggle="transparent"]')`,
  ease: `document.querySelector('#rp-scene-body [data-tt-toggle="ease"]')`,
};

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-d01-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, BOOTED), 40000, 'boot');
    const read = async () => JSON.parse(await evaluate(cdp, READ));

    const reload = async () => {
      await evaluate(cdp, 'window.__beforeReload = true');
      await cdp.send('Page.reload', {});
      await waitFor(() => evaluate(cdp, `!window.__beforeReload && ${BOOTED}`), 40000, 'reload');
    };
    const MODE = { name: 'mode', live: 'printPreview' };
    const controls = [
      ...Object.entries(CLICKS).map(([name, sel]) => ({ name, live: name, click: `(() => { const el = ${sel}; if (!el) return false; el.click(); return true; })()` })),
      { name: MODE.name, live: MODE.live, click: `(() => { const sel = document.querySelector('#viewport-toggles .vt-mode'); sel.value = 'shaded'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()` },
    ];
    for (const c of controls) {
      await evaluate(cdp, `localStorage.removeItem('mx-settings-v1')`);
      await reload();
      const before = await read();
      assert.equal(before.hasBlob, false, `${c.name}: clean profile`);
      assert.ok(await evaluate(cdp, c.click), `${c.name}: control exists`);
      await sleep(700);
      const after = await read();
      assert.notEqual(after.live[c.live], before.live[c.live], `${c.name}: toggled in the live state`);
      assert.equal(after.stored[c.live], after.live[c.live], `${c.name}: a single click reached localStorage`);
      await reload();
      const reloaded = await read();
      assert.equal(reloaded.live[c.live], after.live[c.live], `${c.name}: survives a reload`);
    }
    console.log('browser-settings-toggle-d01: ok');
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
