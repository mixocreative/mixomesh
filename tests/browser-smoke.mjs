import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, sleep, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
// CDP per-command timeout is 30 s (cdp-harness CDP_COMMAND_TIMEOUT_MS): the
// Rendering eval records a 1 s turntable (possibly twice — the mp4→WebM
// empty-result retry) on a SwiftShader render loop.

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
        // The import-error-modal check deliberately throws; safeImport logs it.
        const expected = /Babylon\.js/i.test(text) || /synthetic import failure/.test(text);
        if (type === 'error' && !expected) failures.push(`console ${type}: ${text}`);
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
      const alphaAt = async (blob, x = 2, y = 2) => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(x, y, 1, 1).data[3];
      };
      const tBlob = await ro.capturePng({ width: 64, height: 64, transparent: true });
      const oBlob = await ro.capturePng({ width: 64, height: 64, transparent: false });

      // Turntable EXPORT — the offline WebCodecs path works headless (it
      // never touches MediaRecorder, which wedges headless Chromium), so the
      // real encode is pinned right here: 1 s @ 10 fps, 320×180 mp4.
      const video = await ro.recordTurntable({
        durationS: 1, fps: 10, width: 320, height: 180,
        direction: 'left', ease: true,
      });
      const videoOk = !!video && video.ext === 'mp4' && video.blob.size > 1000;

      // Turntable PREVIEW (no MediaRecorder — headless-safe): with the target
      // PANNED off-origin, a 1 s sweep must be a RIGID rotation about the
      // world origin: (a) the camera MOVES on a circle around the origin —
      // |position| constant, displaced mid-sweep (the ArcRotate target SETTER
      // re-aims instead of moving, which froze the position; mutation is
      // required); (b) the target circles the origin at its starting radius —
      // |target| constant (a re-aim-at-axis bug would snap it to 0); and
      // (c) resolve 'done' restoring the whole rig.
      const sm = await import('/src/core/SceneManager.js');
      const cam = sm.SceneManager.getCamera();
      const keyLight = sm.SceneManager.getScene().getLightByName('key');
      cam.target.set(0.06, 0, 0.03);   // pan composition off-origin
      // position is derived NEXT frame — wait one before sampling baselines
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a0 = cam.alpha;
      const t0 = { x: cam.target.x, z: cam.target.z };
      const d0 = { x: keyLight.direction.x, z: keyLight.direction.z };
      const p0 = { x: cam.position.x, z: cam.position.z, len: cam.position.length() };
      const previewPromise = ro.previewTurntable({ durationS: 1, direction: 'left', ease: true });
      await new Promise(r => setTimeout(r, 450));
      const t0len = Math.hypot(t0.x, t0.z);
      const mid = {
        moved: Math.hypot(cam.position.x - p0.x, cam.position.z - p0.z) > 0.01,
        lenOk: Math.abs(cam.position.length() - p0.len) < 1e-3,
        // Rigid rotation: target circles the origin at its starting radius.
        // A re-aim bug snaps it to the axis (radius 0); a setter bug stops
        // the camera moving. Both are caught.
        targetOnCircle: Math.abs(Math.hypot(cam.target.x, cam.target.z) - t0len) < 1e-4,
        p0len: p0.len, midLen: cam.position.length(),
        alpha: cam.alpha, beta: cam.beta, radius: cam.radius,
        tx: cam.target.x, tz: cam.target.z, t0len,
      };
      const previewResult = await previewPromise;
      const rigRestored = Math.abs(cam.alpha - a0) < 1e-6
        && Math.abs(cam.target.x - t0.x) < 1e-6 && Math.abs(cam.target.z - t0.z) < 1e-6
        && Math.abs(keyLight.direction.x - d0.x) < 1e-6
        && Math.abs(keyLight.direction.z - d0.z) < 1e-6;
      cam.target.set(0, 0, 0);   // undo the pan for later checks

      // HDRI sweep sign — with a mirror sphere at the origin and HDRI
      // lighting on, the turntable must keep lighting FIXED RELATIVE TO THE
      // CAMERA: a mid-sweep capture matches the baseline, while rotating the
      // camera alone (negative control — env left in place) does not.
      const B = window.BABYLON;
      sm.SceneManager.applyRenderSettings({ hdriEnabled: true, hdriPreset: 'studio', hdriIntensity: 1 });
      const sc = sm.SceneManager.getScene();
      for (let i = 0; i < 100 && !sc.environmentTexture?.isReady?.(); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const probe = B.MeshBuilder.CreateSphere('hdri-probe', { diameter: 0.12, segments: 32 }, sc);
      const probeMat = new B.PBRMaterial('hdri-probe-mat', sc);
      probeMat.metallic = 1;
      probeMat.roughness = 0.08;
      probe.material = probeMat;
      cam.target.set(0, 0, 0);
      cam.alpha = Math.PI / 3; cam.beta = Math.PI / 3; cam.radius = 0.4;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const grab = async () => {
        const blob = await ro.capturePng({ width: 96, height: 96 });
        const bmp = await createImageBitmap(blob);
        const c2 = new OffscreenCanvas(96, 96);
        const cx = c2.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        return cx.getImageData(0, 0, 96, 96).data;
      };
      const meanDiff = (a, b) => {
        let sum = 0;
        for (let i = 0; i < a.length; i += 4) {
          sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        }
        return sum / (a.length / 4);
      };
      const basePix = await grab();
      cam.alpha += Math.PI / 2;   // negative control: camera alone
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const ctrlPix = await grab();
      cam.alpha -= Math.PI / 2;
      const sweepPromise = ro.previewTurntable({ durationS: 2, direction: 'left', ease: false });
      await new Promise(r => setTimeout(r, 500));   // ~90° into the sweep
      const sweepPix = await grab();
      await sweepPromise;
      const hdri = { sweepDiff: meanDiff(basePix, sweepPix), ctrlDiff: meanDiff(basePix, ctrlPix) };
      probe.dispose();
      probeMat.dispose();

      // Environment floor: enabling creates the shadow-catcher plane with the
      // requested colour + height (0.05 mm anti-z-fight offset below).
      sm.SceneManager.applyRenderSettings({ floorEnabled: true, floorColor: '#ff0000', floorZMM: 10 });
      const scene = sm.SceneManager.getScene();
      const floor = scene.getMeshByName('mx-env-floor');
      const floorOk = !!floor && floor.isEnabled()
        && Math.abs(floor.position.y - 0.00995) < 1e-6
        && floor.material?.diffuseColor?.r === 1 && floor.material?.diffuseColor?.g === 0;

      // Round disc + diameter: floorDiameterMM=500 ⇒ unit-disc scale 0.5;
      // 0 ⇒ AUTO (4× bed, ≫ 0.5). Disc geometry has many verts (vs ground's 4).
      sm.SceneManager.applyRenderSettings({ floorDiameterMM: 500 });
      const floorDiaScaled = Math.abs(floor.scaling.x - 0.5) < 1e-6;
      sm.SceneManager.applyRenderSettings({ floorDiameterMM: 0 });
      const floorAutoScaled = floor.scaling.x > 0.5;
      const floorIsDisc = (floor.getTotalVertices?.() ?? 0) > 8;

      // Transparent PNG with the floor ON: the capture swaps it to a
      // shadow-catcher, so a no-shadow pixel must STAY alpha 0 (an opaque
      // colour floor would read 255), and the swap must restore after.
      sm.SceneManager.applyRenderSettings({ floorEnabled: true, floorZMM: 0 });
      const ftBlob = await ro.capturePng({ width: 64, height: 64, transparent: true });
      // Sample the lower frame, where the (huge) floor plane definitely sits
      // in view — the top corner is sky and would pass even with the bug.
      const floorTransparentAlpha = await alphaAt(ftBlob, 32, 60);
      const floorMatRestored = floor.material?.name === 'mx-env-floor-mat';
      sm.SceneManager.applyRenderSettings({ floorEnabled: false });
      const floorHidden = !floor.isEnabled();

      ws.setWorkspace('layout');
      return {
        hasControls, frameShown, frameHidden,
        tSize: tBlob.size, tType: tBlob.type, tAlpha: await alphaAt(tBlob),
        oAlpha: await alphaAt(oBlob),
        videoOk, videoBytes: video?.blob?.size ?? 0,
        floorOk, floorHidden, floorTransparentAlpha, floorMatRestored,
        floorDiaScaled, floorAutoScaled, floorIsDisc,
        crosshair, previewResult, rigRestored, mid, hdri,
      };
    })()`);
    // Surface page exceptions BEFORE pixel asserts — a handler that threw
    // makes downstream asserts fail with misleading messages.
    if (failures.length) throw new Error(`Browser smoke found runtime errors:\n${failures.join('\n')}`);
    assert(rendering.hasControls, 'Scene ▸ Rendering controls missing');
    assert(rendering.frameShown, 'render-view toggle did not show the frame overlay');
    assert(rendering.frameHidden, 'render-view toggle did not hide the frame overlay');
    assert(rendering.tSize > 100 && rendering.tType === 'image/png', 'transparent capturePng did not return a PNG blob');
    assert(rendering.tAlpha === 0, `transparent capture should have alpha 0, got ${rendering.tAlpha}`);
    assert(rendering.oAlpha === 255, `opaque capture should have alpha 255, got ${rendering.oAlpha}`);
    assert(rendering.videoOk, `offline turntable mp4 failed (${rendering.videoBytes} bytes)`);
    assert(rendering.floorOk, 'environment floor not created with colour + height');
    assert(rendering.floorIsDisc, 'environment floor is not a round disc (too few verts)');
    assert(rendering.floorDiaScaled, 'floorDiameterMM=500 did not scale the disc to 0.5 BU');
    assert(rendering.floorAutoScaled, 'floorDiameterMM=0 did not restore the auto (4× bed) size');
    // 0 where unshadowed, partial in a shadow — an opaque colour floor reads
    // exactly 255, which is the regression this guards against.
    assert(rendering.floorTransparentAlpha < 255,
      `transparent PNG with floor on rendered an opaque floor (alpha ${rendering.floorTransparentAlpha}) — shadow-only swap missing`);
    assert(rendering.floorMatRestored, 'floor material not restored after transparent capture');
    assert(rendering.floorHidden, 'environment floor did not disable');
    assert(rendering.crosshair, 'render-frame crosshair missing');
    assert(rendering.previewResult === 'done', `turntable preview should resolve done, got ${rendering.previewResult}`);
    assert(rendering.rigRestored, 'turntable preview did not restore camera + key light');
    assert(rendering.mid.moved, 'mid-sweep camera position did not move — target setter re-aim bug');
    assert(rendering.mid.lenOk,
      `mid-sweep camera left the origin circle — sweep is not a world-origin rotation: ${JSON.stringify(rendering.mid)}`);
    assert(rendering.mid.targetOnCircle,
      `mid-sweep target left its origin circle — re-aim or pan crept in: ${JSON.stringify(rendering.mid)}`);
    assert(rendering.hdri.ctrlDiff > 4,
      `HDRI probe insensitive — camera-only rotation barely changed the sphere: ${JSON.stringify(rendering.hdri)}`);
    assert(rendering.hdri.sweepDiff < rendering.hdri.ctrlDiff * 0.4,
      `HDRI rotated against the camera during the sweep (wrong rotationY sign?): ${JSON.stringify(rendering.hdri)}`);

    // 2026-06-13 wave: offline frame source, section plane, bounce-in,
    // RENDERONCE shadows with a real caster, SSAO toggle, project-switch
    // recording abort.
    const wave = await evaluate(cdp, `(async () => {
      const ro = await import('/src/core/RenderOutput.js');
      const sm = await import('/src/core/SceneManager.js');
      const fx = await import('/src/core/scene/ViewEffects.js');
      const st = await import('/src/core/StateManager.js');
      const ev = await import('/src/core/events.js');
      const B = window.BABYLON;
      const scene = sm.SceneManager.getScene();
      const cam = sm.SceneManager.getCamera();
      cam.target.set(0, 0, 0);
      cam.alpha = Math.PI / 3; cam.beta = Math.PI / 4; cam.radius = 0.4243;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // (1) Offline encoder frame source — raw RGBA must be real pixels
      // (gradient backdrop ⇒ variance), top-down, opaque. An all-black or
      // all-one-colour buffer means the manual RTT render path broke (an
      // mp4 of black frames still has plausible bytes — this catches it).
      const px = await ro.captureFrameRGBA({ width: 64, height: 64 });
      const distinct = new Set();
      for (let i = 0; i < px.length; i += 4) distinct.add((px[i] << 16) | (px[i+1] << 8) | px[i+2]);
      const frameSrc = {
        len: px.length, lenOk: px.length === 64 * 64 * 4,
        distinct: distinct.size, alphaOk: px[3] === 255,
      };

      // (2) Section plane — box fully ABOVE z=0: no cut ⇒ visible (alpha 255
      // at centre of a transparent capture), cut at offset 0 keeping below ⇒
      // gone (alpha 0), flip ⇒ visible again. Pins the plane sign convention
      // empirically, like the HDRI probe pinned rotationY.
      const alphaAt = async (blob, x = 32, y = 32) => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = c.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        return cx.getImageData(x, y, 1, 1).data[3];
      };
      const secBox = B.MeshBuilder.CreateBox('smoke-sec', { size: 0.1 }, scene);
      secBox.position.set(0, 0.06, 0);
      secBox.metadata = { meshId: 'smoke-sec' };
      sm.SceneManager.setSectionPlane({ enabled: false });
      fx.registerSectionMeshes();
      const aNoCut = await alphaAt(await ro.capturePng({ width: 64, height: 64, transparent: true }));
      sm.SceneManager.setSectionPlane({ enabled: true, axis: 'z', offsetMM: 0, flip: false });
      // Striped indicator plane exists while the cut is on (viewport aid;
      // RenderOutput hides it during capture, so it must NOT affect aCut).
      // Back-face FILL clone + cut-plane BORDER accompany the cut while on.
      const hasFill = () => scene.meshes.some(m => m.name.startsWith('mx-section-cap-'));
      const vizWhenOn = hasFill();
      const borderWhenOn = !!scene.getMeshByName('mx-section-border');
      const aCut = await alphaAt(await ro.capturePng({ width: 64, height: 64, transparent: true }));
      sm.SceneManager.setSectionPlane({ enabled: true, axis: 'z', offsetMM: 0, flip: true });
      const aFlip = await alphaAt(await ro.capturePng({ width: 64, height: 64, transparent: true }));
      sm.SceneManager.setSectionPlane({ enabled: false });
      const vizWhenOff = hasFill();
      const borderWhenOff = !!scene.getMeshByName('mx-section-border');
      // Offset-slider range = content extent along the axis (lowest..highest).
      const ext = sm.SceneManager.getSectionExtentMM('z');
      const extentOk = ext.hasContent && ext.maxMM > ext.minMM;
      const section = { aNoCut, aCut, aFlip, vizWhenOn, vizWhenOff, borderWhenOn, borderWhenOff, extentOk };

      // (3) Bounce-in — ASSET_INSTANTIATED scale-pops the mesh and MUST land
      // exactly back on the original scaling (state transforms untouched).
      const bBox = B.MeshBuilder.CreateBox('smoke-bounce', { size: 0.05 }, scene);
      bBox.position.set(0.1, 0.025, 0);
      bBox.metadata = { meshId: 'smoke-bounce' };
      bBox.scaling.set(2, 2, 2);
      st.dispatch(ev.EVENTS.ASSET_INSTANTIATED, { meshId: 'smoke-bounce' });
      await new Promise(r => setTimeout(r, 80));
      const midScale = bBox.scaling.x;
      await new Promise(r => setTimeout(r, 600));
      const bounce = {
        midScale, animated: midScale > 0.5 && midScale < 1.999,
        landedExact: bBox.scaling.x === 2 && bBox.scaling.y === 2 && bBox.scaling.z === 2,
      };

      // (4) RENDERONCE shadows with a real caster (the bounce box is now a
      // registered caster): a transparent capture with the floor on must
      // contain SOFT shadow pixels (alpha strictly between 0 and 255 — the
      // blurred ESM edge). Broken/stale shadow map ⇒ only 0s and 255s.
      sm.SceneManager.applyRenderSettings({ floorEnabled: true, floorZMM: 0, shadowsEnabled: true });
      const shBlob = await ro.capturePng({ width: 96, height: 96, transparent: true });
      const bmp = await createImageBitmap(shBlob);
      const c = new OffscreenCanvas(96, 96);
      const cx = c.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const data = cx.getImageData(0, 0, 96, 96).data;
      let soft = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8 && data[i] < 247) soft++;
      }
      sm.SceneManager.applyRenderSettings({ floorEnabled: false });
      const shadows = { soft, ok: soft > 10 };

      // (5) SSAO toggle — pipeline detaches/disposes cleanly. SwiftShader
      // may not support SSAO2; tolerated (isSsaoActive stays false), but a
      // toggle that LEAVES the pipeline attached after disable always fails.
      sm.SceneManager.applyRenderSettings({ ssaoEnabled: true, ssaoStrength: 1 });
      const ssaoOn = fx.isSsaoActive();
      sm.SceneManager.applyRenderSettings({ ssaoEnabled: false });
      const ssaoOffOk = !fx.isSsaoActive();
      sm.SceneManager.applyRenderSettings({ ssaoEnabled: true });

      // (6) Project switch aborts an in-flight recording (and frees the
      // busy flag) instead of encoding a dead scene for 30 s.
      const recP = ro.recordTurntable({ durationS: 5, fps: 10, width: 160, height: 96 });
      await new Promise(r => setTimeout(r, 300));
      st.dispatch(ev.EVENTS.PROJECT_NEW, {});
      const recAborted = await Promise.race([
        recP.then(v => v === null),
        new Promise(r => setTimeout(() => r('timeout'), 8000)),
      ]);
      const recIdle = !ro.isRecording();

      // (7) Selection-outline gating (perf 2026-06-13): the mask RTT + 64-tap
      // outline pass must be DETACHED when nothing is selected (per-frame cost
      // for zero benefit) and re-attached when a mesh is selected.
      const maskInRT = () => scene.customRenderTargets.some(t => t.name === 'mx-sel-mask-rt');
      sm.SceneManager.setActive(null);
      await new Promise(r => requestAnimationFrame(r));
      const outlineOffWhenEmpty = !maskInRT();
      sm.SceneManager.setActive(bBox);
      await new Promise(r => requestAnimationFrame(r));
      const outlineOnWhenSelected = maskInRT();
      sm.SceneManager.setActive(null);

      secBox.dispose();
      bBox.dispose();
      return { frameSrc, section, bounce, shadows, ssaoOn, ssaoOffOk, recAborted, recIdle,
               outlineOffWhenEmpty, outlineOnWhenSelected };
    })()`);
    assert(wave.outlineOffWhenEmpty, 'selection-outline mask RTT not detached when selection is empty (per-frame waste)');
    assert(wave.outlineOnWhenSelected, 'selection-outline mask RTT not re-attached when a mesh is selected');
    assert(wave.frameSrc.lenOk, `captureFrameRGBA wrong length: ${wave.frameSrc.len}`);
    assert(wave.frameSrc.distinct > 16,
      `offline frame source nearly uniform (${wave.frameSrc.distinct} colours) — manual RTT render broke`);
    assert(wave.frameSrc.alphaOk, 'offline frame source not opaque with background on');
    assert(wave.section.aNoCut === 255, `section box invisible before cut (alpha ${wave.section.aNoCut})`);
    assert(wave.section.aCut === 0,
      `section plane did not cut the box (alpha ${wave.section.aCut}) — clip sign convention broke`);
    assert(wave.section.aFlip === 255, `section flip did not keep the other side (alpha ${wave.section.aFlip})`);
    assert(wave.section.vizWhenOn, 'cross-section back-face fill clone missing while cut is on');
    assert(!wave.section.vizWhenOff, 'cross-section fill clone not disposed when cut turned off');
    assert(wave.section.borderWhenOn, 'cut-plane border outline missing while cut is on');
    assert(!wave.section.borderWhenOff, 'cut-plane border outline not disposed when cut turned off');
    assert(wave.section.extentOk, 'getSectionExtentMM did not return a valid content extent for the offset slider');
    assert(wave.bounce.animated,
      `bounce-in not animating (mid scale ${wave.bounce.midScale})`);
    assert(wave.bounce.landedExact, 'bounce-in did not restore the exact original scaling');
    assert(wave.shadows.ok,
      `no soft shadow pixels with a caster + floor (${wave.shadows.soft}) — RENDERONCE shadow map stale or casters broken`);
    assert(wave.ssaoOffOk, 'SSAO pipeline still active after toggle off');
    assert(wave.recAborted === true, `project switch did not abort the recording (${wave.recAborted})`);
    assert(wave.recIdle, 'isRecording stuck true after project-switch abort');
    console.log(`  ssao: ${wave.ssaoOn ? 'active' : 'unsupported on this GPU (tolerated)'}`);

    // Import error handling: a failed import surfaces the detail MODAL (filename
    // + message + collapsible technical details), not a transient toast, and the
    // modal dismisses cleanly.
    const importErr = await evaluate(cdp, `(async () => {
      const ie = await import('/src/ui/ImportError.js');
      await ie.safeImport(async () => { throw new Error('synthetic import failure: corrupt mesh'); }, 'broken.glb');
      const modal = document.querySelector('#modal-root .import-error');
      const text = modal?.textContent ?? '';
      const result = {
        shown: !!modal,
        hasFilename: /broken\\.glb/.test(text),
        hasMessage: /synthetic import failure/.test(text),
        hasDetails: !!modal?.querySelector('details pre'),
      };
      modal?.querySelector('[data-action="close"]')?.click();
      result.closed = !document.querySelector('#modal-root .import-error');
      return result;
    })()`);
    assert(importErr.shown, 'import failure did not open the import-error modal');
    assert(importErr.hasFilename, 'import-error modal missing the filename');
    assert(importErr.hasMessage, 'import-error modal missing the error message');
    assert(importErr.hasDetails, 'import-error modal missing the technical details block');
    assert(importErr.closed, 'import-error modal did not close on Close');

    if (failures.length) throw new Error(`Browser smoke found runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log('PASS Vite browser smoke');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

try {
  await main();
} catch (err) {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
