// Turntable video recorder — offline WebCodecs encode ONLY, with a direct
// RTT-pixels → VideoFrame feed — no per-frame PNG encode/decode round-trip
// (perf audit). The MediaRecorder fallback was REMOVED: it hard-freezes the
// renderer on Chrome 149 and in all headless Chromium, so it was never a
// safe fallback.

import { SceneManager } from '../SceneManager.js';
import { clampDimension, turntableProgress } from './RenderMath.js';
import { createSweepRig } from './SweepRig.js';
import {
  createFrameTarget, renderSceneToTarget, flipRows, waitReady, hideFurniture,
} from './FrameCapture.js';

let _recording = false;
let _abortRecord = null;   // (reason) => void while a recording is in flight

/** @returns {boolean} a turntable recording is in flight */
export function isRecording() { return _recording; }

/** Kill an in-flight recording on project switch — camera NOT restored (new project's camera wins). */
export function cancelForProjectSwitch() { _abortRecord?.('project'); }

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
  const restoreFurniture = hideFurniture();   // presentation render — no grid/axes
  SceneManager.suspendFollow(true);   // the sweep scripts camera.target — follow must not fight it
  const rig = createSweepRig();
  const sign = direction === 'right' ? -1 : 1;
  const usPerFrame = 1_000_000 / fps;
  const texture = createFrameTarget(scene, camera, w, h);
  const raw     = new Uint8Array(w * h * 4);   // reused across all frames
  const flipped = new Uint8Array(w * h * 4);

  try {
    await waitReady(texture, camera);
    for (let i = 0; i < frameCount; i++) {
      if (cancelled) return null;
      if (encError) throw encError;
      // i/frameCount (not count−1): the last frame sits just short of 360°,
      // so the video loops cleanly back onto its first frame.
      rig.applyDelta(sign * 2 * Math.PI * turntableProgress(i / frameCount, ease));
      renderSceneToTarget(scene, engine, camera, texture, w, h);
      await texture.readPixels(0, 0, raw, false);
      flipRows(raw, flipped, w, h);
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
