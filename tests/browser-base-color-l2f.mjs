// L2-14: the Base Color display mode, which shows the colour the printer will
// ink, read about 16% darker than the texture: the unlit albedo still went
// through the viewport's ACES tone map, contrast and exposure. In Base Color
// mode a face shows its texel colour.
//   node tests/browser-base-color-l2f.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FACE_COLOURS } from './fixtures/make-midtone-cube.mjs';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#ol-list')`;
const PROBE = `(async () => {
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const { SceneManager } = await import('/src/core/SceneManager.js');
  const { getState, setState } = await import('/src/core/StateManager.js');
  const blob = await (await fetch('/tests/fixtures/midtone-cube.glb')).blob();
  await AssetLoader.loadFromBlob(blob, 'midtone-cube.glb');
  const until = async (pred, ms = 30000) => { const t0 = performance.now(); while (!pred()) { if (performance.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)); } };
  await until(() => Object.values(getState().scene.assetLibrary).some(a => a.kind === 'texture' && AssetLoader.getBabylonTexture(a.id)?.isReady?.()));
  setState(s => ({ ...s, selection: { ...s.selection, selectedIds: [], activeId: null } }));
  setState(s => ({ ...s, scene: { ...s.scene, overlays: { ...s.scene.overlays, baseColorView: true, grid: false, axes: false } } }), { silent: true });
  SceneManager.setOverlay('baseColorView', true);
  for (const k of ['grid', 'axes']) SceneManager.setOverlay(k, false);
  const scene = SceneManager.getScene(); const engine = SceneManager.getEngine(); const cam = scene.activeCamera;
  const cube = scene.meshes.find(m => m.metadata?.meshId && m.getTotalVertices() > 0);
  cube.computeWorldMatrix(true);
  const c = cube.getBoundingInfo().boundingBox.centerWorld;
  cam.setTarget(c.clone()); cam.alpha = Math.PI / 2; cam.beta = Math.PI / 2; cam.radius = 0.08;
  await new Promise(r => setTimeout(r, 1500));
  scene.render();
  const w = engine.getRenderWidth(), h = engine.getRenderHeight();
  const px = await engine.readPixels(Math.floor(w / 2 + h * 0.06), Math.floor(h / 2 + h * 0.06), 1, 1);
  return JSON.stringify([...px].slice(0, 3));
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-base-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, BOOTED), 40000, 'boot');

    const px = JSON.parse(await evaluate(cdp, PROBE));
    const dist = c => Math.hypot(px[0] - c[0], px[1] - c[1], px[2] - c[2]);
    const face = FACE_COLOURS.reduce((a, b) => dist(a) <= dist(b) ? a : b);
    assert.ok(dist(face) <= 6, `Base Color pixel ${JSON.stringify(px)} matches the face texel ${JSON.stringify(face)} (distance ${dist(face).toFixed(1)})`);
    console.log(`PASS browser-base-color-l2f (pixel ${JSON.stringify(px)} vs texel ${JSON.stringify(face)}, distance ${dist(face).toFixed(1)})`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
