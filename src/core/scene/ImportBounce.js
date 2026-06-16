// Bounce-in import animation (audit feature wave 2026-06-13): freshly
// instantiated meshes scale-pop into place (~260 ms, slight overshoot).
// Pure visual feel — the animation multiplies the mesh's own scaling and
// ends with an EXACT restore of the original vector. WHILE a bounce is in
// flight the live scaling is transient, so persistence calls
// settleImportBounce() before capturing transforms (a save mid-bounce would
// otherwise serialize the pop factor). Project loads never fire
// ASSET_INSTANTIATED (the restore path uses bindRestoredMesh), so bulk loads
// don't bounce by construction; imports, drops, duplicates and primitives do.

import { EVENTS } from '../events.js';
import { subscribe } from '../StateManager.js';

const DURATION_MS = 260;
const START_SCALE = 0.6;

let _scene = null;
const _active = new Map();   // uniqueId → { mesh, orig, start }
let _observer = null;

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
    if (!anim.mesh.isDisposed?.()) anim.mesh.scaling.copyFrom(anim.orig);
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
  // must stay the true resting scale, not a mid-bounce sample.
  const orig = existing ? existing.orig : mesh.scaling.clone();
  _active.set(mesh.uniqueId, { mesh, orig, start: performance.now() });

  if (!_observer) {
    _observer = _scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      for (const [id, anim] of _active) {
        if (anim.mesh.isDisposed?.()) { _active.delete(id); continue; }
        const t = (now - anim.start) / DURATION_MS;
        if (t >= 1) {
          anim.mesh.scaling.copyFrom(anim.orig);   // exact landing — no drift
          _active.delete(id);
          continue;
        }
        const f = START_SCALE + (1 - START_SCALE) * _easeOutBack(t);
        anim.mesh.scaling.copyFrom(anim.orig).scaleInPlace(f);
      }
      if (_active.size === 0) {
        _scene.onBeforeRenderObservable.remove(_observer);
        _observer = null;
      }
    });
  }
}
