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
        nPanel: {
          mounted: !!document.querySelector('#n-panel .np-body')
            && !!document.querySelector('#n-panel input[data-axis="x"]'),
          noSnapActions: [
            'selection-to-cursor',
            'cursor-to-selection',
            'cursor-to-origin',
          ].every(a => !document.querySelector('#n-panel [data-act="' + a + '"]')),
        },
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
    assert(snapshot.nPanel.mounted, '3D-cursor N-panel (with XYZ inputs) not mounted into the viewport');
    assert(snapshot.nPanel.noSnapActions, '3D-cursor N-panel should not contain cursor snap action buttons');
    assert(snapshot.before === 'true' && snapshot.collapsed === 'false' && snapshot.restored === 'true',
      'right-panel toggle did not update aria-expanded');
    assert(snapshot.splitBefore !== snapshot.splitAfter,
      'right splitter keyboard resize did not change aria-valuenow');

    const localeSwitch = await evaluate(cdp, `(async () => {
      const { setLocale } = await import('/src/i18n/index.js');
      const { dispatch } = await import('/src/core/StateManager.js');
      const { EVENTS } = await import('/src/core/events.js');
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      setLocale('en');
      dispatch(EVENTS.SETTINGS_RESET, { section: 'print' });
      dispatch(EVENTS.WORKSPACE_CHANGED, { workspace: 'layout' });
      await frame();
      const before = {
        printTabs: [...document.querySelectorAll('#rp-print-body .pp-tab')]
          .map(el => el.textContent.trim()),
        propertiesEmpty: document.querySelector('#rp-properties-body .pp-empty')?.textContent.trim() ?? '',
      };
      setLocale('zh-Hant');
      await frame();
      const after = {
        lang: document.documentElement.lang,
        printTabs: [...document.querySelectorAll('#rp-print-body .pp-tab')]
          .map(el => el.textContent.trim()),
        propertiesEmpty: document.querySelector('#rp-properties-body .pp-empty')?.textContent.trim() ?? '',
        shaderEmpty: [...document.querySelectorAll('#rp-shaders-body .sp-empty')]
          .map(el => el.textContent.trim()),
        sceneLabels: [...document.querySelectorAll('#rp-scene-body label')]
          .map(el => el.textContent.trim()),
        outlinerEmpty: document.querySelector('#ol-list .ol-empty')?.textContent.trim() ?? '',
      };
      setLocale('en');
      await frame();
      return { before, after };
    })()`);
    assert(localeSwitch.after.lang === 'zh-Hant', 'locale switch did not update <html lang>');
    assert(localeSwitch.before.printTabs.includes('Scale'), 'locale regression setup missing English Print tab text');
    assert(localeSwitch.after.printTabs.includes('比例'),
      `locale switch did not refresh generated Print tab text: ${localeSwitch.after.printTabs.join(', ')}`);
    assert(localeSwitch.after.propertiesEmpty.includes('拖到視窗'),
      `locale switch did not refresh generated Properties empty text: ${localeSwitch.after.propertiesEmpty}`);
    assert(localeSwitch.after.shaderEmpty.some(text => text.includes('選取上方著色器')),
      `locale switch did not refresh generated Shader empty text: ${localeSwitch.after.shaderEmpty.join(', ')}`);
    assert(localeSwitch.after.sceneLabels.includes('背景'),
      `locale switch did not refresh generated Scene labels: ${localeSwitch.after.sceneLabels.join(', ')}`);
    assert(localeSwitch.after.outlinerEmpty.includes('拖到視窗'),
      `locale switch did not refresh generated Outliner empty text: ${localeSwitch.after.outlinerEmpty}`);

    const cursorMenu = await evaluate(cdp, `(async () => {
      const cm = await import('/src/ui/ContextMenu.js');
      cm.open({ x: 24, y: 24, source: 'viewport' });
      await new Promise(r => requestAnimationFrame(r));
      const worldOrigin = document.querySelector('.context-menu [data-action="cursor-to-origin"]');
      const selectionToCursor = document.querySelector('.context-menu [data-action="sel-to-cursor"]');
      const cursorToSelection = document.querySelector('.context-menu [data-action="cursor-to-sel"]');
      const out = {
        worldOrigin: !!worldOrigin && !worldOrigin.classList.contains('cm-disabled'),
        selectionToCursor: !!selectionToCursor,
        cursorToSelection: !!cursorToSelection,
      };
      cm.close();
      return out;
    })()`);
    assert(cursorMenu.worldOrigin, 'context menu missing enabled Cursor → World Origin action');
    assert(cursorMenu.selectionToCursor && cursorMenu.cursorToSelection,
      'context menu missing selection cursor snap actions');

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
      // M10: the back-face FILL clone must FOLLOW the source when it moves
      // (it used to bake the world matrix once → detached from the cut on move).
      let capFollows = false;
      {
        const cap = scene.meshes.find(m => m.name.startsWith('mx-section-cap-'));
        if (cap) {
          secBox.position.x += 0.2;            // move the source solid
          secBox.computeWorldMatrix(true);
          scene.render();                      // runs the clone's per-frame follow
          cap.computeWorldMatrix(true);
          capFollows = Math.abs(cap.getAbsolutePosition().x - secBox.getAbsolutePosition().x) < 1e-4;
          secBox.position.x -= 0.2;            // restore
          secBox.computeWorldMatrix(true);
        }
      }
      sm.SceneManager.setSectionPlane({ enabled: true, axis: 'z', offsetMM: 0, flip: true });
      const aFlip = await alphaAt(await ro.capturePng({ width: 64, height: 64, transparent: true }));
      sm.SceneManager.setSectionPlane({ enabled: false });
      const vizWhenOff = hasFill();
      const borderWhenOff = !!scene.getMeshByName('mx-section-border');
      // Offset-slider range = content extent along the axis (lowest..highest).
      const ext = sm.SceneManager.getSectionExtentMM('z');
      const extentOk = ext.hasContent && ext.maxMM > ext.minMM;
      const section = { aNoCut, aCut, aFlip, vizWhenOn, vizWhenOff, borderWhenOn, borderWhenOff, extentOk, capFollows };

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

      // (3b) Bounce YIELD — a scale set DURING the pop must survive settle, not
      // be clobbered back to orig (audit bounce-wrinkle fix). Deterministic: no
      // render frame ticks between the dispatch and the settle.
      const yBox = B.MeshBuilder.CreateBox('smoke-bounce-yield', { size: 0.05 }, scene);
      yBox.metadata = { meshId: 'smoke-bounce-yield' };
      yBox.scaling.set(1, 1, 1);
      st.dispatch(ev.EVENTS.ASSET_INSTANTIATED, { meshId: 'smoke-bounce-yield' });   // pop starts, orig=1
      yBox.scaling.set(4, 4, 4);                                                      // user scales mid-pop
      (await import('/src/core/scene/ImportBounce.js')).settleImportBounce();         // must NOT restore orig
      const bounceYield = { kept: yBox.scaling.x === 4 && yBox.scaling.y === 4 && yBox.scaling.z === 4 };
      yBox.dispose();

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

      // (6b) Base-color display mode: a PBR material flips to unlit and
      // restores (viewport-only; mirrors the print-preview store/restore).
      const bcBox = B.MeshBuilder.CreateBox('smoke-basecolor', { size: 0.04 }, scene);
      bcBox.metadata = { meshId: 'smoke-basecolor' };
      const bcMat = new B.PBRMaterial('smoke-pbr', scene);
      bcBox.material = bcMat;
      sm.SceneManager.setOverlay('baseColorView', true);
      const baseOn = bcMat.unlit === true;
      sm.SceneManager.setOverlay('baseColorView', false);
      const baseOff = bcMat.unlit === false;
      bcBox.dispose(); bcMat.dispose();
      const modeOpts = document.querySelectorAll('.vt-mode option').length;
      // Resin-grey default: material-less meshes render with scene.defaultMaterial,
      // set to matte medium-light grey at init.
      const dm = scene.defaultMaterial;
      const dmGrey = !!dm && Math.abs((dm.diffuseColor?.r ?? 0) - 0.4) < 0.01;

      // (6b2) UV-checker mode: a content material's base texture swaps to the
      // checker and restores.
      const uvBox = B.MeshBuilder.CreateBox('smoke-uv', { size: 0.04 }, scene);
      uvBox.metadata = { meshId: 'smoke-uv' };
      const uvMat = new B.PBRMaterial('smoke-uvmat', scene);
      uvBox.material = uvMat;
      sm.SceneManager.setOverlay('uvCheckerView', true);
      const uvOn = uvMat.albedoTexture?.name === 'mx-uv-checker';
      sm.SceneManager.setOverlay('uvCheckerView', false);
      const uvOff = !uvMat.albedoTexture;
      uvBox.dispose(); uvMat.dispose();

      // (6c) Inverted/back-face highlight: toggling on creates red back-face
      // clones for content solids; off disposes them.
      sm.SceneManager.setOverlay('invertedFaces', true);
      const invOn = scene.meshes.some(m => m.name.startsWith('mx-backface-'));
      sm.SceneManager.setOverlay('invertedFaces', false);
      const invOff = scene.meshes.some(m => m.name.startsWith('mx-backface-'));

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

      // (8) 3D cursor (Blender N-panel feature): the ball + ring/crosshair
      // meshes exist, and setCursor writes through to state.scene.cursor3d.
      const cursorBall = !!scene.getMeshByName('cursor3d');
      const cursorRing = !!scene.getMeshByName('cursor3dRing');
      sm.SceneManager.setCursor(new B.Vector3(0.1, 0.02, -0.05));
      const cState = st.getState().scene.cursor3d;
      const cursorStateSync = Math.abs(cState.x - 0.1) < 1e-6 && Math.abs(cState.z + 0.05) < 1e-6;
      sm.SceneManager.setCursor(new B.Vector3(0, 0, 0));

      // (9) Two-tone selection outline: active emissive carries in R, the other
      // selected objects in G — the channel split that lets the pass tint the
      // active a darker orange.
      const amA = scene.materials.find(m => m.name === 'mx-sel-mask-active');
      const amS = scene.materials.find(m => m.name === 'mx-sel-mask-selected');
      const maskTwoTone = !!amA && !!amS
        && amA.emissiveColor.r === 1 && amA.emissiveColor.g === 0
        && amS.emissiveColor.r === 0 && amS.emissiveColor.g === 1;

      // (10) Pivot-mode sync: the toolbar's Cursor button + the N-panel's
      // "Use Cursor as Pivot" toggle both reflect state via PIVOT_MODE_CHANGED.
      const sel = await import('/src/core/Selection.js');
      sel.Selection.setPivotMode('cursor');
      await new Promise(r => requestAnimationFrame(r));
      const tbCursorOn = !!document.querySelector('.vt-group[data-group="pivot"] .vt-btn.vt-on[data-mode="cursor"]');
      const npPivotOn  = document.querySelector('#n-panel [data-act="pivot-cursor"]')?.checked === true;
      sel.Selection.setPivotMode('median');
      await new Promise(r => requestAnimationFrame(r));
      const tbCursorOff = !document.querySelector('.vt-group[data-group="pivot"] .vt-btn.vt-on[data-mode="cursor"]');
      const npPivotOff  = document.querySelector('#n-panel [data-act="pivot-cursor"]')?.checked === false;
      const pivotSync = tbCursorOn && npPivotOn && tbCursorOff && npPivotOff;

      // (11) Gizmo-space sync: toggling space (the backtick-key path) must
      // update the toolbar World/Local button (GIZMO_CHANGED wiring).
      const spaceBefore = st.getState().gizmo.space;
      sm.SceneManager.setGizmoSpace(spaceBefore === 'world' ? 'local' : 'world');
      await new Promise(r => requestAnimationFrame(r));
      const tbSpaceLocal = !!document.querySelector('.vt-group[data-group="space"] .vt-btn.vt-on');
      sm.SceneManager.setGizmoSpace('world');
      await new Promise(r => requestAnimationFrame(r));
      const tbSpaceWorld = !document.querySelector('.vt-group[data-group="space"] .vt-btn.vt-on');
      const gizmoSpaceSync = tbSpaceLocal && tbSpaceWorld;

      secBox.dispose();
      bBox.dispose();
      return { frameSrc, section, bounce, bounceYield, shadows, ssaoOn, ssaoOffOk, recAborted, recIdle,
               outlineOffWhenEmpty, outlineOnWhenSelected, baseOn, baseOff, modeOpts, invOn, invOff, uvOn, uvOff, dmGrey,
               cursorBall, cursorRing, cursorStateSync, maskTwoTone, pivotSync, gizmoSpaceSync };
    })()`);
    assert(wave.baseOn, 'Base Color mode did not set PBR unlit');
    assert(wave.baseOff, 'Base Color mode did not restore PBR unlit on exit');
    assert(wave.modeOpts === 4, `display-mode selector should have 4 options (Shaded/Matte/Base/UV), got ${wave.modeOpts}`);
    assert(wave.uvOn, 'UV-checker mode did not swap the base texture to the checker');
    assert(wave.uvOff, 'UV-checker mode did not restore the original base texture');
    assert(wave.dmGrey, 'scene.defaultMaterial not set to resin grey (material-less meshes would render white)');
    assert(wave.invOn, 'inverted/back-face highlight created no red back-face clones when on');
    assert(!wave.invOff, 'inverted/back-face highlight clones not disposed when off');
    assert(wave.outlineOffWhenEmpty, 'selection-outline mask RTT not detached when selection is empty (per-frame waste)');
    assert(wave.outlineOnWhenSelected, 'selection-outline mask RTT not re-attached when a mesh is selected');
    assert(wave.cursorBall, '3D cursor ball mesh (cursor3d) missing');
    assert(wave.cursorRing, '3D cursor ring mesh (cursor3dRing) missing');
    assert(wave.cursorStateSync, 'SceneManager.setCursor did not write through to state.scene.cursor3d');
    assert(wave.maskTwoTone, 'selection-outline mask is not two-channel (active R / selected G) — two-tone outline broken');
    assert(wave.pivotSync, 'pivot-mode not synced across toolbar + N-panel (PIVOT_MODE_CHANGED wiring broken)');
    assert(wave.gizmoSpaceSync, 'gizmo space (World/Local) toolbar button not synced to setGizmoSpace (GIZMO_CHANGED wiring broken)');
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
    assert(wave.section.capFollows, 'cross-section fill clone did not follow the source when it moved (M10)');
    assert(wave.bounce.animated,
      `bounce-in not animating (mid scale ${wave.bounce.midScale})`);
    assert(wave.bounce.landedExact, 'bounce-in did not restore the exact original scaling');
    assert(wave.bounceYield.kept, 'bounce clobbered a scale set DURING the pop — should yield to it (wrinkle fix)');
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

    // Resin-grey for shaderless STL: import a real ASCII STL (no material) and
    // confirm the resulting mesh renders grey, not white.
    const stlDiag = await evaluate(cdp, `(async () => {
      const al = await import('/src/core/AssetLoader.js');
      const sm = await import('/src/core/SceneManager.js');
      const B = window.BABYLON;
      const stl = [
        'solid x','facet normal 0 0 1','outer loop',
        'vertex 0 0 0','vertex 10 0 0','vertex 0 10 0',
        'endloop','endfacet','endsolid x',''
      ].join('\\n');
      const blob = new Blob([stl], { type: 'model/stl' });
      let meshIds = [], err = null;
      try { meshIds = await al.AssetLoader.loadFromBlob(blob, 'diag.stl', new B.Vector3(0,0,0), {}); }
      catch (e) { err = String(e); }
      const scene = sm.SceneManager.getScene();
      const mesh = scene.meshes.find(m => m.metadata?.meshId === meshIds[0]);
      const mat = mesh?.material;
      const c = mat?.diffuseColor ?? mat?.albedoColor ?? null;
      return {
        err, found: !!mesh,
        isDefault: mat === scene.defaultMaterial,   // UNITY: same shared material
        color: c ? [+c.r.toFixed(2), +c.g.toFixed(2), +c.b.toFixed(2)] : null,
      };
    })()`);
    assert(!stlDiag.err, `STL import threw: ${stlDiag.err}`);
    assert(stlDiag.found, 'STL mesh not found after import');
    assert(stlDiag.isDefault,
      'shaderless STL was not assigned the shared scene.defaultMaterial (unity broken)');
    assert(stlDiag.color && stlDiag.color[0] === 0.4,
      `resin grey wrong value: ${JSON.stringify(stlDiag.color)}`);

    // ── Base64 save-path worker: real-Worker output === sync codec (#3) ──
    // Manual save embeds asset bytes via the off-thread encoder; a byte
    // mismatch here would silently corrupt every embedded asset in the .mixo.
    // Headless tests only ever hit the sync fallback (no Worker), so pin the
    // REAL worker output against the synchronous codec across the 0x8000
    // fromCharCode chunk boundary, and confirm the source is never detached.
    const b64Worker = await evaluate(cdp, `(async () => {
      const { encodeBase64Async, isBase64WorkerSupported } = await import('/src/core/Base64Worker.js');
      const { __test } = await import('/src/core/PersistenceManager.js');
      const out = { supported: isBase64WorkerSupported(), mismatches: [] };
      for (const len of [0, 1, 2, 3, 255, 256, 257, 0x8000, 0x8001]) {
        const src = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
        const got = await encodeBase64Async(src.buffer);
        if (got !== __test._b64FromBuf(src.buffer)) out.mismatches.push(len);
        if (src.byteLength !== len) out.mismatches.push('detached@' + len);
      }
      return out;
    })()`);
    assert(b64Worker.supported, 'Base64 worker unsupported in Chrome — the save-path offload would never run');
    assert(b64Worker.mismatches.length === 0,
      `base64 worker diverged from the sync codec (or detached the source) at: ${b64Worker.mismatches.join(', ')}`);

    // ── Per-object ratio survives .mixo save → load (audit #1) ───────────
    // Import an STL, halve it via RescaleObjectCommand (ratio 1→2, baked into
    // vertices), round-trip through the REAL _buildDocument/_loadProject, and
    // assert the restored mesh size + stored ratio match the changed state —
    // NOT the authored size. Restore reloads raw bytes, so this proves the
    // per-object ratio is actually reproduced on load.
    const ratioRT = await evaluate(cdp, `(async () => {
      const al = await import('/src/core/AssetLoader.js');
      const sm = await import('/src/core/SceneManager.js');
      const st = await import('/src/core/StateManager.js');
      const hm = await import('/src/core/HistoryManager.js');
      const pm = await import('/src/core/PersistenceManager.js');
      const B = window.BABYLON;
      const sizeOf = (mid) => {
        const scene = sm.SceneManager.getScene();
        const mesh = scene.meshes.find(m => m.metadata?.meshId === mid);
        if (!mesh) return null;
        const r = mesh.getHierarchyBoundingVectors(true);
        return +(r.max.x - r.min.x).toFixed(6);
      };
      const stl = ['solid x','facet normal 0 0 1','outer loop',
        'vertex 0 0 0','vertex 20 0 0','vertex 0 20 0',
        'endloop','endfacet','endsolid x',''].join('\\n');
      const ids = await al.AssetLoader.loadFromBlob(new Blob([stl], { type: 'model/stl' }), 'rt.stl', new B.Vector3(0,0,0), {});
      const id = ids[0];
      // Deterministically settle the import bounce instead of racing a fixed
      // wait: the bounce observer owns mesh.scaling for ~260ms and would clobber
      // the ×3 node scale set below (the source of intermittent failures here).
      await new Promise(r => setTimeout(r, 60));   // let instantiation + bounce register
      (await import('/src/core/scene/ImportBounce.js')).settleImportBounce();
      const importedSize = sizeOf(id);
      const importedRatio = st.getState().scene.objects[id].ratio;
      hm.push(new hm.RescaleObjectCommand([id], 2));   // 1 → 2 ⇒ ×0.5 (baked)
      const afterSize = sizeOf(id);
      const afterRatio = st.getState().scene.objects[id].ratio;
      // Also apply a NODE scale (Properties Scale field — never baked) so the
      // round-trip proves both the baked ratio AND the node scale survive.
      sm.SceneManager.getScene().meshes.find(m => m.metadata?.meshId === id)?.scaling.set(3,3,3);
      const scaledSize = sizeOf(id);
      const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
      await pm.__test._loadProject(doc);
      await new Promise(r => setTimeout(r, 400));   // settle any restore animation
      const restoredSize = sizeOf(id);
      const restoredRatio = st.getState().scene.objects[id]?.ratio ?? null;
      // Reset node scale so the ×3 mesh doesn't cover downstream tests' click points.
      sm.SceneManager.getScene().meshes.find(m => m.metadata?.meshId === id)?.scaling.set(1,1,1);
      return { importedSize, importedRatio, afterSize, afterRatio, scaledSize, restoredSize, restoredRatio };
    })()`);
    const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 0.02);
    assert(ratioRT.importedRatio === 1, `STL seed ratio should be 1, got ${ratioRT.importedRatio}`);
    assert(ratioRT.afterRatio === 2, `ratio change not stored, got ${ratioRT.afterRatio}`);
    assert(near(ratioRT.afterSize, ratioRT.importedSize / 2),
      `ratio 1->2 should halve size: imported ${ratioRT.importedSize}, after ${ratioRT.afterSize}`);
    assert(near(ratioRT.scaledSize, ratioRT.afterSize * 3),
      `node scale ×3 not applied: after=${ratioRT.afterSize} scaled=${ratioRT.scaledSize}`);
    assert(ratioRT.restoredRatio === 2, `restored ratio lost: got ${ratioRT.restoredRatio}`);
    assert(near(ratioRT.restoredSize, ratioRT.scaledSize),
      `RESTORE LOST ratio bake or node scale: scaled=${ratioRT.scaledSize} restored=${ratioRT.restoredSize} (after=${ratioRT.afterSize})`);

    // ── glTF RH→LH flip survives .mixo restore (audit follow-up) ─────────
    // Import a minimal asymmetric glTF triangle (Babylon applies the RH→LH
    // flip on load, baked into vertices). Round-trip and assert the restored
    // world AABB == the fresh-import AABB — restore must re-run the SAME import
    // normalization (flip + unit), not just a uniform scale.
    const gltfRT = await evaluate(cdp, `(async () => {
      const al = await import('/src/core/AssetLoader.js');
      const sm = await import('/src/core/SceneManager.js');
      const pm = await import('/src/core/PersistenceManager.js');
      const B = window.BABYLON;
      const dv = new DataView(new ArrayBuffer(42));
      [0,0,2, 8,0,0, 0,4,0].forEach((v,i) => dv.setFloat32(i*4, v, true));
      [0,1,2].forEach((v,i) => dv.setUint16(36 + i*2, v, true));
      let bin = ''; for (const b of new Uint8Array(dv.buffer)) bin += String.fromCharCode(b);
      const gltf = {
        asset:{version:"2.0"},
        buffers:[{byteLength:42, uri:"data:application/octet-stream;base64,"+btoa(bin)}],
        bufferViews:[{buffer:0,byteOffset:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:6,target:34963}],
        accessors:[{bufferView:0,componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[8,4,2]},{bufferView:1,componentType:5123,count:3,type:"SCALAR"}],
        meshes:[{primitives:[{attributes:{POSITION:0},indices:1,mode:4}]}],
        nodes:[{mesh:0}], scenes:[{nodes:[0]}], scene:0
      };
      const blob = new Blob([JSON.stringify(gltf)], { type:'model/gltf+json' });
      const aabb = (mid) => {
        const mesh = sm.SceneManager.getScene().meshes.find(m => m.metadata?.meshId === mid);
        if (!mesh) return null;
        const r = mesh.getHierarchyBoundingVectors(true);
        return { minx:+r.min.x.toFixed(5), maxx:+r.max.x.toFixed(5), minz:+r.min.z.toFixed(5), maxz:+r.max.z.toFixed(5) };
      };
      let ids=[], err=null;
      try { ids = await al.AssetLoader.loadFromBlob(blob, 'flip.gltf', new B.Vector3(0,0,0), {}); } catch(e){ err=String(e); }
      await new Promise(r => setTimeout(r, 400));
      const fresh = ids[0] ? aabb(ids[0]) : null;
      const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
      await pm.__test._loadProject(doc);
      await new Promise(r => setTimeout(r, 400));
      const restored = ids[0] ? aabb(ids[0]) : null;
      return { err, fresh, restored };
    })()`);
    assert(!gltfRT.err, `glTF flip import threw: ${gltfRT.err}`);
    assert(gltfRT.fresh && gltfRT.restored, 'glTF flip round-trip: mesh missing');
    assert(gltfRT.fresh.maxx - gltfRT.fresh.minx > 1e-4, 'glTF fixture degenerate (no extent)');
    {
      const az = (a, b) => Math.abs(a - b) <= 5e-4;
      const f = gltfRT.fresh, r = gltfRT.restored;
      assert(az(f.minx, r.minx) && az(f.maxx, r.maxx) && az(f.minz, r.minz) && az(f.maxz, r.maxz),
        `glTF restore AABB (incl RH→LH flip) != fresh import: fresh=${JSON.stringify(f)} restored=${JSON.stringify(r)}`);
    }

    // ── Multi-shader object: weld parts for validation, don't merge objects ─
    // (a) A CLOSED cube split into 2 material primitives: each half is open, but
    //     the welded union must validate watertight (0 non-manifold) and present
    //     as ONE logical object. (b) Two SEPARATE objects must stay two.
    const splitVal = await evaluate(cdp, `(async () => {
      const f32 = a => { const b=new ArrayBuffer(a.length*4),d=new DataView(b); a.forEach((v,i)=>d.setFloat32(i*4,v,true)); return new Uint8Array(b); };
      const u16 = a => { const b=new ArrayBuffer(a.length*2),d=new DataView(b); a.forEach((v,i)=>d.setUint16(i*2,v,true)); return new Uint8Array(b); };
      const cat = (...a)=>{let n=0;a.forEach(x=>n+=x.length);const r=new Uint8Array(n);let o=0;a.forEach(x=>{r.set(x,o);o+=x.length;});return r;};
      const b64 = u8 => { let s=''; for(const b of u8) s+=String.fromCharCode(b); return btoa(s); };
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const { getState } = await import('/src/core/StateManager.js');
      const { MeshValidator } = await import('/src/core/MeshValidator.js');
      const { logicalObjectPartIds, shouldDisplayObject } = await import('/src/core/LogicalObjects.js');
      // (a) closed cube, 12 tris split 6/6 into two material primitives.
      const V = [0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1];
      const I = [0,1,2,0,2,3, 4,6,5,4,7,6, 0,4,5,0,5,1, 1,5,6,1,6,2, 2,6,7,2,7,3, 3,7,4,3,4,0];
      const pos=f32(V), i0=u16(I.slice(0,18)), i1=u16(I.slice(18)), bin=cat(pos,i0,i1);
      const cube = { asset:{version:'2.0'},
        buffers:[{byteLength:bin.length,uri:'data:application/octet-stream;base64,'+b64(bin)}],
        bufferViews:[{buffer:0,byteOffset:0,byteLength:pos.length,target:34962},{buffer:0,byteOffset:pos.length,byteLength:i0.length,target:34963},{buffer:0,byteOffset:pos.length+i0.length,byteLength:i1.length,target:34963}],
        accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[0,0,0],max:[1,1,1]},{bufferView:1,componentType:5123,count:18,type:'SCALAR'},{bufferView:2,componentType:5123,count:18,type:'SCALAR'}],
        materials:[{pbrMetallicRoughness:{baseColorFactor:[1,0,0,1]}},{pbrMetallicRoughness:{baseColorFactor:[0,0,1,1]}}],
        meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0},{attributes:{POSITION:0},indices:2,material:1}]}],
        nodes:[{mesh:0,name:'Cube2Mat'}], scenes:[{nodes:[0]}], scene:0 };
      const cubeIds = await AssetLoader.loadFromBlob(new Blob([JSON.stringify(cube)],{type:'model/gltf+json'}),'cube2.gltf');
      let objs = getState().scene.objects;
      const lead = cubeIds.find(id => shouldDisplayObject(objs[id])) ?? cubeIds[0];
      const cubeParts = logicalObjectPartIds(lead, objs).length;
      const cubeShown = cubeIds.filter(id => shouldDisplayObject(objs[id])).length;
      const res = await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(lead));
      const nm = res.find(r => r.type === 'nonManifold');
      // (b) two separate single-material objects.
      const tpos=f32([0,0,0,1,0,0,0,1,0]), tidx=u16([0,1,2]), tbin=cat(tpos,tidx);
      const two = { asset:{version:'2.0'},
        buffers:[{byteLength:tbin.length,uri:'data:application/octet-stream;base64,'+b64(tbin)}],
        bufferViews:[{buffer:0,byteOffset:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:6,target:34963}],
        accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5123,count:3,type:'SCALAR'}],
        materials:[{pbrMetallicRoughness:{baseColorFactor:[1,0,0,1]}},{pbrMetallicRoughness:{baseColorFactor:[0,0,1,1]}}],
        meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]},{primitives:[{attributes:{POSITION:0},indices:1,material:1}]}],
        nodes:[{mesh:0,name:'ObjA'},{mesh:1,name:'ObjB'}], scenes:[{nodes:[0,1]}], scene:0 };
      const twoIds = await AssetLoader.loadFromBlob(new Blob([JSON.stringify(two)],{type:'model/gltf+json'}),'two.gltf');
      objs = getState().scene.objects;
      const twoShown = twoIds.filter(id => shouldDisplayObject(objs[id])).length;
      const twoGrouped = logicalObjectPartIds(twoIds[0], objs).length;
      return { cubeParts, cubeShown, cubeBad: nm ? nm.count : 0, twoShown, twoGrouped };
    })()`);
    assert(splitVal.cubeParts === 2, `multi-primitive object should group 2 parts, got ${splitVal.cubeParts}`);
    assert(splitVal.cubeShown === 1, `multi-primitive object should present as ONE logical object, got ${splitVal.cubeShown}`);
    assert(splitVal.cubeBad === 0, `welded union of a closed 2-material cube must be watertight (0 non-manifold), got ${splitVal.cubeBad}`);
    assert(splitVal.twoShown === 2 && splitVal.twoGrouped === 1,
      `two SEPARATE objects must NOT merge (shown=${splitVal.twoShown}, parts-of-first=${splitVal.twoGrouped})`);

    // ── Box (marquee) selection ──────────────────────────────────────────
    // Two complementary live checks against the origin STL mesh:
    //  (1) PROJECTION — frame the mesh, then run the module's real projector +
    //      hit-test over a full-canvas rect. Proves the live transform matrix /
    //      viewport / bounding-centre pipeline finds a real Babylon mesh (the
    //      part the headless unit tests stub out).
    //  (2) ROUTING — drive a synthetic left-drag through InputManager's pointer
    //      observable and confirm the overlay is created and no exception is
    //      thrown. Proves the gesture coexists with body-drag / context-menu /
    //      camera nav wiring (the "will it crash" concern). Coordinate-exact
    //      selection under synthetic events is left to the unit tests.
    const boxProj = await evaluate(cdp, `(async () => {
      const sel = await import('/src/core/Selection.js');
      const sm  = await import('/src/core/SceneManager.js');
      const bs  = await import('/src/core/BoxSelect.js');
      const scene = sm.SceneManager.getScene();
      const mesh  = scene.meshes.find(m => m.metadata?.meshId);
      sm.SceneManager.frameSelected([mesh]);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cv = document.querySelector('#renderCanvas').getBoundingClientRect();
      const rect = { sx: 0, sy: 0, ex: cv.width, ey: cv.height };
      const hits = bs.BoxSelect.meshIdsInRect(scene.meshes, rect, bs.BoxSelect.projectToScreen);
      return { hits: hits.length, hasContentId: !!mesh?.metadata?.meshId };
    })()`);
    assert(boxProj.hasContentId, 'no content mesh in scene to box-select');
    assert(boxProj.hits >= 1, 'live projection hit-test found no mesh inside a full-canvas rect');

    const boxRect = await evaluate(cdp, `(() => {
      const cv = document.querySelector('#renderCanvas').getBoundingClientRect();
      return {
        x0: Math.round(cv.left + 20),  y0: Math.round(cv.top + 90),
        x1: Math.round(cv.right - 20), y1: Math.round(cv.bottom - 20),
      };
    })()`);
    const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
    await mouse('mousePressed', boxRect.x0, boxRect.y0);
    await mouse('mouseMoved', Math.round((boxRect.x0 + boxRect.x1) / 2), Math.round((boxRect.y0 + boxRect.y1) / 2));
    await mouse('mouseMoved', boxRect.x1, boxRect.y1);
    await mouse('mouseReleased', boxRect.x1, boxRect.y1);
    await sleep(60);
    const overlayMade = await evaluate(cdp, `!!document.querySelector('.box-select')`);
    assert(overlayMade, 'box-select overlay element was never created by the pointer routing');

    // ── Settings persistence + reset + logo ──────────────────────────────
    // (1) Logo renders in the header. (2) A user-edited setting saves to
    // localStorage with content slices excluded. (3) resetSection restores one
    // section to factory + rewrites storage. (4) resetAll clears the key +
    // restores everything. Drives SettingsStore directly (the panel handlers
    // just call these), plus a DOM check for the logo.
    const settings = await evaluate(cdp, `(async () => {
      const ss = (await import('/src/core/SettingsStore.js')).SettingsStore;
      const sm = await import('/src/core/StateManager.js');
      const DS = (await import('/src/config/default-settings.json', { with: { type: 'json' } })).default;
      const KEY = 'mx-settings-v1';

      const logoSvg = document.querySelector('#app-logo svg');
      const logoOk = !!logoSvg && logoSvg.getBoundingClientRect().width > 10;

      // (2) edit a setting → save → read back the blob
      sm.setState(s => ({ ...s, scene: { ...s.scene, render: { ...s.scene.render, exposure: 1.77 } } }), { silent: true });
      sm.setState(s => ({ ...s, scene: { ...s.scene, objects: { junk: { id: 'junk' } } } }), { silent: true });
      ss.save();
      const saved = JSON.parse(localStorage.getItem(KEY));
      const savedExposure = saved?.settings?.render?.exposure;
      const excludesObjects = !('objects' in (saved?.settings ?? {}))
        && !('scene' in (saved?.settings ?? {}));

      // (3) resetSection(environment) → exposure back to factory. The store
      // persists on a ~300 ms debounce — wait it out before reading storage.
      ss.resetSection('environment');
      const afterSection = sm.getState().scene.render.exposure;
      await new Promise(r => setTimeout(r, 400));
      const savedAfterSection = JSON.parse(localStorage.getItem(KEY))?.settings?.render?.exposure;

      // (4) dirty again, then resetAll → key cleared + state factory. A scene
      // is loaded. exportRatios is per-project CONTENT (not a setting) so it must
      // be PRESERVED through a settings reset; a real print setting
      // (minWallThickness) resets to factory.
      sm.setState(s => ({ ...s, print: { ...s.print, exportRatios: [9, 35], minWallThickness: 9 } }), { silent: true });
      ss.save();
      const sceneLoaded = Object.keys(sm.getState().scene.objects).length > 0;
      ss.resetAll();
      const keyCleared = localStorage.getItem(KEY) === null;
      const ratioPreserved = JSON.stringify(sm.getState().print.exportRatios) === JSON.stringify([9, 35]);
      const wallReset = sm.getState().print.minWallThickness === DS.print.minWallThickness;

      return { logoOk, savedExposure, excludesObjects, afterSection, savedAfterSection, keyCleared, sceneLoaded, ratioPreserved, wallReset, dsExposure: DS.render.exposure };
    })()`);
    assert(settings.logoOk, 'header logo (#app-logo) missing or not rendered');
    assert(settings.savedExposure === 1.77, 'edited setting was not persisted to localStorage');
    assert(settings.excludesObjects, 'persisted settings leaked content (scene/objects)');
    assert(settings.afterSection === settings.dsExposure, 'resetSection did not restore the factory value');
    assert(settings.savedAfterSection === settings.dsExposure, 'resetSection did not re-persist the restored value');
    assert(settings.keyCleared, 'resetAll did not clear the settings localStorage key');
    assert(settings.sceneLoaded, 'expected a loaded scene (diag STL) for the reset check');
    assert(settings.ratioPreserved, 'resetAll wrongly reset exportRatios — it is per-project content, not a setting');
    assert(settings.wallReset, 'resetAll did not reset a print field');

    // ── Duplicate survives .mixo reload as a DISTINCT mesh (audit H1) ────
    // Import, duplicate, give the copy a different ratio, round-trip. Before the
    // fix both objects re-bound to one container mesh on reload and collapsed
    // (one size). Now each gets its own restored geometry.
    const dupRT = await evaluate(cdp, `(async () => {
      const al = await import('/src/core/AssetLoader.js');
      const sm = await import('/src/core/SceneManager.js');
      const st = await import('/src/core/StateManager.js');
      const hm = await import('/src/core/HistoryManager.js');
      const pm = await import('/src/core/PersistenceManager.js');
      const B = window.BABYLON;
      const sizeOf = (mid) => { const m = sm.SceneManager.getScene().meshes.find(x=>x.metadata?.meshId===mid); if(!m) return null; const r=m.getHierarchyBoundingVectors(true); return +(r.max.x-r.min.x).toFixed(6); };
      const stl = ['solid x','facet normal 0 0 1','outer loop','vertex 0 0 0','vertex 20 0 0','vertex 0 20 0','endloop','endfacet','endsolid x',''].join('\\n');
      const ids = await al.AssetLoader.loadFromBlob(new Blob([stl],{type:'model/stl'}),'dup.stl',new B.Vector3(0,0,0),{});
      const src = ids[0];
      await new Promise(r=>setTimeout(r,300));
      // Settle the SOURCE bounce BEFORE duplicating: cloneMeshAsNewObject copies
      // the source's live node scaling at clone time, so a mid-bounce source would
      // hand the copy a transient scale that settle then locks in (flaky dupBefore).
      (await import('/src/core/scene/ImportBounce.js')).settleImportBounce();
      const before = new Set(Object.keys(st.getState().scene.objects));
      hm.push(new hm.DuplicateCommand([src]));
      const dup = Object.keys(st.getState().scene.objects).find(k => !before.has(k));
      if (!dup) return { err: 'no duplicate created' };
      hm.push(new hm.RescaleObjectCommand([dup], 2));   // halve the copy only
      // Settle the src + dup import bounce before measuring — the bounce owns
      // node scaling for ~260ms and otherwise makes srcBefore/dupBefore flaky.
      (await import('/src/core/scene/ImportBounce.js')).settleImportBounce();
      const srcBefore = sizeOf(src), dupBefore = sizeOf(dup);
      const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
      await pm.__test._loadProject(doc);
      await new Promise(r=>setTimeout(r,400));
      const scene = sm.SceneManager.getScene();
      const mSrc = scene.meshes.find(x=>x.metadata?.meshId===src);
      const mDup = scene.meshes.find(x=>x.metadata?.meshId===dup);
      return { srcBefore, dupBefore, srcAfter: sizeOf(src), dupAfter: sizeOf(dup), distinct: !!mSrc && !!mDup && mSrc !== mDup };
    })()`);
    assert(!dupRT.err, `dup round-trip: ${dupRT.err}`);
    {
      const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 0.02);
      assert(dupRT.distinct, 'duplicate collapsed onto the source mesh on reload (H1)');
      assert(near(dupRT.dupBefore, dupRT.srcBefore / 2), `copy should be half: src ${dupRT.srcBefore} dup ${dupRT.dupBefore}`);
      assert(near(dupRT.srcAfter, dupRT.srcBefore) && near(dupRT.dupAfter, dupRT.dupBefore),
        `sizes must survive reload distinctly: src ${dupRT.srcBefore}->${dupRT.srcAfter}, dup ${dupRT.dupBefore}->${dupRT.dupAfter}`);
    }

    // ── Auto-fix geometry edits survive .mixo reload (audit M1) ─────────
    // Apply a normal-flip fix to a live mesh + tag it, round-trip. Before the
    // fix the edit lived only in live vertices (raw bytes reload undid it); now
    // the applied fix types persist and replay on load.
    const fixRT = await evaluate(cdp, `(async () => {
      const al = await import('/src/core/AssetLoader.js');
      const sm = await import('/src/core/SceneManager.js');
      const st = await import('/src/core/StateManager.js');
      const pm = await import('/src/core/PersistenceManager.js');
      const mv = await import('/src/core/MeshValidator.js');
      const B = window.BABYLON;
      const idxOf = (mid) => { const m = sm.SceneManager.getScene().meshes.find(x=>x.metadata?.meshId===mid); return m ? Array.from(m.getIndices() || []) : null; };
      const stl = ['solid x','facet normal 0 0 1','outer loop','vertex 0 0 0','vertex 20 0 0','vertex 0 20 0','endloop','endfacet','endsolid x',''].join('\\n');
      const ids = await al.AssetLoader.loadFromBlob(new Blob([stl],{type:'model/stl'}),'fix.stl',new B.Vector3(0,0,0),{});
      const mid = ids[0];
      await new Promise(r=>setTimeout(r,300));
      const before = idxOf(mid);
      const mesh = sm.SceneManager.getScene().meshes.find(x=>x.metadata?.meshId===mid);
      mv.MeshValidator.applyGeometryFix(mesh, 'invertedNormals');     // flip live winding
      const fixed = idxOf(mid);
      st.setState(s => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [mid]: { ...s.scene.objects[mid], geometryFixes: ['invertedNormals'] } } } }), { silent: true });
      const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
      const persisted = (doc.sceneObjects.find(o=>o.id===mid)||{}).geometryFixes;
      await pm.__test._loadProject(doc);
      await new Promise(r=>setTimeout(r,400));
      const after = idxOf(mid);
      return { changed: JSON.stringify(before)!==JSON.stringify(fixed), persisted, replayed: JSON.stringify(after)===JSON.stringify(fixed) };
    })()`);
    assert(Array.isArray(fixRT.persisted) && fixRT.persisted.includes('invertedNormals'),
      'auto-fix types were not persisted to the .mixo doc (M1)');
    assert(fixRT.changed, 'normal-flip did not change the live winding (test setup)');
    assert(fixRT.replayed, 'auto-fix geometry edit did not replay on reload — fix vanished (M1)');

    // ── Shader content-dedupe on import (audit #15 guard) ────────────────
    // Pins registerFromContainer's auto-dedupe in REAL Babylon (headless mock
    // materials don't satisfy _detectType). Guards the O(M+S) signature-index
    // refactor: identical materials must still collapse to one shader, within a
    // single import AND against an already-registered shader. Placed last so its
    // material/shader churn can't perturb the bounce-timing of the round-trips.
    const shDedup = await evaluate(cdp, `(async () => {
      const { ShaderLibrary } = await import('/src/core/ShaderLibrary.js');
      const { getState } = await import('/src/core/StateManager.js');
      const { SceneManager } = await import('/src/core/SceneManager.js');
      const B = window.BABYLON;
      const scene = SceneManager.getScene();
      const mk = (name, rgb) => { const m = new B.StandardMaterial(name, scene); m.diffuseColor = new B.Color3(rgb[0], rgb[1], rgb[2]); return m; };
      const count = () => Object.keys(getState().scene.shaders).length;
      const out = {};
      // (1) two identical materials, DIFFERENT names, in ONE import → ONE shader
      let before = count();
      const a1 = mk('DedupWithinA', [0.13, 0.41, 0.77]);
      const a2 = mk('DedupWithinB', [0.13, 0.41, 0.77]);
      const mesh1 = { material: a1 }, mesh2 = { material: a2 };
      const r1 = await ShaderLibrary.registerFromContainer({ materials: [a1, a2], meshes: [mesh1, mesh2] }, {});
      out.withinAdded = count() - before;
      out.withinIds = r1.shaderIds.length;
      out.bothMeshesShare = mesh1.material === mesh2.material;
      // (2) a material identical to an ALREADY-registered shader → dedups to it
      const c1 = mk('DedupAcrossA', [0.2, 0.6, 0.9]);
      const rc1 = await ShaderLibrary.registerFromContainer({ materials: [c1], meshes: [{ material: c1 }] }, {});
      const c1Id = rc1.shaderIds[0];
      before = count();
      const c2 = mk('DedupAcrossB', [0.2, 0.6, 0.9]);   // same content, different name
      const rc2 = await ShaderLibrary.registerFromContainer({ materials: [c2], meshes: [{ material: c2 }] }, {});
      out.acrossAdded = count() - before;
      out.acrossMappedToFirst = rc2.byMaterial.get(c2) === c1Id;
      return out;
    })()`);
    assert(shDedup.withinAdded === 1 && shDedup.withinIds === 1,
      `import dedupe: two identical materials should make ONE shader (added ${shDedup.withinAdded}, ids ${shDedup.withinIds})`);
    assert(shDedup.bothMeshesShare, 'import dedupe: both meshes should end up on the one surviving material');
    assert(shDedup.acrossAdded === 0 && shDedup.acrossMappedToFirst,
      `import dedupe: a material identical to an existing shader must dedupe to it (added ${shDedup.acrossAdded}, mapped ${shDedup.acrossMappedToFirst})`);

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
