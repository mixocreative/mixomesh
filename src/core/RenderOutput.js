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

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
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
 * frame-by-frame encoder.
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
  };

  const restore = () => {
    SceneManager.restoreCameraState(startPose);
    if (key)  { key.direction = starts.keyDir;  key.position = starts.keyPos; }
    if (fill) fill.direction = starts.fillDir;
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot;
  };

  return { applyDelta, restore };
}

/**
 * Start a live sweep. Returns { cancel } — cancel stops early and restores.
 * onComplete fires exactly once with 'done' | 'cancelled'.
 */
function _startSweep({ durationS = 8, direction = 'left', ease = true,
                       onProgress, onComplete }) {
  const scene = SceneManager.getScene();
  const durationMs = Math.max(1, durationS) * 1000;
  const { applyDelta, restore } = _sweepRig();

  let startTs = 0;
  let finished = false;
  let observer = null;

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
 *
 * Primary path: OFFLINE WebCodecs encode — the sweep is stepped frame by
 * frame, each frame rendered into an RTT at the EXACT output resolution
 * (screen size irrelevant) and fed to a hardware VideoEncoder, muxed to mp4
 * by mp4-muxer. Deterministic (no dropped frames) and — crucially — it does
 * not touch MediaRecorder, which hard-freezes/crashes the renderer on
 * Chrome 149 (STATUS_BREAKPOINT) and in all headless Chromium.
 *
 * Fallback (no WebCodecs): realtime MediaRecorder capture of the live
 * canvas at viewport size. mp4 preferred, with an auto-retry as WebM when
 * the mp4 encoder silently produces zero bytes.
 *
 * Esc cancels either path; resolves null when cancelled.
 * @param {{ durationS?: number, fps?: number, direction?: 'left'|'right',
 *           ease?: boolean, width?: number, height?: number,
 *           onProgress?: (frac: number) => void }} opts
 * @returns {Promise<{ blob: Blob, ext: string, mime: string } | null>}
 */
export async function recordTurntable(opts = {}) {
  if (_recording) return null;
  if (typeof VideoEncoder === 'function') {
    try {
      return await _recordOffline(opts);
    } catch (err) {
      console.warn('WebCodecs offline encode failed — falling back to MediaRecorder:', err);
    }
  }
  if (typeof MediaRecorder !== 'function') {
    throw new Error('Neither WebCodecs nor MediaRecorder is available in this browser');
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
                                width = 1920, height = 1080, onProgress } = {}) {
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  if (!engine || !scene) throw new Error('Scene not ready');

  const w = clampDimension(width, 1920) & ~1;    // H.264 wants even dimensions
  const h = clampDimension(height, 1080) & ~1;
  const frameCount = Math.max(1, Math.round(Math.max(1, durationS) * fps));
  const config = await _pickAvcConfig(w, h, fps);
  if (!config) throw new Error(`H.264 encoding unsupported at ${w}×${h}`);

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
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled = true; }
  };
  window.addEventListener('keydown', onKey, true);
  const canvas = engine.getRenderingCanvas();
  canvas.style.pointerEvents = 'none';   // camera is scripted during the sweep
  const restoreFurniture = _hideFurniture();   // presentation render — no grid/axes
  const rig = _sweepRig();
  const sign = direction === 'right' ? -1 : 1;
  const usPerFrame = 1_000_000 / fps;

  try {
    for (let i = 0; i < frameCount; i++) {
      if (cancelled) return null;
      if (encError) throw encError;
      // i/frameCount (not count−1): the last frame sits just short of 360°,
      // so the video loops cleanly back onto its first frame.
      rig.applyDelta(sign * 2 * Math.PI * turntableProgress(i / frameCount, ease));
      const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
        engine, scene.activeCamera, { width: w, height: h }, 'image/png');
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const frame = new VideoFrame(bitmap, {
        timestamp: Math.round(i * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      bitmap.close();
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
    window.removeEventListener('keydown', onKey, true);
    canvas.style.pointerEvents = '';
    rig.restore();
    restoreFurniture();
    _recording = false;
  }
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
