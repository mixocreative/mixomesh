// Live mesh-stats readout in the status-bar centre segment. The triangle
// budget line (`tris <current> / <budget>`, watertight-repair-and-cost task 7)
// is ALWAYS on — it is a scene-wide perf guard, not a selection stat — and
// gains `hud-warn` / `hud-danger` classes as the scene approaches
// `caps.triangleBudget`. Real-world bounding dims (mm, print-space W×D×H) and
// watertight state append ONLY when something is selected. Uses the existing
// centre segment, so it adds zero new UI chrome.

import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { StatusBar } from './StatusBar.js';
import { hasErrors } from '../core/MeshValidator.js';
import { caps } from '../core/storage/capabilities.js';
import { t } from '../i18n/index.js';

// Thresholds are ratios of caps.triangleBudget (binding: warn >= 70%, danger >= 90%).
const WARN_RATIO = 0.7;
const DANGER_RATIO = 0.9;

export function init() {
  for (const ev of [
    EVENTS.SELECTION_CHANGED,
    EVENTS.VALIDATION_COMPLETE,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.OBJECT_REMOVED,
  ]) subscribe(ev, _update);
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
 * relies on. Shared by the HUD readout and the pre-import budget check in
 * AssetImport.js so there is exactly one triangle-counting traversal.
 */
export function countSceneTriangles(scene) {
  if (!scene?.meshes) return 0;
  let tris = 0;
  for (const mesh of scene.meshes) {
    if (!mesh.metadata?.meshId) continue;
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

function _update() {
  const scene = SceneManager.getScene?.();
  if (!scene) return;
  const B = window.BABYLON;

  const sceneTris = countSceneTriangles(scene);
  const budget = caps.triangleBudget || 0;
  const ratio = budget > 0 ? sceneTris / budget : 0;
  const hudClass = ratio >= DANGER_RATIO ? 'hud-danger' : ratio >= WARN_RATIO ? 'hud-warn' : '';

  let text = `tris ${formatTriCount(sceneTris)} / ${formatTriCount(budget)}`;

  const sel = getState().selection?.selectedIds ?? [];
  let min = null, max = null;
  for (const id of sel) {
    const m = _meshFor(id, scene);
    if (!m || !m.geometry) continue;
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

    text += ` · ${mm(d.x)}×${mm(d.z)}×${mm(d.y)} mm${water}`;
  }

  StatusBar.setCenter(text, { className: hudClass, title: t('hud.triangleBudget') });
}

export const MeshStats = { init, countSceneTriangles, countContainerTriangles, formatTriCount };
