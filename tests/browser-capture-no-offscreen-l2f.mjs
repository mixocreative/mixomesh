// L2-10: WebKit builds without OffscreenCanvas threw an unhandled
// ReferenceError inside Babylon's screenshot helper; the asset thumbnail never
// settled, held the render lock, and every later capture (the 3MF thumbnail)
// timed out. With OffscreenCanvas removed, an import gets its thumbnail and a
// capture still returns a PNG.
//   node tests/browser-capture-no-offscreen-l2f.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#ol-list')`;
const CAPTURE = `(async () => {
  delete globalThis.OffscreenCanvas;
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const { getState } = await import('/src/core/StateManager.js');
  await AssetLoader.loadFromBlob(await (await fetch('/tests/fixtures/textured-quad.glb')).blob(), 'textured-quad.glb');
  const t0 = performance.now();
  while (!Object.values(getState().scene.assetLibrary).some(a => a.kind === 'mesh' && a.thumbnailDataUrl) && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
  const thumb = Object.values(getState().scene.assetLibrary).find(a => a.kind === 'mesh')?.thumbnailDataUrl ?? null;
  const { capturePng } = await import('/src/core/render/FrameCapture.js');
  try {
    const blob = await Promise.race([capturePng({ width: 64, height: 48 }), new Promise((_, no) => setTimeout(() => no(new Error('capture never settled')), 10000))]);
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const bmp = await createImageBitmap(blob);
    return JSON.stringify({ type: blob.type, size: blob.size, png: head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47, w: bmp.width, h: bmp.height, thumb: String(thumb).slice(0, 22) });
  } catch (err) { return JSON.stringify({ error: String(err) }); }
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-cap-'));
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

    const out = JSON.parse(await evaluate(cdp, CAPTURE));
    assert.equal(out.error, undefined, `capture without OffscreenCanvas: ${out.error}`);
    assert.ok(out.png && out.w === 64 && out.h === 48, `a 64x48 PNG (${JSON.stringify(out)})`);
    assert.equal(out.thumb, 'data:image/png;base64,', 'the imported asset got its thumbnail');
    console.log(`PASS browser-capture-no-offscreen-l2f (${out.w}x${out.h} PNG, ${out.size} bytes)`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
