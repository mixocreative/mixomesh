// Render output (Scene ▸ Rendering) — produces PNG stills and turntable
// videos. The render-view toggle + frame overlay (compose aids) live in
// ui/ScenePanel.js + ui/RenderFrame.js; this module only captures.
//
// PNG path: Tools.CreateScreenshotUsingRenderTargetAsync — renders the scene
// into an RTT at the exact output resolution. Two free wins from the RTT
// path: the camera post chain is NOT applied (clean renders even with a
// selection silhouette — and SSAO, which is viewport-only by the same rule),
// and tone mapping IS kept (it's applied at material shading, not post).
// Scene furniture (grid / axes / bed preview / 3D cursor) is hidden for the
// capture and restored after.
//
// When a render pose is stored (renderOut.pose — auto-captured while Render
// view is on), exports SHOOT FROM IT: the saved composition is the source of
// truth, not wherever free navigation happens to be (UX audit U1). No pose →
// current view.
//
// Video path: offline WebCodecs encode ONLY, with a direct RTT-pixels →
// VideoFrame feed — no per-frame PNG encode/decode round-trip (perf audit).
// The MediaRecorder fallback was REMOVED: it hard-freezes the renderer on
// Chrome 149 and in all headless Chromium, so it was never a safe fallback.

import { EVENTS } from './events.js';
import { getState, subscribe } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { turntableProgress, clampDimension } from './render/RenderMath.js';

const BABYLON = window.BABYLON;

let _recording = false;
let _preview = null;       // { cancel } while a preview sweep plays
let _abortRecord = null;   // (reason) => void while a recording is in flight

/** @returns {boolean} a turntable recording is in flight */
export function isRecording() { return _recording; }

/** @returns {boolean} a turntable preview is playing */
export function isPreviewing() { return !!_preview; }

// A project switch mid-capture must kill the sweep/encode immediately AND
// must NOT restore the pre-capture camera afterwards — the loaded/new
// project's camera wins (audit C2). Lights/env still restore: they are
// app-fixed studio rig state, not project state.
const _onProjectSwitch = () => {
  _preview?.cancel('project');
  _abortRecord?.('project');
};
subscribe(EVENTS.PROJECT_NEW, _onProjectSwitch);
subscribe(EVENTS.PROJECT_LOADED, _onProjectSwitch);

// ── Turntable sweep (shared by preview + record) ─────────
//
// RIGID rotation of the whole camera rig around the WORLD vertical axis
// through the origin — the camera is NEVER re-aimed and NEVER pans: the
// framing you start with is exactly what rotates. Per-frame, the same
// world rotation is applied to the camera (alpha + target together) so the
// rig's pose relative to the world is a pure rotation about the origin
// axis; on screen, the world spins about where the origin projects while
// the composition is preserved. No jump at start, no drift.
//
// The directional studio lights AND (when one exists)
// scene.environmentTexture rotate by the same angle — lights moving with
// the camera is what makes it read as "model spinning on a turntable under
// fixed studio lighting" instead of "camera flying around the model".
//
// The world matrix is RotationY(−δ) for camera alpha +δ (ArcRotate's α
// moves the camera +X→+Z while Babylon's RotationY(+θ) maps +X→−Z, so the
// sign flips — verified numerically: |position| stays on the origin circle
// only with this pairing). Hemi light points straight up — no-op.

/**
 * Capture everything the sweep touches. Returns { applyDelta, restore } —
 * shared by the live sweep (preview / realtime recording) and the offline
 * frame-by-frame encoder. restore(skipCamera) leaves the camera alone on
 * project-switch cancellation.
 */
