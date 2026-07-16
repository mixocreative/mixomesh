// Frame capture — the RTT pipeline shared by PNG stills, thumbnails and the
// offline video encoder.
//
// PNG path: Tools.CreateScreenshotUsingRenderTargetAsync — renders the scene
// into an RTT at the exact output resolution. Two free wins from the RTT
// path: the camera post chain is NOT applied (clean renders even with a
// selection silhouette — and SSAO, which is viewport-only by the same rule),
// and tone mapping IS kept (it's applied at material shading, not post).
// Scene furniture (grid / axes / bed preview / 3D cursor) is hidden for the
// capture and restored after.
//
// Offline frame renderer: mirrors what Tools.CreateScreenshotUsingRenderTarget
// does internally — camera.outputRenderTarget + a full scene.render() under
// engine-size overrides — but reuses ONE RenderTargetTexture across all frames
// and reads raw RGBA pixels instead of round-tripping every frame through
// PNG encode → dataURL → fetch → decode → ImageBitmap (perf audit #1:
// that round-trip dominated export time).

import { getState } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { clampDimension } from './RenderMath.js';

const BABYLON = window.BABYLON;

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
  const restore = hideFurniture();
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
  const texture = createFrameTarget(scene, cam, w, h);
  if (transparent) texture.clearColor = new BABYLON.Color4(0, 0, 0, 0);
  try {
    await waitReady(texture, cam);
    renderSceneToTarget(scene, engine, cam, texture, w, h);
    const raw = new Uint8Array(w * h * 4);
    await texture.readPixels(0, 0, raw, false);
    const flipped = new Uint8Array(w * h * 4);
    flipRows(raw, flipped, w, h);
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
  const texture = createFrameTarget(scene, camera, w, h);
  try {
    await waitReady(texture, camera);
    renderSceneToTarget(scene, engine, camera, texture, w, h);
    const raw = new Uint8Array(w * h * 4);
    await texture.readPixels(0, 0, raw, false);
    const flipped = new Uint8Array(w * h * 4);
    flipRows(raw, flipped, w, h);
    return flipped;
  } finally {
    texture.dispose();
  }
}

/**
 * Hide viewport furniture for capture; returns a restore fn. Overlay state in
 * state.scene.overlays is the source of truth for what to put back — the
 * capture writes NOTHING to state, it only flips the visual layer.
 */
export function hideFurniture() {
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

/** Create the reusable frame RTT rendering the live mesh list. */
export function createFrameTarget(scene, camera, w, h) {
  const texture = new BABYLON.RenderTargetTexture(
    'mx-rec-frame', { width: w, height: h }, scene, false, false
  );
  texture.renderList = null;          // render the live mesh list
  texture.activeCamera = camera;
  return texture;
}

/** Render one full frame into the RTT under engine-size overrides. */
export function renderSceneToTarget(scene, engine, camera, texture, w, h) {
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

/** WebGL reads rows bottom-up; VideoFrame wants top-down. */
export function flipRows(src, dst, w, h) {
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    dst.set(src.subarray(y * row, y * row + row), (h - 1 - y) * row);
  }
}

// Poll a REAL readiness signal (RTT ready + camera ready), not a blind sleep,
// so a fast scene returns immediately. The ceiling only bounds a genuinely-stuck
// capture: 2 s was too short for the heavy 4096²+/high-poly print scenes this
// tool targets — their textures can still be uploading past 2 s — so a capture
// would spuriously fail (audit LOW). 10 s covers heavy GPU uploads while still
// erroring (rather than hanging) if readiness never arrives.
const _READY_TIMEOUT_MS = 10000;
const _READY_POLL_MS = 10;

/** Wait until the RTT and camera are ready to render, or throw after 10 s. */
export async function waitReady(texture, camera) {
  const tries = Math.ceil(_READY_TIMEOUT_MS / _READY_POLL_MS);
  for (let i = 0; i < tries; i++) {
    if (texture.isReadyForRendering() && camera.isReady(true)) return;
    await new Promise(r => setTimeout(r, _READY_POLL_MS));
  }
  throw new Error(`Render target never became ready after ${_READY_TIMEOUT_MS / 1000}s`);
}
