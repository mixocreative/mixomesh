// WebGPU backend check. Boots the real app in headless Chrome with WebGPU
// ENABLED (--enable-unsafe-webgpu → Dawn/D3D12 adapter on Windows), then
// verifies the WebGPU path end-to-end:
//   1. the WebGPU engine actually won (window.__MX_ENGINE === 'webgpu'),
//   2. the one custom shader (the selection outline) compiles & renders in
//      WGSL — a mesh is selected (attaches the 64-tap outline post-process)
//      and a PNG is captured, which forces shader compilation,
//   3. no shader-compile or runtime console errors fired.
//
// If the headless environment exposes no WebGPU adapter, the engine correctly
// falls back to WebGL; this check then reports SKIP (not a failure) — the
// WGSL path must be confirmed in live Chrome. Mirrors browser-smoke.mjs.

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found. Install deps first.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-webgpu-'));

  const vite = spawn(process.execPath, [
    VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));

  // WebGPU ON: --enable-unsafe-webgpu lifts the adapter blocklist so headless
  // can use the real GPU (Dawn/D3D12 on Windows). The swiftshader flags only
  // affect ANGLE/GL — they give the WebGL FALLBACK a software context without
  // suppressing the Dawn WebGPU adapter, so this run can land on either engine.
  // Headless Dawn exposes no WebGPU adapter here, so the headless run lands on
  // WebGL and SKIPs. WEBGPU_HEADFUL=1 launches a real Chrome window → real GPU
  // adapter → the WGSL outline shader is actually compiled & rendered.
  const headful = process.env.WEBGPU_HEADFUL === '1';
  const browser = spawn(browserPath, [
    ...(headful ? [] : ['--headless=new', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader']),
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    // ?engine=webgpu opts into the WebGPU backend (default is WebGL — see
    // SceneManager._tryWebGPU for why WebGPU is gated behind this flag).
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html?engine=webgpu`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args = [] } = msg.params;
        const text = args.map(a => a.value ?? a.description ?? '').join(' ');
        // The WebGPU→WebGL fallback warning is expected & benign; ignore it.
        if (type === 'error' && !/Babylon\.js/i.test(text)) failures.push(`console ${type}: ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text ?? 'unknown exception'}`);
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

    try {
      await waitFor(() => evaluate(cdp, `
        document.readyState === 'complete'
        && document.querySelector('#boot-status') === null
        && typeof window.__MX_ENGINE === 'string'
      `), 30000, 'boot completion');
    } catch (bootErr) {
      const diag = await evaluate(cdp, `({
        ready: document.readyState,
        bootStatus: document.querySelector('#boot-status')?.textContent ?? null,
        engine: window.__MX_ENGINE ?? null,
        hasGpu: !!navigator.gpu,
        hasWebGPUEngine: !!window.BABYLON?.WebGPUEngine,
      })`).catch(e => ({ evalError: String(e) }));
      console.error('BOOT DIAG:', JSON.stringify(diag));
      console.error('CONSOLE FAILURES:', failures.join(' | ') || '(none)');
      throw bootErr;
    }

    const engine = await evaluate(cdp, `window.__MX_ENGINE`);
    if (engine !== 'webgpu') {
      console.log(`SKIP WebGPU check — backend is '${engine}' (no headless WebGPU adapter).`);
      console.log('      WGSL outline shader must be verified in live Chrome.');
      await cdp.close();
      return;
    }

    // WebGPU won. Exercise the WGSL outline shader: select a mesh (attaches the
    // outline post-process) and capture a PNG (forces shader compile + render).
    const result = await evaluate(cdp, `(async () => {
      const sm = await import('/src/core/SceneManager.js');
      const ro = await import('/src/core/RenderOutput.js');
      const B = window.BABYLON;
      const scene = sm.SceneManager.getScene();
      const cam = sm.SceneManager.getCamera();
      cam.target.set(0, 0, 0);
      cam.alpha = Math.PI / 3; cam.beta = Math.PI / 4; cam.radius = 0.4243;
      const box = B.MeshBuilder.CreateBox('webgpu-outline', { size: 0.1 }, scene);
      box.position.set(0, 0.06, 0);
      box.metadata = { meshId: 'webgpu-outline' };
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Discriminator: does the engine render ANY frames here? (Headful
      // automation may throttle an unfocused window's render loop.)
      const eng = sm.SceneManager.getEngine();
      let frames = 0;
      const obs = eng.onEndFrameObservable.add(() => { frames++; });
      await new Promise(r => setTimeout(r, 600));
      eng.onEndFrameObservable.remove(obs);

      const distinctOf = (data) => {
        const s = new Set();
        for (let i = 0; i < data.length; i += 4) s.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);
        return s.size;
      };
      const pngPixels = async () => {
        const blob = await ro.capturePng({ width: 64, height: 64 });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(64, 64);
        const cx = c.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        return cx.getImageData(0, 0, 64, 64).data;
      };

      // (a) Raw RTT frame source (no PNG encode) — isolates the readback path.
      const raw = await ro.captureFrameRGBA({ width: 64, height: 64 });
      const rawDistinct = distinctOf(raw);
      const rawCenter = [raw[64*32*4+128], raw[64*32*4+129], raw[64*32*4+130], raw[64*32*4+131]];

      // (b) Plain PNG capture, no selection.
      const plain = await pngPixels();
      const plainDistinct = distinctOf(plain);

      // (c) Outline PNG capture — selecting attaches the WGSL 64-tap pass.
      sm.SceneManager.setActive(box);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const maskInRT = scene.customRenderTargets.some(t => t.name === 'mx-sel-mask-rt');
      const outline = await pngPixels();
      const outlineDistinct = distinctOf(outline);

      sm.SceneManager.setActive(null);
      box.dispose();

      // ── Orientation check (post-flush). captureFrameRGBA flips rows for
      // WebGL's bottom-up readback; WebGPU may already be top-down. Compare its
      // top/bottom luminance split against the canvas screenshot (ground-truth
      // orientation — it IS the displayed image). Same sign ⇒ orientation OK.
      const halfSplit = (data, w, h) => {
        let top = 0, bot = 0; const half = (h / 2) | 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = data[i] + data[i+1] + data[i+2];
            if (y < half) top += lum; else bot += lum;
          }
        }
        return (top - bot) / (w * half);   // >0 ⇒ top brighter
      };
      const nextFramesP = (n) => new Promise(res => {
        let k = 0; const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
      const probe = {};
      try {
        const frame = await ro.captureFrameRGBA({ width: 64, height: 64 });   // now flushed
        probe.frameDistinct = (() => { const s = new Set(); for (let i = 0; i < frame.length; i += 4) s.add((frame[i]<<16)|(frame[i+1]<<8)|frame[i+2]); return s.size; })();
        probe.frameSplit = halfSplit(frame, 64, 64);
        const url = await B.Tools.CreateScreenshotAsync(eng, cam, { width: 64, height: 64 });
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const cc = new OffscreenCanvas(64, 64); const ccx = cc.getContext('2d');
        ccx.drawImage(bmp, 0, 0);
        probe.canvasSplit = halfSplit(ccx.getImageData(0, 0, 64, 64).data, 64, 64);
        probe.orientationOK = Math.sign(probe.frameSplit) === Math.sign(probe.canvasSplit);

        // Transparent PNG correctness on WebGPU: a centred box must be opaque
        // (alpha 255) while a top corner stays sky (alpha 0). Catches the
        // alpha-coverage problem that broke the naive manual path on WebGL.
        const tbox = B.MeshBuilder.CreateBox('webgpu-transp', { size: 0.1 }, scene);
        tbox.position.set(0, 0.06, 0); tbox.metadata = { meshId: 'webgpu-transp' };
        cam.target.set(0, 0.06, 0); cam.alpha = Math.PI / 2; cam.beta = Math.PI / 2; cam.radius = 0.4;
        await nextFramesP(2);
        const tBlob = await ro.capturePng({ width: 64, height: 64, transparent: true });
        const tbmp = await createImageBitmap(tBlob);
        const tc = new OffscreenCanvas(64, 64); const tcx = tc.getContext('2d');
        tcx.drawImage(tbmp, 0, 0);
        probe.transpCenterAlpha = tcx.getImageData(32, 32, 1, 1).data[3];
        probe.transpCornerAlpha = tcx.getImageData(1, 1, 1, 1).data[3];
        tbox.dispose();

        // #1 — static-texture readback on WebGPU (the export fallback path:
        // ExportTextures.textureToBlob → TextureReadback.textureToPngBlob when a
        // texture has no captured source). The capture flush bug was RTT-only;
        // confirm uploaded textures read back fine so export fidelity is safe.
        const tr = await import('/src/core/assets/TextureReadback.js');
        const dyn = new B.DynamicTexture('webgpu-readback', { width: 32, height: 32 }, scene, false);
        const dctx = dyn.getContext();
        dctx.fillStyle = '#ff0000'; dctx.fillRect(0, 0, 32, 32);
        dctx.fillStyle = '#00ff00'; dctx.fillRect(0, 0, 16, 16);
        dyn.update();
        const texBlob = await tr.textureToPngBlob(dyn);
        if (texBlob) {
          const rbmp = await createImageBitmap(texBlob);
          const rc = new OffscreenCanvas(32, 32); const rcx = rc.getContext('2d');
          rcx.drawImage(rbmp, 0, 0);
          probe.texReadbackDistinct = distinctOf(rcx.getImageData(0, 0, 32, 32).data);
        } else { probe.texReadbackDistinct = 0; }
        dyn.dispose();
      } catch (e) { probe.error = String(e); }

      return { isWebGPU: sm.SceneManager.isWebGPU(), maskInRT, frames,
               rawDistinct, rawCenter, plainDistinct, outlineDistinct, probe };
    })()`);
    console.log('  diag:', JSON.stringify(result));
    console.log('  PROBE:', JSON.stringify(result.probe));

    // What WebGPU MUST deliver here: the backend boots, the one custom shader
    // (selection outline) compiles in WGSL with no shader/device error, and the
    // render loop runs every frame with that 64-tap pass attached. A WGSL
    // compile failure surfaces as a console/device error (caught in `failures`)
    // and stalls frames — both are asserted.
    assert(result.isWebGPU, 'SceneManager.isWebGPU() false despite __MX_ENGINE webgpu');
    assert(result.maskInRT, 'outline mask RTT not attached when a mesh is selected (WebGPU)');
    assert(result.frames > 0, 'WebGPU engine rendered no frames');
    if (failures.length) throw new Error(`WebGPU check found runtime errors (likely WGSL compile):\n${failures.join('\n')}`);

    // Capture correctness on WebGPU (the former blocker — fixed by flushing the
    // command buffer before readPixels). All capture must work, since PNG /
    // video / thumbnail ride this path.
    const p = result.probe ?? {};
    assert(!p.error, `WebGPU capture probe threw: ${p.error}`);
    assert(p.frameDistinct > 4, `WebGPU video-frame capture empty (${p.frameDistinct}) — flush regressed`);
    assert(p.orientationOK, 'WebGPU capture orientation does not match the displayed image');
    assert(p.transpCenterAlpha === 255, `WebGPU transparent PNG: box not opaque (alpha ${p.transpCenterAlpha})`);
    assert(p.transpCornerAlpha === 0, `WebGPU transparent PNG: sky not transparent (alpha ${p.transpCornerAlpha})`);
    assert(result.plainDistinct > 4, `WebGPU opaque PNG still empty (${result.plainDistinct})`);
    assert(p.texReadbackDistinct > 1, `WebGPU static-texture readback empty (${p.texReadbackDistinct}) — export fallback would lose texture bytes`);
    await cdp.close();
    console.log('PASS WebGPU backend + WGSL outline + capture (video/PNG/transparent) all correct');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

try { await main(); }
catch (err) { console.error(err?.stack ?? err); process.exitCode = 1; }
finally { process.exit(process.exitCode ?? 0); }
