// Inverted / back-face highlight (Rodin-style inspection). Renders each content
// solid's BACK faces in red. Back faces are normally hidden inside the solid —
// so any RED visible from outside marks an inverted face or a hole (a print
// problem). Viewport overlay only.
//
// Same reliable mechanism as the cross-section fill: a shared-geometry CLONE
// per content mesh with a flat red unlit material rendering only the back faces
// (front culled via flipped sideOrientation). Clone is parent=null with the
// source world matrix baked + no metadata.meshId, so it's auto-excluded from
// clip / shadow / selection-mask / export. NO stencil → reliable on any GPU.

const BABYLON = window.BABYLON;

let _scene = null;
let _mat   = null;
let _on     = false;
const _clones = new Map();   // source mesh → red back-face clone

/** Call once from SceneManager.init. */
export function initBackfaceCheck(scene) { _scene = scene; }

function _ensureMat() {
  if (_mat) return _mat;
  const m = new BABYLON.StandardMaterial('mx-backface-mat', _scene);
  m.emissiveColor = new BABYLON.Color3(0.9, 0.12, 0.12);   // alarm red, unlit
  m.diffuseColor  = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = true;
  // Flip winding → render the source's BACK faces, cull the front (same trick
  // as the cross-section fill; assumes CCW-front imports).
  m.sideOrientation = BABYLON.Material.ClockWiseSideOrientation;
  _mat = m;
  return m;
}

function _isContent(mesh) {
  let node = mesh;
  while (node) { if (node.metadata?.meshId) return true; node = node.parent; }
  return false;
}

function _ensureClone(mesh) {
  if (_clones.has(mesh) || !mesh.geometry) return;
  if (mesh.metadata?.sectionPlaneViz || mesh.metadata?.backfaceViz) return;
  if (!_isContent(mesh)) return;
  const clone = mesh.clone(`mx-backface-${mesh.uniqueId}`, null, true);
  if (!clone) return;
  const s = new BABYLON.Vector3(), r = new BABYLON.Quaternion(), p = new BABYLON.Vector3();
  mesh.computeWorldMatrix(true).decompose(s, r, p);
  clone.parent = null;
  clone.position.copyFrom(p);
  clone.rotationQuaternion = r;
  clone.scaling.copyFrom(s);
  clone.material = _ensureMat();
  clone.isPickable = false;
  clone.metadata = { backfaceViz: true };   // no meshId → auto-excluded everywhere
  _clones.set(mesh, clone);
}

/** Build a red back-face clone for every content solid; prune dead sources. */
export function refreshBackfaceClones() {
  if (!_on || !_scene) return;
  for (const [src, clone] of _clones) {
    if (src.isDisposed?.()) { clone.dispose(); _clones.delete(src); }
  }
  for (const m of _scene.meshes) _ensureClone(m);
}

/** Toggle the inverted/back-face highlight overlay. */
export function setBackfaceCheck(on) {
  _on = !!on;
  if (!_scene) return;
  if (_on) {
    refreshBackfaceClones();
  } else {
    for (const [, clone] of _clones) { try { clone.dispose(); } catch { /* */ } }
    _clones.clear();
    if (_mat) { _mat.dispose(); _mat = null; }
  }
}

/** @returns {boolean} */
export function isBackfaceCheckOn() { return _on; }
