// Viewport hover highlight (overhaul 5.6, Decision 22, plan §4.7 "Hover").
// The item a click WOULD select (click-depth scope rule, PART 4b) gets a
// subtle ring through the third channel of the selection-outline mask, and
// the canvas cursor changes over it: `move` over a draggable body, `pointer`
// over a locked one (selectable, not transformable).
//
// Perf gates (Decision 22 "perf-gated"):
//   • ≤ 1 pick per rendered frame — pointer moves only record the latest
//     position; the pick runs in onBeforeRender (throttle).
//   • off while any button is held (camera drag, body drag, marquee) and
//     during a modal G/R/S op (InputManager suspends it).
//   • off when the scene is ≥ 70 % of caps.triangleBudget — MeshStats owns
//     the cached scene triangle total and flips `setBudgetExceeded`.
//
// Smoke flag: the hovered item id is mirrored on the canvas as
// `data-hover-id` (absent when nothing is hovered).

import { EVENTS } from './events.js';
import { getState, subscribe } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { Selection } from './Selection.js';
import { selectableAtDepth } from './LogicalObjects.js';
import { setHover as setHoverOutline } from './scene/SelectionOutline.js';

// ── Pure helpers (unit-tested in tests/box-select.test.mjs) ──────────────

/**
 * Item a click on `meshId` would select: the top-most item within `scope`, or
 * — when the mesh is outside the scope — the item at root (a click there
 * exits the scope first, Selection.resolveClick). No side effects.
 * @param {string|null|undefined} meshId
 * @param {object} sceneState  state.scene
 * @param {string|null} scope
 * @returns {string|null}
 */
export function hoverTarget(meshId, sceneState, scope) {
  if (meshId == null) return null;
  return selectableAtDepth(meshId, sceneState, scope)
    ?? (scope != null ? selectableAtDepth(meshId, sceneState, null) : null);
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

/**
 * Every pickable, enabled content mesh whose item (via `mapId`) is `itemId` —
 * all parts of a multi-part object, all members of a group.
 * @param {string} itemId
 * @param {Iterable<any>} meshes
 * @param {(meshId: string) => (string|null)} mapId
 * @returns {any[]}
 */
export function hoverMeshes(itemId, meshes, mapId) {
  const out = [];
  if (itemId == null) return out;
  for (const m of meshes ?? []) {
    if (m?.isPickable === false) continue;
    if (typeof m?.isEnabled === 'function' && !m.isEnabled()) continue;
    const id = _contentMeshId(m);
    if (!id) continue;
    if (mapId(id) === itemId) out.push(m);
  }
  return out;
}

/**
 * Cursor for a hovered item: '' (none), 'move' (draggable body) or 'pointer'
 * (locked — selectable but not transformable).
 * @param {string|null} itemId
 * @param {(id: string) => boolean} isLocked
 */
export function hoverCursor(itemId, isLocked) {
  if (itemId == null) return '';
  return isLocked(itemId) ? 'pointer' : 'move';
}

// ── Controller ───────────────────────────────────────────

let _scene = null;
let _canvas = null;
let _pending = null;          // { x, y } latest pointer position awaiting a pick
let _hoverId = null;
let _budgetExceeded = false;
let _suspended = false;

/**
 * Wire the per-frame pick and the clear-on-change subscriptions.
 * @param {any} scene  BABYLON.Scene
 */
export function init(scene) {
  _scene = scene;
  _canvas = scene.getEngine?.().getRenderingCanvas?.() ?? null;
  scene.onBeforeRenderObservable?.add(_tick);
  _canvas?.addEventListener?.('pointerleave', clear);
  // Geometry / project changes can dispose the hovered meshes — drop the ring
  // (the next pointer move re-picks).
  for (const ev of [
    EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE,
    EVENTS.PROJECT_NEW, EVENTS.PROJECT_LOADED, EVENTS.SCOPE_CHANGED, EVENTS.VISIBILITY_CHANGED,
    EVENTS.LOCK_CHANGED,
  ]) subscribe(ev, clear);
}

/**
 * Record a pointer move (canvas-relative px). `buttons` = PointerEvent.buttons;
 * any held button clears the hover (drags own the pointer).
 * @param {number} x @param {number} y @param {number} [buttons]
 */
export function request(x, y, buttons = 0) {
  if (_budgetExceeded || _suspended || buttons) { clear(); return; }
  _pending = { x, y };
}

/** Drop the hover ring + cursor immediately. */
export function clear() {
  _pending = null;
  _apply(null);
}

/**
 * Suspend hover while a modal op / drag owns the pointer (InputManager).
 * @param {boolean} on
 */
export function setSuspended(on) {
  _suspended = !!on;
  if (_suspended) clear();
}

/**
 * Perf gate from MeshStats: true when the scene is at/above 70 % of the
 * triangle budget — hover picking is then off entirely.
 * @param {boolean} exceeded
 */
export function setBudgetExceeded(exceeded) {
  _budgetExceeded = !!exceeded;
  if (_budgetExceeded) clear();
}

/** @returns {string|null} the hovered item id (object lead or group id). */
export function getHoverId() { return _hoverId; }

function _tick() {
  if (!_pending) return;
  const { x, y } = _pending;
  _pending = null;
  const meshId = SceneManager.pickMeshIdAt(x, y);
  const st = getState();
  _apply(hoverTarget(meshId, st.scene, Selection.getScope()));
}

function _apply(id) {
  if (id === _hoverId) return;
  _hoverId = id;
  let meshes = [];
  if (id != null && _scene) {
    const st = getState();
    const scope = Selection.getScope();
    meshes = hoverMeshes(id, _scene.meshes, (mid) => hoverTarget(mid, st.scene, scope));
  }
  setHoverOutline(meshes);
  // Babylon rewrites canvas.style.cursor = scene.defaultCursor on EVERY
  // pointer move, so the cursor must live in scene.defaultCursor; the direct
  // style write only makes it show before the next move.
  const cursor = hoverCursor(id, Selection.isEffectivelyLocked);
  if (_scene) _scene.defaultCursor = cursor;
  if (_canvas) {
    if (_canvas.style) _canvas.style.cursor = cursor;
    if (_canvas.dataset) {
      if (id != null) _canvas.dataset.hoverId = id;
      else delete _canvas.dataset.hoverId;
    }
  }
}

export const Hover = {
  init, request, clear, setSuspended, setBudgetExceeded, getHoverId,
  hoverTarget, hoverMeshes, hoverCursor,
};
