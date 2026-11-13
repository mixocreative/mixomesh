// Scene ▸ Rendering: the controls, the render-view frame overlay, PNG and video capture, the
// environment floor, the turntable preview and the HDRI probe.
//
// Cut out of browser-smoke.mjs on 2026-11-14, and it is the ONLY block of that walk that could
// move. `docs/size-debt.md` carries the measurement: successive blocks of that file's 2,778-line
// `main()` reference 9, 25, 24, 31, 42 and then 76 bindings declared earlier in it, because each
// area builds on the scene the previous ones left. This one needed two things, so it is a job.
//
// It takes `failures` rather than reading it: the walk owns the page-error accumulator, and the
// check below -- surface page exceptions BEFORE the pixel asserts -- is why it has to be the
// walk's own list and not a fresh one. A handler that threw makes downstream asserts fail with
// misleading messages.

import { assert, evaluate } from '../cdp-harness.mjs';

/**
 * @param {object} cdp the open CDP session
 * @param {string[]} failures the walk's page-error accumulator, read before the pixel asserts
 */
export async function checkRendering(cdp, failures) {
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
}
