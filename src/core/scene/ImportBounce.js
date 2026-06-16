// Bounce-in import animation (audit feature wave 2026-06-13): freshly
// instantiated meshes scale-pop into place (~260 ms, slight overshoot).
// Pure visual feel — the animation multiplies the mesh's own scaling and
// ends with an EXACT restore of the original vector. WHILE a bounce is in
// flight the live scaling is transient, so persistence calls
// settleImportBounce() before capturing transforms (a save mid-bounce would
// otherwise serialize the pop factor). Project loads never fire
// ASSET_INSTANTIATED (the restore path uses bindRestoredMesh), so bulk loads
// don't bounce by construction; imports, drops, duplicates and primitives do.
//
// The pop owns mesh.scaling only until something else sets it: if a gizmo /
// Properties / command changes the scaling mid-pop, the bounce YIELDS (stops
// touching it) and settle leaves the new value — so a scale set during the
// 260 ms window is never clobbered (audit bounce-wrinkle fix 2026-06-16).

import { EVENTS } from '../events.js';
import { subscribe } from '../StateManager.js';

const DURATION_MS = 260;
const START_SCALE = 0.6;

const EPS = 1e-6;

let _scene = null;
const _active = new Map();   // uniqueId → { mesh, orig, start, lastApplied }
let _observer = null;

// True when the mesh's live scaling no longer matches what the pop last wrote —
// i.e. a gizmo / Properties / command edit changed it. The bounce then YIELDS
// (stops touching scaling) so a scale set DURING the pop is never clobbered.
// Ratio rescale (RescaleObjectCommand) bakes into vertices + position, not node
// scaling, so it does not trip this — the pop and the ratio stay orthogonal.
function _scalingDiverged(mesh, applied) {
  if (!applied) return false;
  const s = mesh.scaling;
  return Math.abs(s.x - applied.x) > EPS
      || Math.abs(s.y - applied.y) > EPS
      || Math.abs(s.z - applied.z) > EPS;
}

export function initImportBounce(scene) {
  _scene = scene;
  // Accessibility: skip the pop entirely for reduced-motion users.
  if (typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  subscribe(EVENTS.ASSET_INSTANTIATED, ({ meshId }) => _bounce(meshId));
}

/**
 * Snap every in-flight bounce to its true resting scale immediately and stop
 * the animation. The pop multiplies the live node scaling, so a save captured
 * mid-bounce would serialize that transient factor (a duplicate saved during
 * its pop reloaded permanently shrunk — audit dup-reload bug 2026-06-16).
 * Persistence calls this before capturing transforms so saved state always
 * reflects resting scale.
 */
export function settleImportBounce() {
  for (const [id, anim] of _active) {
    // Snap the pop to its resting scale — UNLESS something set the scaling
    // during the pop, in which case leave the user's value (don't restore orig).
    if (!anim.mesh.isDisposed?.() && !_scalingDiverged(anim.mesh, anim.lastApplied)) {
      anim.mesh.scaling.copyFrom(anim.orig);
    }
    _active.delete(id);
  }
  if (_observer && _scene) {
    _scene.onBeforeRenderObservable.remove(_observer);
    _observer = null;
  }
}

// easeOutBack — overshoots to ~1.10 then settles at exactly 1.
function _easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function _bounce(meshId) {
  if (!_scene || !meshId) return;
  const mesh = _scene.meshes.find(m => m.metadata?.meshId === meshId);
  if (!mesh) return;
  const existing = _active.get(mesh.uniqueId);
  // Restart cleanly if the same mesh bounces again before settling — orig
  // must stay the true resting scale, not a mid-bounce sample. lastApplied
  // carries over (or seeds to orig) so a restart isn't seen as divergence.
  const orig = existing ? existing.orig : mesh.scaling.clone();
  _active.set(mesh.uniqueId, {
    mesh, orig,
    start: performance.now(),
    lastApplied: existing?.lastApplied ?? orig.clone(),
  });

  if (!_observer) {
    _observer = _scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      for (const [id, anim] of _active) {
        if (anim.mesh.isDisposed?.()) { _active.delete(id); continue; }
        // Yield if anything else changed the scaling mid-pop — leave it be.
        if (_scalingDiverged(anim.mesh, anim.lastApplied)) { _active.delete(id); continue; }
        const t = (now - anim.start) / DURATION_MS;
        if (t >= 1) {
          anim.mesh.scaling.copyFrom(anim.orig);   // exact landing — no drift
          _active.delete(id);
          continue;
        }
        const f = START_SCALE + (1 - START_SCALE) * _easeOutBack(t);
        anim.mesh.scaling.copyFrom(anim.orig).scaleInPlace(f);
        anim.lastApplied = anim.mesh.scaling.clone();
      }
      if (_active.size === 0) {
        _scene.onBeforeRenderObservable.remove(_observer);
        _observer = null;
      }
    });
  }
}
