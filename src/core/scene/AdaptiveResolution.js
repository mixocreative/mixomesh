// Adaptive viewport resolution (perf goal 2026-06-13: heavy 4096² / high-poly
// print scenes must stay responsive). Two parts:
//
//  1. A capped BASE hardware-scaling level. Babylon's adaptToDeviceRatio
//     renders at the full devicePixelRatio — on a 2× / 4K display that is 4×
//     the fragments, and with a few 4096²-textured 80k-tri meshes that tanks
//     the frame rate for marginal sharpness. We cap the effective DPR (default
//     1.5) so retina stays crisp without paying 2×.
//
//  2. A SAFETY-VALVE dynamic degrade. If the rolling average frame time blows
//     past a ceiling for a sustained stretch (genuine overload — orbiting a
//     very heavy scene), step the scaling up (fewer pixels) until it recovers,
//     then ease back toward the base. Conservative thresholds so normal use
//     never flickers.
//
// Exports / turntable video render into their own RTT at an explicit
// resolution (CreateScreenshotUsingRenderTarget overrides the engine render
// size), so canvas scaling here never affects output quality.

const DPR_CAP        = 1.5;    // never render above 1.5× device pixels
const DEGRADE_OVER_MS = 45;    // avg frame worse than this → shed pixels (~22 fps)
const RECOVER_UNDER_MS = 28;   // avg frame better than this → restore (~36 fps)
const WINDOW         = 45;     // frames per decision (~0.75 s at 60 fps)
const STEP           = 0.2;    // scaling-level increment per degrade
const MAX_LEVEL      = 2.0;    // hard floor = half-res each axis

let _engine = null;
let _base = 1;
let _level = 1;
let _samples = 0;
let _sum = 0;

/** @param {BABYLON.Engine} engine */
export function initAdaptiveResolution(engine) {
  _engine = engine;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  _base = 1 / Math.min(dpr, DPR_CAP);   // hardwareScalingLevel = 1/effectiveDPR
  _level = _base;
  engine.setHardwareScalingLevel(_level);
  // onEndFrameObservable is the reliable per-frame hook (runRenderLoop wraps
  // it). Guarded for engine stubs that lack it.
  engine.onEndFrameObservable?.add(_tick);
}

function _tick() {
  if (!_engine) return;
  _sum += _engine.getDeltaTime?.() ?? 16;
  if (++_samples < WINDOW) return;
  const avg = _sum / _samples;
  _samples = 0; _sum = 0;

  if (avg > DEGRADE_OVER_MS && _level < MAX_LEVEL) {
    _level = Math.min(MAX_LEVEL, _level + STEP);
    _engine.setHardwareScalingLevel(_level);
  } else if (avg < RECOVER_UNDER_MS && _level > _base) {
    _level = Math.max(_base, _level - STEP);
    _engine.setHardwareScalingLevel(_level);
  }
}

/** Current hardware-scaling level (smoke/diagnostics). */
export function getScalingLevel() { return _level; }
