// Box / marquee / rubber-band selection. Drag the LEFT mouse button across
// empty viewport space to sweep a rectangle; every item at the current
// click-depth scope whose combined-AABB centre falls inside is selected
// (Shift-drag adds to the current selection).
//
// Two layers, kept separate so the only real logic stays unit-testable:
//   • meshIdsInRect()  — pure screen-space hit-test (projection injected)
//   • the controller    — DOM overlay + scene wiring, verified live in Chrome
//
// Risk note (BLUEPRINT §7): the marquee only starts on an EMPTY left-down, so
// it never competes with body-drag (left-down on a mesh) or camera nav (RMB
// orbit / MMB pan — left button is unused by the camera, see CameraRig.js).
// The overlay is a plain <div>; it never touches the Babylon RTT, so PNG /
// video / thumbnail export stay byte-identical (Mimaki fidelity lock).

import { Selection } from './Selection.js';
import { getState } from './StateManager.js';
import { selectableAtDepth } from './LogicalObjects.js';

const BABYLON = window.BABYLON;

// ── Pure hit-test ────────────────────────────────────────

/** Order the drag corners into a min/max rect. @returns {{x0,y0,x1,y1}} */
export function normRect({ sx, sy, ex, ey }) {
  return {
    x0: Math.min(sx, ex), y0: Math.min(sy, ey),
    x1: Math.max(sx, ex), y1: Math.max(sy, ey),
  };
}

/** Walk the parent chain for a registered meshId (mirrors SceneManager pick). */
function _contentMeshId(mesh) {
  let node = mesh;
  while (node) {
    const id = node.metadata?.meshId;
    if (id) return id;
    node = node.parent;
  }
  return null;
}

/** World-space bounding-box centre of a mesh. */
function _boundingCenter(mesh) {
  mesh.computeWorldMatrix?.(true);
  return mesh.getBoundingInfo().boundingBox.centerWorld;
}

/**
 * Content meshIds whose bounding-box centre projects inside the screen rect.
 * @param {Iterable} meshes   scene meshes
 * @param {{sx,sy,ex,ey}} rect  drag corners (any direction)
 * @param {(v:any)=>({x,y}|null)} project  world→screen (null = cull, e.g. behind camera)
 * @param {(m:any)=>any} [centerOf]  world centre of a mesh (injectable for tests)
 * @returns {string[]}  deduped meshIds
 */
export function meshIdsInRect(meshes, rect, project, centerOf = _boundingCenter) {
  const { x0, y0, x1, y1 } = normRect(rect);
  const hits = new Set();
  for (const m of meshes) {
    const id = _contentMeshId(m);
    if (!id) continue;
    if (m.isPickable === false) continue;
    if (typeof m.isEnabled === 'function' && !m.isEnabled()) continue;
    const p = project(centerOf(m));
    if (!p) continue;
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) hits.add(id);
  }
  return [...hits];
}

/** World-space AABB of a mesh as plain {min,max} xyz. */
function _worldBounds(mesh) {
  mesh.computeWorldMatrix?.(true);
  const bb = mesh.getBoundingInfo().boundingBox;
  const lo = bb.minimumWorld, hi = bb.maximumWorld;
  return { min: { x: lo.x, y: lo.y, z: lo.z }, max: { x: hi.x, y: hi.y, z: hi.z } };
}

/**
 * Scope-aware marquee hit-test (task 3.2, plan §4.5): every content mesh is
 * mapped to its selectable item at the current click depth via `mapId`
 * (null = outside the scope → ignored); an item is hit when the centre of the
 * COMBINED world AABB of all its pickable, enabled meshes projects inside the
 * rect. Item order = first-seen mesh order.
 * @param {Iterable} meshes
 * @param {{sx,sy,ex,ey}} rect
 * @param {(v:{x,y,z})=>({x,y}|null)} project
 * @param {(meshId:string)=>(string|null)} mapId
 * @param {(m:any)=>{min:{x,y,z},max:{x,y,z}}} [boundsOf]
 * @returns {string[]}
 */
export function itemIdsInRect(meshes, rect, project, mapId, boundsOf = _worldBounds) {
  const { x0, y0, x1, y1 } = normRect(rect);
  /** @type {Map<string, {min:{x,y,z},max:{x,y,z}}>} */
  const boxes = new Map();
  for (const m of meshes) {
    const meshId = _contentMeshId(m);
    if (!meshId) continue;
    if (m.isPickable === false) continue;
    if (typeof m.isEnabled === 'function' && !m.isEnabled()) continue;
    const item = mapId(meshId);
    if (item == null) continue;
    const b = boundsOf(m);
    const acc = boxes.get(item);
    if (!acc) { boxes.set(item, { min: { ...b.min }, max: { ...b.max } }); continue; }
    for (const k of ['x', 'y', 'z']) {
      acc.min[k] = Math.min(acc.min[k], b.min[k]);
      acc.max[k] = Math.max(acc.max[k], b.max[k]);
    }
  }
  const hits = [];
  for (const [item, { min, max }] of boxes) {
    const p = project({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 });
    if (!p) continue;
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) hits.push(item);
  }
  return hits;
}