function _sweepRig() {
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();

  const startPose   = SceneManager.saveCameraState();
  const startAlpha  = camera.alpha;
  const startTarget = camera.target.clone();

  const key  = scene.getLightByName('key');
  const fill = scene.getLightByName('fill');
  const starts = {
    keyDir:  key?.direction.clone(),  keyPos: key?.position.clone(),
    fillDir: fill?.direction.clone(),
    envRot:  scene.environmentTexture?.rotationY ?? 0,
  };

  const applyDelta = (delta) => {
    const m = BABYLON.Matrix.RotationY(-delta);
    camera.alpha = startAlpha + delta;
    // MUTATE the target — the `camera.target = v` SETTER calls setTarget(),
    // which re-aims (rebuilds alpha/beta from the current position) and
    // would silently overwrite the alpha line above. Same reason CameraRig's
    // pan uses addInPlace.
    camera.target.copyFrom(BABYLON.Vector3.TransformCoordinates(startTarget, m));
    if (key) {
      key.direction = BABYLON.Vector3.TransformCoordinates(starts.keyDir, m);
      key.position  = BABYLON.Vector3.TransformCoordinates(starts.keyPos, m);
    }
    if (fill) fill.direction = BABYLON.Vector3.TransformCoordinates(starts.fillDir, m);
    // +δ verified EMPIRICALLY (browser-smoke mirror-sphere probe): with this
    // sign a mid-sweep capture matches the baseline (lighting fixed relative
    // to camera); −δ made the env counter-rotate (sweepDiff > ctrlDiff).
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot + delta;
    // The key light moved — the RENDERONCE shadow map must re-render.
    SceneManager.invalidateShadows();
  };

  const restore = (skipCamera = false) => {
    if (!skipCamera) SceneManager.restoreCameraState(startPose);
    if (key)  { key.direction = starts.keyDir;  key.position = starts.keyPos; }
    if (fill) fill.direction = starts.fillDir;
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot;
    SceneManager.invalidateShadows();
  };

  return { applyDelta, restore };
}

/**
 * Start a live sweep. Returns { cancel } — cancel(reason) stops early and
 * restores (camera excluded when reason === 'project'). onComplete fires
 * exactly once with 'done' | 'cancelled'.
 */
function _startSweep({ durationS = 8, direction = 'left', ease = true,
                       onProgress, onComplete }) {
  const scene = SceneManager.getScene();
  const durationMs = Math.max(1, durationS) * 1000;
  const { applyDelta, restore } = _sweepRig();

  let startTs = 0;
  let finished = false;
  let observer = null;

  const end = (result, skipCamera = false) => {
    if (finished) return;
    finished = true;
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
    restore(skipCamera);
    onComplete?.(result);
  };

  observer = scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    if (!startTs) startTs = now;
    const t = (now - startTs) / durationMs;
    if (t >= 1) { end('done'); return; }
    const sign = direction === 'right' ? -1 : 1;
    applyDelta(sign * 2 * Math.PI * turntableProgress(t, ease));
    onProgress?.(t);
  });

  return { cancel: (reason) => end('cancelled', reason === 'project') };
}

/**
 * Play the turntable live in the viewport — no recording. Esc, hiding the
 * tab, or stopPreview() stops it early; rig is restored either way.
 * @returns {Promise<'done'|'cancelled'|null>} null when already busy
 */
export function previewTurntable({ durationS = 8, direction = 'left', ease = true,
                                   onProgress } = {}) {
  if (_recording || _preview) return Promise.resolve(null);
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();
  if (!engine || !scene || !camera) return Promise.reject(new Error('Scene not ready'));
  const canvas = engine.getRenderingCanvas();

  return new Promise((resolve) => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sweep.cancel(); }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sweep.cancel();
    };
    const sweep = _startSweep({
      durationS, direction, ease, onProgress,
      onComplete: (result) => {
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.style.pointerEvents = '';
        _preview = null;
        resolve(result);
      },
    });
    _preview = sweep;
    canvas.style.pointerEvents = 'none';
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
  });
}

/** Stop a playing preview early (rig restored). */
export function stopPreview() { _preview?.cancel(); }

// ── PNG still ────────────────────────────────────────────

/**
 * Capture a PNG at the given resolution. With `pose`, shoots from that
 * stored camera composition and puts free navigation back after.
 * @param {{ width?: number, height?: number, transparent?: boolean,
 *           pose?: object|null }} opts
 * @returns {Promise<Blob>}
 */
export async function capturePng({ width, height, transparent = false, pose = null } = {}) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  if (!engine || !scene) throw new Error('Scene not ready');
  const cam = scene.activeCamera;
  const w = clampDimension(width, 1920);
  const h = clampDimension(height, 1080);

  const navPose = pose ? SceneManager.saveCameraState() : null;
  if (pose) SceneManager.restoreCameraState(pose);
  SceneManager.suspendFollow(true);   // don't let follow-mode overwrite the capture pose's target
  const restore = _hideFurniture();
  if (transparent) {
    SceneManager.setBackgroundEnabled(false);
    // An enabled floor becomes a shadow-catcher only: its caught shadow
    // lands in the alpha channel, the plane itself does not.
    SceneManager.setFloorShadowOnly(true);
  }
  try {
    // WebGL: Babylon's screenshot helper is correct (incl. transparent alpha
    // coverage) and stays the proven default path. WebGPU: that helper returns
    // an empty image (never submits the command buffer before readback), so use
    // the manual render → flush → readPixels → encode path instead.
    if (engine.isWebGPU) return await _capturePngWebGPU(scene, engine, cam, w, h, transparent);
    const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
      engine, cam, { width: w, height: h }, 'image/png'
    );
    return await (await fetch(dataUrl)).blob();
  } finally {
    if (transparent) {
      SceneManager.setFloorShadowOnly(false);
      SceneManager.setBackgroundEnabled(true);
    }
    restore();
    SceneManager.suspendFollow(false);
    if (navPose) SceneManager.restoreCameraState(navPose);
  }
}

