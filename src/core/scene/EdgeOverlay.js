// Wireframe-edges overlay (split from SceneManager.js — audit C1 budget):
// per-mesh clone sharing the source geometry, drawn with a wireframe
// emissive material over the textured base (field report: edgesRenderer at
// epsilon 0.9 only showed sharp creases — users expect the full triangle
// wireframe WITH the texture still visible underneath).

const BABYLON = window.BABYLON;

let _scene = null;
const _state = { enabled: false, color: null };
const _overlays = new Map();   // meshId → overlay mesh
let _mat = null;

export function initEdgeOverlay(scene) {
  _scene = scene;
  _state.color = new BABYLON.Color3(1, 0.8, 0);
}

/** @returns {boolean} the edges overlay is currently on */
export function isEdgeOverlayEnabled() { return _state.enabled; }

/**
 * Update the wireframe edge color and re-apply if edges are currently enabled.
 * @param {string} hexColor  e.g. '#ffcc00'
 */
export function setWireframeEdgeColor(hexColor) {
  try {
    _state.color = BABYLON.Color3.FromHexString(hexColor);
  } catch {
    return;
  }
  if (_mat) _mat.emissiveColor = _state.color;
}

function _material() {
  if (!_mat) {
    _mat = new BABYLON.StandardMaterial('mx-edge-overlay', _scene);
    _mat.wireframe       = true;
    _mat.disableLighting = true;
    _mat.emissiveColor   = _state.color;
    _mat.diffuseColor    = new BABYLON.Color3(0, 0, 0);
    _mat.zOffset         = -1;   // pull lines toward the camera — no z-fighting
  }
  return _mat;
}

function _ensureOverlay(mesh) {
  const id = mesh.metadata?.meshId;
  if (!id) return;
  const existing = _overlays.get(id);
  if (existing && !existing.isDisposed?.()) return;
  _overlays.delete(id);   // stale (parent container disposed) — rebuild
  // Clone shares the source geometry (no copy); parenting to the source and
  // zeroing the local transform keeps it coincident through every move.
  const overlay = mesh.clone(`edges_${id}`, mesh, /*doNotCloneChildren*/ true);
  if (!overlay) return;
  overlay.position.set(0, 0, 0);
  overlay.rotationQuaternion = BABYLON.Quaternion.Identity();
  overlay.rotation?.set?.(0, 0, 0);
  overlay.scaling.set(1, 1, 1);
  overlay.material   = _material();
  overlay.isPickable = false;
  overlay.metadata   = { edgeOverlay: true };   // never a registered meshId
  _overlays.set(id, overlay);
}

function _disposeAll() {
  for (const o of _overlays.values()) {
    try { o.dispose(); } catch { /* parent may already be gone */ }
  }
  _overlays.clear();
}

/** Toggle the edges overlay; re-run on import while ON to cover new meshes. */
export function setWireframeEdgesMode(enabled) {
  _state.enabled = enabled;
  if (!enabled) { _disposeAll(); return; }
  for (const mesh of _scene.meshes) {
    if (!mesh.geometry || !mesh.metadata?.meshId) continue;
    _ensureOverlay(mesh);
  }
}
