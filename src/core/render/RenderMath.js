// Pure math + naming for render output (Scene ▸ Rendering). No Babylon, no
// DOM — headless tests exercise this directly (tests/render-output.test.mjs);
// core/RenderOutput.js and ui/RenderFrame.js consume it.

import { safeFilenameStem } from '../print/ExportPlanner.js';

/** Clamp + sanitise an output dimension. @returns {number} integer 16..8192 */
export function clampDimension(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(16, Math.min(8192, n));
}

/**
 * Eased turntable progress. t in [0,1] → progress in [0,1].
 * ease=true → sinusoidal ease-in-out (slow start, slow stop — reads well when
 * the video is played once; for endless GIF-style loops linear is the better
 * choice, hence the toggle).
 */
export function turntableProgress(t, ease) {
  const x = Math.max(0, Math.min(1, t));
  return ease ? 0.5 - Math.cos(Math.PI * x) / 2 : x;
}

// (turntableAlpha + pickVideoFormat were MediaRecorder-era helpers, removed
// 2026-06-16 audit-LOW cleanup. RenderOutput computes the camera delta inline
// from turntableProgress, and video is WebCodecs-only since 2026-06-13 — no
// MediaRecorder mime negotiation. Both were dead in production, test-only.)

/**
 * Aspect-fit the output frame inside the viewport with a uniform margin —
 * the darkening overlay rectangle (ui/RenderFrame.js).
 * @returns {{ left, top, width, height }} CSS px within the viewport
 */
export function fitFrameRect(viewportW, viewportH, outW, outH, marginFrac = 0.06) {
  const vw = Math.max(1, viewportW), vh = Math.max(1, viewportH);
  const availW = vw * (1 - 2 * marginFrac);
  const availH = vh * (1 - 2 * marginFrac);
  const aspect = clampDimension(outW, 1920) / clampDimension(outH, 1080);
  let w = availW, h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }
  return {
    left:   (vw - w) / 2,
    top:    (vh - h) / 2,
    width:  w,
    height: h,
  };
}

// ONE filename contract with the print exporters (Blueprint §12) — same stem
// sanitiser, so a renamed project flows into renders exactly like 3MF/OBJ.

/** PNG still filename — `<project>_render_<w>x<h>[_alpha].png` */
export function renderPngName(projectName, { width, height, transparent } = {}) {
  const w = clampDimension(width, 1920), h = clampDimension(height, 1080);
  return `${safeFilenameStem(projectName)}_render_${w}x${h}${transparent ? '_alpha' : ''}.png`;
}

/** Turntable filename — `<project>_turntable_<seconds>s.<ext>` */
export function turntableVideoName(projectName, durationS, ext) {
  const s = Number.isFinite(durationS) && durationS > 0 ? durationS : 8;
  return `${safeFilenameStem(projectName)}_turntable_${parseFloat(s.toFixed(1))}s.${ext || 'webm'}`;
}