// WebGPU PNG capture: manual one-frame render → flush (submit the command
// buffer) → readPixels → encode. Mirrors the offline video frame renderer.
// Orientation matches the displayed image (verified against the canvas
// screenshot in test:webgpu). For transparent capture the RTT clears to alpha 0
// and the caller has already disabled the backdrop layer / shadow-only floor.
async function _capturePngWebGPU(scene, engine, cam, w, h, transparent) {
  const texture = _createFrameTarget(scene, cam, w, h);
  if (transparent) texture.clearColor = new BABYLON.Color4(0, 0, 0, 0);
  try {
    await _waitReady(texture, cam);
    _renderSceneToTarget(scene, engine, cam, texture, w, h);
    const raw = new Uint8Array(w * h * 4);
    await texture.readPixels(0, 0, raw, false);
    const flipped = new Uint8Array(w * h * 4);
    _flipRows(raw, flipped, w, h);
    const img = new ImageData(new Uint8ClampedArray(flipped.buffer.slice(0)), w, h);
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').putImageData(img, 0, 0);
      return await c.convertToBlob({ type: 'image/png' });
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(img, 0, 0);
    return await new Promise(res => c.toBlob(res, 'image/png'));
  } finally {
    texture.dispose();
  }
}

// Hide viewport furniture for capture; returns a restore fn. Overlay state in
// state.scene.overlays is the source of truth for what to put back — the
// capture writes NOTHING to state, it only flips the visual layer.
function _hideFurniture() {
  const s = getState();
  const overlays = s.scene.overlays ?? {};
  const hidden = [];
  for (const name of ['grid', 'axes', 'bedPreview']) {
    if (overlays[name]) {
      SceneManager.setOverlay(name, false);
      hidden.push(name);
    }
  }
  // Read ACTUAL cursor visibility, not pivotMode — the cursor can also be
  // shown via the N-panel (Show toggle / panel open) without cursor-pivot, and
  // that must still be hidden from exports.
  const cursorWasVisible = !!SceneManager.isCursorVisible?.();
  if (cursorWasVisible) SceneManager.setCursorVisible(false);
  // The cross-section INDICATOR plane is viewport furniture — the geometric
  // cut still renders, but the striped overlay must not pollute exports.
  const sectionVizWas = SceneManager.isSectionVizVisible?.();
  if (sectionVizWas) SceneManager.setSectionVizVisible(false);
  return () => {
    for (const name of hidden) SceneManager.setOverlay(name, true);
    if (cursorWasVisible) SceneManager.setCursorVisible(true);
    if (sectionVizWas) SceneManager.setSectionVizVisible(true);
  };
}

// ── Offline frame renderer ───────────────────────────────
//
// Mirrors what Tools.CreateScreenshotUsingRenderTarget does internally —
// camera.outputRenderTarget + a full scene.render() under engine-size
// overrides — but reuses ONE RenderTargetTexture across all frames and
// reads raw RGBA pixels instead of round-tripping every frame through
// PNG encode → dataURL → fetch → decode → ImageBitmap (perf audit #1:
// that round-trip dominated export time).

function _createFrameTarget(scene, camera, w, h) {
  const texture = new BABYLON.RenderTargetTexture(
    'mx-rec-frame', { width: w, height: h }, scene, false, false
  );
  texture.renderList = null;          // render the live mesh list
  texture.activeCamera = camera;
  return texture;
}

