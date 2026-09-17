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
import { hasErrors } from '../core/MeshValidator.js';
import { getBabylonMesh } from '../core/AssetLoader.js';
import { caps } from '../core/storage/capabilities.js';
import { t } from '../i18n/index.js';

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
  for (const ev of [EVENTS.SELECTION_CHANGED, ...GEOMETRY_EVENTS]) subscribe(ev, _render);
}

function _meshFor(id, scene) {
  return scene.meshes.find(m => m.metadata?.meshId === id) ?? null;
}

/** Per-mesh triangle count: getTotalIndices()/3, falling back to getIndices().length/3. */
function _meshTriangles(mesh) {
  if (!mesh || !mesh.geometry) return 0;
  const total = mesh.getTotalIndices?.();
  if (Number.isFinite(total)) return total / 3;
  const idx = mesh.getIndices?.();
  return Number.isFinite(idx?.length) ? idx.length / 3 : 0;
}

/**
 * Scene-wide triangle total across live print-part / imported meshes. Helper
 * overlays (3D cursor, cross-section stripe/cap, floor disc) carry no
 * `metadata.meshId` and are excluded — same rule `_meshFor` above already
 * relies on. Shared by the HUD readout (via the cache below) and the
 * pre-import budget check in AssetImport.js so there is exactly one
 * triangle-counting traversal. Called through `MeshStats.countSceneTriangles`
 * internally (not the bare function) so tests can spy on the live walk.
 *
 * Fix round 1 (2026-09-18, task 8 follow-up): a mesh carrying
 * `metadata.meshId` is not necessarily the LIVE registered mesh for that id
 * — `Mesh.clone()` copies the metadata reference, so a transient export
 * clone (`PrintPipeline`'s `${mesh.name}__export`) carries the SAME source
 * `meshId` while it exists in the scene. If a geometry event (export
 * validates its clones through the same `MeshValidator.validateMesh` →
 * `VALIDATION_COMPLETE` path a real edit uses) fires a re-walk while such a
 * clone is still alive, a naive `mesh.metadata?.meshId` filter double-counts
 * it alongside the real mesh (observed live: a 4-triangle repaired solid
 * read HUD "tris 8" — the export clone, present during its own validation
 * pass, was counted a second time). `MeshValidator.js`'s own cache-write
 * path guards the identical hazard with `AssetLoader.getBabylonMesh(meshId)
 * === mesh` (its `isLive` check) — this walk uses the same registry check
 * so only the CURRENTLY REGISTERED live mesh for an id is ever summed.
 */
export function countSceneTriangles(scene) {
  if (!scene?.meshes) return 0;
  let tris = 0;
  for (const mesh of scene.meshes) {
    const meshId = mesh.metadata?.meshId;
    if (!meshId || getBabylonMesh(meshId) !== mesh) continue;
    tris += _meshTriangles(mesh);
  }
  return tris;
}

/**
 * Triangle total across an AssetContainer's meshes — used BEFORE
 * `addAllToScene()`, when nothing has a meshId yet, so it sums every
 * geometry-bearing mesh unconditionally.
 */
export function countContainerTriangles(container) {
  if (!container?.meshes) return 0;
  let tris = 0;
  for (const mesh of container.meshes) tris += _meshTriangles(mesh);
  return tris;
}

/** Compact triangle-count formatting: 342 / 12.3k / 342k / 1.5M (one decimal for M). */
export function formatTriCount(n) {
  const v = Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

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

  let text = `tris ${formatTriCount(_cachedSceneTris)} / ${formatTriCount(budget)}`;

  const sel = getState().selection?.selectedIds ?? [];
  let selTris = 0, min = null, max = null;
  for (const id of sel) {
    const m = _meshFor(id, scene);
    if (!m || !m.geometry) continue;
    selTris += _meshTriangles(m);
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (!min) { min = bb.minimumWorld.clone(); max = bb.maximumWorld.clone(); }
    else { min = B.Vector3.Minimize(min, bb.minimumWorld); max = B.Vector3.Maximize(max, bb.maximumWorld); }
  }
  if (min) {
    // Print-space W×D×H: print X = Babylon X, depth = Babylon Z, height = Babylon Y.
    const d = max.subtract(min).scale(1000);   // BU → mm
    const mm = (n) => Math.round(n);

    // Watertight = no error-severity validation results on the active mesh.
    const activeId = getState().selection?.activeId;
    const val = activeId ? getState().scene.validation?.[activeId] : null;
    const water = val?.results
      ? (hasErrors(val.results) ? ' · ⚠ not watertight' : ' · ✓ watertight')
      : '';

    text += ` · sel ${formatTriCount(selTris)} · ${mm(d.x)}×${mm(d.z)}×${mm(d.y)} mm${water}`;
  }

  StatusBar.setCenter(text, { className: hudClass, title: t('hud.triangleBudget') });
}

export const MeshStats = { init, countSceneTriangles, countContainerTriangles, formatTriCount };
