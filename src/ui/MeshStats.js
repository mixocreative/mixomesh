// Live mesh-stats readout in the status-bar centre segment — the print-relevant
// numbers at a glance: triangle count, real-world bounding dims (mm, print-space
// W×D×H), and watertight state (from the validation cache). Selection-driven;
// empties when nothing is selected. Uses the existing centre segment, so it adds
// zero new UI chrome.

import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { StatusBar } from './StatusBar.js';
import { hasErrors } from '../core/MeshValidator.js';

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

function _update() {
  const scene = SceneManager.getScene?.();
  if (!scene) return;
  const B = window.BABYLON;
  const sel = getState().selection?.selectedIds ?? [];
  if (!sel.length) { StatusBar.setCenter(''); return; }

  let tris = 0, min = null, max = null;
  for (const id of sel) {
    const m = _meshFor(id, scene);
    if (!m || !m.geometry) continue;
    tris += (m.getTotalIndices?.() ?? 0) / 3;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (!min) { min = bb.minimumWorld.clone(); max = bb.maximumWorld.clone(); }
    else { min = B.Vector3.Minimize(min, bb.minimumWorld); max = B.Vector3.Maximize(max, bb.maximumWorld); }
  }
  if (!min) { StatusBar.setCenter(''); return; }

  // Print-space W×D×H: print X = Babylon X, depth = Babylon Z, height = Babylon Y.
  const d = max.subtract(min).scale(1000);   // BU → mm
  const mm = (n) => Math.round(n);
  const triStr = tris >= 100000 ? `${Math.round(tris / 1000)}k`
    : tris >= 1000 ? `${(tris / 1000).toFixed(1)}k`
    : `${Math.round(tris)}`;

  // Watertight = no error-severity validation results on the active mesh.
  const activeId = getState().selection?.activeId;
  const val = activeId ? getState().scene.validation?.[activeId] : null;
  const water = val?.results
    ? (hasErrors(val.results) ? ' · ⚠ not watertight' : ' · ✓ watertight')
    : '';

  StatusBar.setCenter(`△ ${triStr} · ${mm(d.x)}×${mm(d.z)}×${mm(d.y)} mm${water}`);
}

export const MeshStats = { init };