function _renderSceneToTarget(scene, engine, camera, texture, w, h) {
  engine.skipFrameRender = true;
  const ogW = engine.getRenderWidth;
  const ogH = engine.getRenderHeight;
  // Internal passes size themselves off these — same override the Babylon
  // screenshot helper installs.
  engine.getRenderWidth  = (useScreen = false) =>
    (!useScreen && engine._currentRenderTarget) ? engine._currentRenderTarget.width : w;
  engine.getRenderHeight = (useScreen = false) =>
    (!useScreen && engine._currentRenderTarget) ? engine._currentRenderTarget.height : h;
  scene.incrementRenderId();
  scene.resetCachedMaterial();
  const oCam  = scene.activeCamera;
  const oCams = scene.activeCameras;
  const oOut  = camera.outputRenderTarget;
  scene.activeCamera = camera;
  scene.activeCameras = null;
  camera.outputRenderTarget = texture;
  try {
    scene.render();
    // WebGPU batches GPU commands and submits at frame boundaries, so a manual
    // out-of-loop render leaves nothing for readPixels to read (returns empty).
    // Flush submits the command buffer now. Harmless on WebGL (executes eagerly).
    engine.flushFramebuffer?.();
  } finally {
    scene.activeCamera = oCam;
    scene.activeCameras = oCams;
    camera.outputRenderTarget = oOut;
    engine.getRenderWidth = ogW;
    engine.getRenderHeight = ogH;
    camera.getProjectionMatrix(true);   // drop the overridden-aspect cache
    engine.skipFrameRender = false;
  }
}

// WebGL reads rows bottom-up; VideoFrame wants top-down.
function _flipRows(src, dst, w, h) {
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    dst.set(src.subarray(y * row, y * row + row), (h - 1 - y) * row);
  }
}

/**
 * Render one frame at w×h and return top-down RGBA bytes. Exported as the
 * smoke-test probe for the offline encoder's frame source — an mp4 of
 * black frames would still have plausible bytes; this catches it.
 * @returns {Promise<Uint8Array>}
 */
export async function captureFrameRGBA({ width = 256, height = 256 } = {}) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  if (!engine || !scene) throw new Error('Scene not ready');
  const camera = scene.activeCamera;
  const w = clampDimension(width, 256);
  const h = clampDimension(height, 256);
  const texture = _createFrameTarget(scene, camera, w, h);
  try {
    await _waitReady(texture, camera);
    _renderSceneToTarget(scene, engine, camera, texture, w, h);
    const raw = new Uint8Array(w * h * 4);
    await texture.readPixels(0, 0, raw, false);
    const flipped = new Uint8Array(w * h * 4);
    _flipRows(raw, flipped, w, h);
    return flipped;
  } finally {
    texture.dispose();
  }
}

