// Live mesh-stats readout in the status-bar centre segment. The triangle
// budget line (`tris <scene> / <budget>`, watertight-repair-and-cost task 7)
// is ALWAYS on — it is a scene-wide perf guard, not a selection stat — and
// gains `hud-warn` / `hud-danger` classes as the scene approaches
// `caps.triangleBudget`. The selection's own triangle count, real-world
// bounding dims (mm, print-space W×D×H), and watertight state append ONLY
// when something is selected: `tris <scene> / <budget> · sel <selTris> ·
// <dims> mm · <watertight>`. Uses the existing centre segment, so it adds
// zero new UI chrome.
//
// Perf (fix round 1, 2026-09-18): the scene-wide total is a full scene.meshes
// walk, so it is CACHED and recomputed only on events that actually change
// scene geometry (mesh add/remove, undo/redo, repair-completion re-validate)
// — never on SELECTION_CHANGED, which fires constantly during interaction.
// Recomputes from a burst of geometry events (an N-part import) are coalesced
// into a single microtask-deferred walk.

import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { StatusBar } from './StatusBar.js';
import { getBabylonMesh } from '../core/AssetLoader.js';
import { countSceneTriangles, countContainerTriangles, formatTriCount, meshTriangles }
  from '../core/scene/TriangleCount.js';
import { caps } from '../core/storage/capabilities.js';
import { t } from '../i18n/index.js';

// Result types that mean "this geometry is not a closed, correctly wound
// solid". The validator has no 'error' severity tier (CIA F1), so the HUD
// badge reads the types.
const OPEN_GEOMETRY_TYPES = new Set(['holes', 'nonManifold', 'invertedNormals']);

// Thresholds are ratios of caps.triangleBudget (binding: warn >= 70%, danger >= 90%).
const WARN_RATIO = 0.7;
const DANGER_RATIO = 0.9;

// Events that change scene geometry (mesh count or a mesh's own triangle
// count) — the ONLY events allowed to trigger a scene.meshes re-walk.
// VALIDATION_COMPLETE is included because repairObject's fix-then-revalidate
// flow re-validates through here after a hole-fill actually changes the
// mesh's triangle count — there is no dedicated "repaired" event.
const GEOMETRY_EVENTS = [
  EVENTS.ASSET_INSTANTIATED,
  EVENTS.OBJECT_REMOVED,
  EVENTS.OBJECT_RESTORED,
  EVENTS.HISTORY_UNDONE,
  EVENTS.HISTORY_REDONE,
  EVENTS.VALIDATION_COMPLETE,
];

let _cachedSceneTris = 0;
let _recomputeScheduled = false;

export function init() {
  for (const ev of GEOMETRY_EVENTS) subscribe(ev, _queueRecompute);
  for (const ev of [EVENTS.SELECTION_CHANGED, ...GEOMETRY_EVENTS, EVENTS.LOCALE_CHANGED]) subscribe(ev, _render);
}

// M4: the live mesh for an id comes from the AssetLoader registry — the old
// scene.meshes scan could return an export clone (Mesh.clone copies the
// metadata reference, so it carries the same meshId) instead of the real one.
function _meshFor(id) {
  return getBabylonMesh(id) ?? null;
}

// M5: the counting itself lives in src/core/scene/TriangleCount.js so a core
// import path (AssetImport's pre-import budget check) no longer depends on a
// UI module. Re-exported here because tests and callers address these through
// MeshStats, and `_recomputeSceneTris` deliberately calls
// `MeshStats.countSceneTriangles` (not the bare import) so a test can spy on
// exactly how many real scene walks happen.
export { countSceneTriangles, countContainerTriangles, formatTriCount };

/** Re-walk the scene and cache the total. Only called (debounced) from geometry events. */
function _recomputeSceneTris() {
  const scene = SceneManager.getScene?.();
  // Indirect through the exported object, not the bare function, so tests can
  // spy on `MeshStats.countSceneTriangles` and observe exactly how many real
  // walks happen.
  _cachedSceneTris = scene ? MeshStats.countSceneTriangles(scene) : 0;
}

/** Coalesce a burst of geometry events (e.g. an N-part import) into ONE walk. */
function _queueRecompute() {
  if (_recomputeScheduled) return;
  _recomputeScheduled = true;
  queueMicrotask(() => {
    _recomputeScheduled = false;
    _recomputeSceneTris();
    _render();
  });
}

function _render() {
  const scene = SceneManager.getScene?.();
  if (!scene) return;
  const B = window.BABYLON;

  const budget = caps.triangleBudget || 0;
  const ratio = budget > 0 ? _cachedSceneTris / budget : 0;
  const hudClass = ratio >= DANGER_RATIO ? 'hud-danger' : ratio >= WARN_RATIO ? 'hud-warn' : '';

  let text = `${t('hud.tris')} ${formatTriCount(_cachedSceneTris)} / ${formatTriCount(budget)}`;

  const sel = getState().selection?.selectedIds ?? [];
  let selTris = 0, min = null, max = null;
  for (const id of sel) {
    const m = _meshFor(id);
    if (!m || !m.geometry) continue;
    selTris += meshTriangles(m);
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (!min) { min = bb.minimumWorld.clone(); max = bb.maximumWorld.clone(); }
    else { min = B.Vector3.Minimize(min, bb.minimumWorld); max = B.Vector3.Maximize(max, bb.maximumWorld); }
  }
  if (min) {
    // Print-space W×D×H: print X = Babylon X, depth = Babylon Z, height = Babylon Y.
    const d = max.subtract(min).scale(1000);   // BU → mm
    const mm = (n) => Math.round(n);

    // CIA F1: the validator NEVER emits severity 'error' — non-manifold
    // geometry is deliberately a warning (owner rule), so the old
    // `hasErrors(...)` test could only ever read "✓ watertight" and this
    // badge was blind. The verdict keys on result TYPES instead: any
    // holes / nonManifold / invertedNormals result means not watertight.
    const activeId = getState().selection?.activeId;
    const val = activeId ? getState().scene.validation?.[activeId] : null;
    const water = val?.results
      ? (val.results.some(r => OPEN_GEOMETRY_TYPES.has(r.type)) ? ` · ${t('hud.notWatertight')}` : ` · ${t('hud.watertight')}`)
      : '';

    text += ` · ${t('hud.sel')} ${formatTriCount(selTris)} · ${mm(d.x)}×${mm(d.z)}×${mm(d.y)} mm${water}`;
  }

  StatusBar.setCenter(text, { className: hudClass, title: t('hud.triangleBudget') });
}

export const MeshStats = { init, countSceneTriangles, countContainerTriangles, formatTriCount };
