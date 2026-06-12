// Render output (Scene ▸ Rendering) — produces PNG stills and turntable
// videos from the live viewport camera. The render-view toggle + frame
// overlay (compose aids) live in ui/ScenePanel.js + ui/RenderFrame.js; this
// module only captures.
//
// PNG path: Tools.CreateScreenshotUsingRenderTargetAsync — renders the scene
// into an RTT at the exact output resolution. Two free wins from the RTT
// path: the selection-silhouette post-process is NOT in the chain (clean
// renders even with a selection), and tone mapping IS kept (it's applied at
// material shading, not post). Scene furniture (grid / axes / bed preview /
// 3D cursor) is hidden for the capture and restored after.
//
// Video path: canvas.captureStream + MediaRecorder (realtime — heavy scenes
// may drop frames; a deterministic WebCodecs encoder is the upgrade path).
// The camera alpha sweeps a full 360° around its current target with
// optional sinusoidal ease in/out.

import { getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { turntableProgress, pickVideoFormat, clampDimension } from './render/RenderMath.js';

const BABYLON = window.BABYLON;

let _recording = false;
let _preview = null;   // { cancel } while a preview sweep plays

/** @returns {boolean} a turntable recording is in flight */
export function isRecording() { return _recording; }

/** @returns {boolean} a turntable preview is playing */
export function isPreviewing() { return !!_preview; }

// ── Turntable sweep (shared by preview + record) ─────────
//
// The whole rig — camera AND the directional studio lights AND (when one
// exists) scene.environmentTexture — rotates around the WORLD ORIGIN
// together. Rotating the lights with the camera is what makes it read as
// "model spinning on a turntable under fixed studio lighting" instead of
// "camera flying around the model".
//
// Geometry: camera.alpha += δ orbits the camera azimuth; the matching
// world-rotation for everything else is RotationY(−δ) (ArcRotate's α moves
// the camera +X→+Z while Babylon's RotationY(+θ) maps +X→−Z, so the sign
// flips). Hemi light points straight up — rotation is a no-op, skipped.

/**
 * Start a sweep. Returns { cancel } — cancel(force) stops early and restores.
 * onComplete fires exactly once with 'done' | 'cancelled'.
 */
function _startSweep({ durationS = 8, direction = 'left', ease = true,
                       onProgress, onComplete }) {
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();
  const durationMs = Math.max(1, durationS) * 1000;

  const startAlpha  = camera.alpha;
  const startTarget = camera.target.clone();
  const key  = scene.getLightByName('key');
  const fill = scene.getLightByName('fill');
  const starts = {
    keyDir:  key?.direction.clone(),  keyPos: key?.position.clone(),
    fillDir: fill?.direction.clone(),
    envRot:  scene.environmentTexture?.rotationY ?? 0,
  };

  let startTs = 0;
  let finished = false;
  let observer = null;

  const applyDelta = (delta) => {
    const m = BABYLON.Matrix.RotationY(-delta);
    camera.alpha = startAlpha + delta;
    camera.target = BABYLON.Vector3.TransformCoordinates(startTarget, m);
    if (key) {
      key.direction = BABYLON.Vector3.TransformCoordinates(starts.keyDir, m);
      key.position  = BABYLON.Vector3.TransformCoordinates(starts.keyPos, m);
    }
    if (fill) fill.direction = BABYLON.Vector3.TransformCoordinates(starts.fillDir, m);
    // Sign chosen to match the analytic lights; verify against a real HDR
    // when IBL lands (no environmentTexture exists yet).
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot - delta;
  };

  const restore = () => {
    camera.alpha = startAlpha;
    camera.target.copyFrom(startTarget);
    if (key)  { key.direction = starts.keyDir;  key.position = starts.keyPos; }
    if (fill) fill.direction = starts.fillDir;
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot;
  };

  const end = (result) => {
    if (finished) return;
    finished = true;
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
    restore();
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

  return { cancel: () => end('cancelled') };
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
 * Capture a PNG of the current camera view at the given resolution.
 * @param {{ width?: number, height?: number, transparent?: boolean }} opts
 * @returns {Promise<Blob>}
 */
export async function capturePng({ width, height, transparent = false } = {}) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  if (!engine || !scene) throw new Error('Scene not ready');
  const cam = scene.activeCamera;
  const w = clampDimension(width, 1920);
  const h = clampDimension(height, 1080);

  const restore = _hideFurniture();
  if (transparent) SceneManager.setBackgroundEnabled(false);
  try {
    const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
      engine, cam, { width: w, height: h }, 'image/png'
    );
    const blob = await (await fetch(dataUrl)).blob();
    return blob;
  } finally {
    if (transparent) SceneManager.setBackgroundEnabled(true);
    restore();
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
  const cursorWasVisible = s.selection?.pivotMode === 'cursor';
  if (cursorWasVisible) SceneManager.setCursorVisible(false);
  return () => {
    for (const name of hidden) SceneManager.setOverlay(name, true);
    if (cursorWasVisible) SceneManager.setCursorVisible(true);
  };
}

// ── Turntable video ──────────────────────────────────────

/**
 * Record a full 360° turntable of the current view.
 * Realtime capture: the viewport IS the recording — input is locked and Esc
 * cancels. Resolves null when cancelled.
 *
 * Container: mp4 preferred, BUT Chrome's isTypeSupported can report mp4 while
 * the H.264 encoder silently produces zero bytes (observed in headless /
 * SwiftShader). An empty mp4 result auto-retries once as WebM.
 * @param {{ durationS?: number, fps?: number, direction?: 'left'|'right',
 *           ease?: boolean, onProgress?: (frac: number) => void }} opts
 * @returns {Promise<{ blob: Blob, ext: string, mime: string } | null>}
 */
export async function recordTurntable(opts = {}) {
  if (_recording) return null;
  if (typeof MediaRecorder !== 'function') {
    throw new Error('MediaRecorder not supported in this browser');
  }
  const fmt = pickVideoFormat((m) => MediaRecorder.isTypeSupported(m));
  const result = await _recordOnce(fmt, opts);
  if (result && result.blob.size === 0 && fmt.ext === 'mp4') {
    console.warn('mp4 recording came back empty — retrying as WebM');
    const webm = pickVideoFormat((m) =>
      m.startsWith('video/webm') && MediaRecorder.isTypeSupported(m));
    return _recordOnce(webm, opts);
  }
  return result;
}

function _recordOnce(fmt, { durationS = 8, fps = 30, direction = 'left',
                            ease = true, onProgress } = {}) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();
  if (!engine || !scene || !camera) return Promise.reject(new Error('Scene not ready'));

  const canvas = engine.getRenderingCanvas();
  const durationMs = Math.max(1, durationS) * 1000;

  _recording = true;
  return new Promise((resolve, reject) => {
    const startPose = SceneManager.saveCameraState();
    const stream = canvas.captureStream(fps);
    const rec = fmt.mime
      ? new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 16_000_000 })
      : new MediaRecorder(stream, { videoBitsPerSecond: 16_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

    let cancelled = false;
    let settled = false;
    let watchdog = null;
    let sweep = null;

    const cleanup = () => {
      sweep?.cancel();   // idempotent — restores camera/lights/env
      clearTimeout(watchdog);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.style.pointerEvents = '';
      for (const t of stream.getTracks()) t.stop();
      SceneManager.restoreCameraState(startPose);
      _recording = false;
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelled = true;
        if (rec.state !== 'inactive') rec.stop();
      }
    };
    // Hidden tab = paused rAF = frozen render loop: the sweep would stall
    // and the recording would never finish. Cancel instead of hanging.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cancelled = true;
        if (rec.state !== 'inactive') rec.stop();
        else settle(resolve, null);
      }
    };

    const finish = () => {
      if (cancelled) { settle(resolve, null); return; }
      const mime = fmt.mime ? fmt.mime.split(';')[0] : (rec.mimeType || 'video/webm').split(';')[0];
      settle(resolve, { blob: new Blob(chunks, { type: mime }), ext: fmt.ext, mime });
    };
    rec.onstop = finish;
    rec.onerror = (e) => settle(reject, e.error ?? new Error('MediaRecorder error'));
    // A broken encoder can go inactive without ever firing onstop/onerror —
    // resolve with whatever arrived rather than hanging forever.
    watchdog = setTimeout(finish, durationMs + 8000);

    // Shared sweep drives camera + lights (+ env) from wall-clock time inside
    // the render loop; the recorder samples whatever the loop produces.
    sweep = _startSweep({
      durationS, direction, ease, onProgress,
      onComplete: () => { if (rec.state === 'recording') rec.stop(); },
    });

    canvas.style.pointerEvents = 'none';     // lock nav — the camera is scripted
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    rec.start(250);                          // collect in 250 ms chunks
  });
}