async function _waitReady(texture, camera) {
  for (let i = 0; i < 200; i++) {
    if (texture.isReadyForRendering() && camera.isReady(true)) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Render target never became ready');
}

// ── Turntable video ──────────────────────────────────────

/**
 * Record a full 360° turntable.
 *
 * OFFLINE WebCodecs encode — the sweep is stepped frame by frame, each frame
 * rendered into a reused RTT at the EXACT output resolution (screen size
 * irrelevant), its pixels fed straight into a hardware VideoEncoder, muxed to
 * mp4 by mp4-muxer (lazy-loaded). Deterministic (no dropped frames).
 *
 * WebCodecs is the ONLY path — the old MediaRecorder fallback was dropped: it
 * hard-freezes/crashes the renderer on Chrome 149 (STATUS_BREAKPOINT) and in
 * all headless Chromium, so it was never a safe fallback. No WebCodecs ⇒ a
 * clear error (Chrome/Edge required), not a hung tab.
 *
 * With `pose`, the whole turntable shoots from the stored render composition;
 * free navigation is restored after. Esc or a project switch cancels; resolves
 * null when cancelled.
 * @param {{ durationS?: number, fps?: number, direction?: 'left'|'right',
 *           ease?: boolean, width?: number, height?: number,
 *           pose?: object|null, onProgress?: (frac: number) => void }} opts
 * @returns {Promise<{ blob: Blob, ext: string, mime: string } | null>}
 */
export async function recordTurntable(opts = {}) {
  if (_recording) return null;
  if (typeof VideoEncoder !== 'function') {
    throw new Error('Video export requires WebCodecs (Chrome or Edge) — this browser has no VideoEncoder.');
  }
  const navPose = opts.pose ? SceneManager.saveCameraState() : null;
  if (opts.pose) SceneManager.restoreCameraState(opts.pose);
  let projectSwitched = false;
  try {
    return await _recordOffline(opts, () => { projectSwitched = true; });
  } finally {
    // Project switch: the new project's camera wins, never the stale pose.
    if (navPose && !projectSwitched) SceneManager.restoreCameraState(navPose);
  }
}

// Pick a supported H.264 encoder config — level by output area, then High →
// Main → Constrained Baseline profile fallback so a future Chromium that
// drops or restricts a profile (licensing, platform policy) still encodes.
// Everything is feature-detected via isConfigSupported; no version checks.
async function _pickAvcConfig(w, h, fps) {
  const area = w * h;
  const level = area <= 1920 * 1088 ? '28'      // L4.0 — up to 1080p
              : area <= 4096 * 2304 ? '33'      // L5.1 — up to 4K
              : '34';                           // L5.2
  const codecs = [`avc1.6400${level}`, `avc1.4D40${level}`, `avc1.42E0${level}`];
  for (const codec of codecs) {
    const config = { codec, width: w, height: h, bitrate: _bitrateFor(w, h, fps), framerate: fps };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch { /* malformed-for-this-build codec string — try the next */ }
  }
  return null;
}

function _bitrateFor(w, h, fps) {
  // ~0.12 bits/pixel/frame — visually clean for screen content; clamped.
  return Math.round(Math.min(40e6, Math.max(4e6, w * h * fps * 0.12)));
}

async function _recordOffline({ durationS = 8, fps = 30, direction = 'left', ease = true,
                                width = 1920, height = 1080, onProgress } = {},
                              onProjectSwitch) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  if (!engine || !scene) throw new Error('Scene not ready');
  const camera = scene.activeCamera;

  const w = clampDimension(width, 1920) & ~1;    // H.264 wants even dimensions
  const h = clampDimension(height, 1080) & ~1;
  const frameCount = Math.max(1, Math.round(Math.max(1, durationS) * fps));
  const config = await _pickAvcConfig(w, h, fps);
  if (!config) throw new Error(`H.264 encoding unsupported at ${w}×${h}`);

  // Lazy: the muxer is only ever needed here — keep it out of the boot
  // chunk (perf audit #2).
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h },
    fastStart: 'in-memory',
  });
  let encError = null;
  let chunkCount = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { chunkCount++; muxer.addVideoChunk(chunk, meta); },
    error: (e) => { encError = e; },
  });
  encoder.configure(config);

  _recording = true;
  let cancelled = false;
  let skipCameraRestore = false;
  _abortRecord = (reason) => {
    cancelled = true;
    if (reason === 'project') { skipCameraRestore = true; onProjectSwitch?.(); }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled = true; }
  };
  window.addEventListener('keydown', onKey, true);
  const canvas = engine.getRenderingCanvas();
  canvas.style.pointerEvents = 'none';   // camera is scripted during the sweep
  const restoreFurniture = _hideFurniture();   // presentation render — no grid/axes
  SceneManager.suspendFollow(true);   // the sweep scripts camera.target — follow must not fight it
  const rig = _sweepRig();
  const sign = direction === 'right' ? -1 : 1;
  const usPerFrame = 1_000_000 / fps;
  const texture = _createFrameTarget(scene, camera, w, h);
  const raw     = new Uint8Array(w * h * 4);   // reused across all frames
  const flipped = new Uint8Array(w * h * 4);

  try {
    await _waitReady(texture, camera);
    for (let i = 0; i < frameCount; i++) {
      if (cancelled) return null;
      if (encError) throw encError;
      // i/frameCount (not count−1): the last frame sits just short of 360°,
      // so the video loops cleanly back onto its first frame.
      rig.applyDelta(sign * 2 * Math.PI * turntableProgress(i / frameCount, ease));
      _renderSceneToTarget(scene, engine, camera, texture, w, h);
      await texture.readPixels(0, 0, raw, false);
      _flipRows(raw, flipped, w, h);
      const frame = new VideoFrame(flipped, {
        format: 'RGBA', codedWidth: w, codedHeight: h,
        timestamp: Math.round(i * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 10));
      onProgress?.(i / frameCount);
    }
    // flush() rejects when the encoder died mid-stream — surface either way.
    await encoder.flush().catch((e) => { encError = encError ?? e; });
    if (encError) throw encError;
    // The MediaRecorder lesson: an encoder can "succeed" while emitting
    // nothing. Never hand the user an empty container.
    if (chunkCount === 0) throw new Error('encoder produced no chunks');
    muxer.finalize();
    return {
      blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
      ext: 'mp4', mime: 'video/mp4',
    };
  } finally {
    try { encoder.close(); } catch { /* already closed on error */ }
    texture.dispose();
    window.removeEventListener('keydown', onKey, true);
    canvas.style.pointerEvents = '';
    rig.restore(skipCameraRestore);
    SceneManager.suspendFollow(false);
    restoreFurniture();
    _abortRecord = null;
    _recording = false;
  }
}