// ── Controller ───────────────────────────────────────────

let _scene = null;
let _canvas = null;
let _overlay = null;     // the marquee <div>
let _box = null;         // { sx, sy, ex, ey, additive } in canvas-relative CSS px

/** @param {BABYLON.Scene} scene */
export function init(scene) {
  _scene = scene;
  _canvas = scene.getEngine().getRenderingCanvas();
}

/** @returns {boolean} a marquee drag is in progress. */
export function isActive() { return !!_box; }

/**
 * Begin a marquee at canvas-relative (x, y).
 * @param {number} x @param {number} y @param {boolean} additive  Shift held → add to selection
 */
export function begin(x, y, additive) {
  _box = { sx: x, sy: y, ex: x, ey: y, additive: !!additive };
  _ensureOverlay();
  _draw();
}

/** Extend the marquee to canvas-relative (x, y). */
export function update(x, y) {
  if (!_box) return;
  _box.ex = x; _box.ey = y;
  _draw();
}

/**
 * Finish the marquee: resolve hits and commit the selection. A near-zero drag
 * behaves like an empty click (clears, unless additive) so a stray micro-drag
 * doesn't surprise the user.
 */
export function end() {
  if (!_box) return;
  const box = _box;
  _box = null;
  _hide();

  const { x0, y0, x1, y1 } = normRect(box);
  const tiny = (x1 - x0) < 3 && (y1 - y0) < 3;
  // A plain click on empty space clears AND exits the click-depth scope.
  if (tiny) { if (!box.additive) { Selection.setScope(null); Selection.clear(); } return; }

  // Marquee respects the scope: top-most items within it (task 3.2).
  const scope = Selection.getScope();
  const hits = itemIdsInRect(_scene.meshes, box, projectToScreen,
    (meshId) => selectableAtDepth(meshId, getState().scene, scope));
  if (box.additive) {
    for (const id of hits) Selection.add(id);
  } else {
    Selection.set(hits, hits[hits.length - 1] ?? null);
  }
}

/** Abort the marquee without changing the selection (Escape / RMB). */
export function cancel() {
  _box = null;
  _hide();
}

/** Project a world point into canvas-relative CSS px (null when behind camera). */
export function projectToScreen(world) {
  const cam = _scene.activeCamera;
  if (!cam) return null;
  const w = _canvas.clientWidth || _canvas.width;
  const h = _canvas.clientHeight || _canvas.height;
  // Vector3.Project only reads x/y/width/height — a plain literal avoids
  // depending on BABYLON.Viewport being in the app's curated namespace.
  const vp = { x: 0, y: 0, width: w, height: h };
  // Cull points behind the camera: project to view space and check Z sign via
  // the dot of (point - camPos) with the forward direction.
  const fwd = cam.getForwardRay?.().direction;
  if (fwd) {
    const cp = cam.position;
    const dot = (world.x - cp.x) * fwd.x + (world.y - cp.y) * fwd.y + (world.z - cp.z) * fwd.z;
    if (dot <= 0) return null;
  }
  const v = new BABYLON.Vector3(world.x, world.y, world.z);
  const c = BABYLON.Vector3.Project(v, BABYLON.Matrix.Identity(), _scene.getTransformMatrix(), vp);
  return { x: c.x, y: c.y };
}

function _ensureOverlay() {
  if (_overlay) return;
  const host = document.getElementById('viewport');
  if (!host) return;
  _overlay = document.createElement('div');
  _overlay.className = 'box-select';
  _overlay.setAttribute('aria-hidden', 'true');
  host.appendChild(_overlay);
}

function _draw() {
  if (!_overlay || !_box) return;
  const { x0, y0, x1, y1 } = normRect(_box);
  const s = _overlay.style;
  s.display = 'block';
  s.left = `${x0}px`;
  s.top = `${y0}px`;
  s.width = `${x1 - x0}px`;
  s.height = `${y1 - y0}px`;
}

function _hide() {
  if (_overlay) _overlay.style.display = 'none';
}

export const BoxSelect = {
  init, isActive, begin, update, end, cancel,
  meshIdsInRect, itemIdsInRect, normRect, projectToScreen,
};
