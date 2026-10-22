import { undo, redo, push, TransformCommand, VisibilityCommand, LockCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand } from './HistoryManager.js';
import { SceneManager, setCameraPreset } from './SceneManager.js';
import { Selection } from './Selection.js';
import { BoxSelect } from './BoxSelect.js';
import { getState, dispatch } from './StateManager.js';
import { EVENTS } from './events.js';
import { logicalObjectCommandIds, isGroupId } from './LogicalObjects.js';
import { Toast } from '../ui/Toast.js';
import { StatusBar } from '../ui/StatusBar.js';
import { t } from '../i18n/index.js';
import { BU_TO_MM } from './PrintManager.js';
import { Hover, hoverTarget } from './Hover.js';
import { setGizmoSnap, isNoopTransform } from './scene/PivotSession.js';
import { touchOrbit, touchPan, touchPinch } from './scene/CameraRig.js';
import { createTouchGestures, TOUCH_LONG_PRESS_MS } from './TouchGestures.js';
import { isReadOnlyShortcut } from './ViewerModel.js';
import { translateSnapBU, rotateSnapRad, scaleSnapStep, snapToStep, nudgeStepMM, nudgeDirection } from './SnapUnits.js';

const BABYLON = window.BABYLON;
const PointerEventTypes = BABYLON.PointerEventTypes;

// Mouse → world translation sensitivity, in BU/pixel. Refined by camera radius.
const TRANSLATE_PX_SENS = 0.002;
const ROTATE_PX_SENS    = 0.005;  // rad / pixel
const SCALE_PX_SENS     = 0.005;  // factor / pixel

const _handlers = new Map();   // `${key}::${context}` → fn
let _currentContext = 'global';
let _scene  = null;
let _canvas = null;

let _modal = null;   // active modal G/R/S op (see _enterModal)
let _bodyDrag = null; // pending / active LMB-on-mesh-body drag (see _onSelectionPointerDown)
let _onContextMenu = null;
let _viewportToolHandler = null;
// Phone viewer (8.6): read-only blocks every edit path (shortcuts, body drag,
// touch body drag, context menu). Camera + selection stay.
let _readOnly = false;
let _rmbPending = null;   // pending context-menu request — committed on RMB-UP if not dragged
const RMB_DRAG_THRESHOLD_PX = 4;

// A press has to move farther than this before we promote it to a drag. Below
// the threshold the LMB-down behaves as a plain click (selection only).
const BODY_DRAG_THRESHOLD_PX = 4;

// Viewport double-click (task 3.2): two LMB POINTERDOWNs on the same
// scope-depth target, closer than this in time and distance. Detected on
// POINTERDOWN (not DOM dblclick) so it composes with body-drag / marquee.
const DOUBLE_CLICK_MS = 350;
const DOUBLE_CLICK_PX = 4;
let _lastClick = null;   // { t, x, y, target } of the previous plain LMB press on content
let _now = () => performance.now();

/** True when `cur` completes a double-click begun by `prev`. */
function _isDoubleClick(prev, cur) {
  if (!prev || !cur || prev.target == null || prev.target !== cur.target) return false;
  const dt = cur.t - prev.t;
  if (!(dt >= 0 && dt < DOUBLE_CLICK_MS)) return false;
  return Math.hypot(cur.x - prev.x, cur.y - prev.y) < DOUBLE_CLICK_PX;
}

// Touch (overhaul 8.4): pointerType 'touch' never takes the mouse path. A pure
// recogniser (core/TouchGestures.js) turns pointer events into orbit / pan /
// pinch / tap / doubletap / longpress; _onTouchGesture maps them onto the same
// selection, body-drag, context-menu and camera paths the mouse uses.
let _gest = createTouchGestures({ now: () => _now() });
let _touchBody = null;       // { itemId, planeY, startWorld, engaged } — one-finger drag on a selected movable item
let _lastTouchTap = null;    // item id of the previous tap (double-tap must hit the same depth target)
let _longPressTimer = null;
let _touchCam = { orbit: touchOrbit, pan: touchPan, pinch: touchPinch };

// ── Key string builder ───────────────────────────────────

function _buildKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey)  parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const isNumpad = e.code?.startsWith('Numpad');
  const key = isNumpad ? e.code : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);
  return parts.join('+');
}

function _isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * True when focus is somewhere viewport shortcuts should fire: nothing / body,
 * the 3D canvas, or the Outliner (rows are focusable). Text-entry elements are
 * always excluded, including the Outliner's rename and search inputs.
 */
function _isViewportKeyTarget(el) {
  if (_isTypingTarget(el)) return false;
  if (!el || el === document.body || el === document.documentElement) {
    // An open modal owns the keyboard even when focus has fallen back to body.
    return !document.querySelector?.('.modal-overlay:not(.hidden)');
  }
  if (el === _canvas) return true;
  return !!el.closest?.('#outliner');
}

// ── Dispatcher ───────────────────────────────────────────

function _handleKeyDown(e) {
  // Gizmo Ctrl-snap (overhaul 5.6): holding Ctrl snaps gizmo drags to the
  // same mm / deg / × steps as the G/R/S modal. Pointer events re-sync it.
  if (e.key === 'Control' || e.key === 'Meta') setGizmoSnap(true);
  if (_isTypingTarget(document.activeElement) && e.key !== 'Escape') return;

  if (_modal) {
    if (_handleModalKey(e)) e.preventDefault();
    return;  // block normal shortcuts during a modal op
  }

  // Esc priority (task 3.2): modal G/R/S (above) > body drag > marquee >
  // step out one click-depth scope level. At root Esc does nothing more.
  if (e.key === 'Escape' && _bodyDrag) { _onBodyDragCancel(); e.preventDefault(); return; }
  if (e.key === 'Escape' && BoxSelect.isActive()) { BoxSelect.cancel(); e.preventDefault(); return; }
  if (e.key === 'Escape' && _isViewportKeyTarget(document.activeElement) && Selection.exitScope()) {
    e.preventDefault();
    return;
  }

  const key = _buildKey(e);
  if (_readOnly && !isReadOnlyShortcut(key)) return;
  const ctx = _isViewportKeyTarget(document.activeElement) ? 'viewport' : _currentContext;
  const fn  = _handlers.get(`${key}::${ctx}`) ?? _handlers.get(`${key}::global`);
  if (fn) { e.preventDefault(); fn(e); }
}

function _handleKeyUp(e) {
  if (e.key === 'Control' || e.key === 'Meta') setGizmoSnap(false);
  if (_modal && (e.key === 'Control' || e.key === 'Meta')) {
    _modal.snap = false;
    _reapplyModal();
  }
}

// ── Public API ───────────────────────────────────────────

/**
 * Initialise input handling against a Babylon scene.
 * @param {BABYLON.Scene} scene
 */
export function init(scene) {
  _scene = scene;
  _canvas = scene.getEngine().getRenderingCanvas();
  BoxSelect.init(scene);
  Hover.init(scene);
  _registerAll();
  document.addEventListener('keydown', _handleKeyDown);
  document.addEventListener('keyup',   _handleKeyUp);
  // A Ctrl released while the window is unfocused never sends keyup.
  window.addEventListener?.('blur', () => setGizmoSnap(false));
  scene.onPointerObservable.add(_onPointer);

  if (_canvas) {
    _canvas.addEventListener('focus', () => setContext('viewport'));
    _canvas.addEventListener('blur',  () => setContext('global'));
    _canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Touch (8.4): the canvas owns every finger — no browser scroll / page
    // zoom / iOS callout or text selection on long-press. Safari's legacy
    // gesture* events still page-zoom without the preventDefault.
    const st = _canvas.style;
    if (st) {
      st.touchAction = 'none';
      st.userSelect = 'none';
      st.webkitUserSelect = 'none';
      st.webkitTouchCallout = 'none';
    }
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      _canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
    // Babylon does not route pointercancel; a cancelled finger must not leave
    // a half-finished orbit / body drag behind.
    _canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') _onTouchGestures(_gest.cancel(e.pointerId));
    });
  }
}

/** Inject the context-menu open handler from src/app/main.ts (avoids circular import). */
export function setContextMenuHandler(fn) {
  _onContextMenu = fn;
}

/** Give a temporary viewport tool first refusal on pointer events. */
export function setViewportToolHandler(fn) {
  _viewportToolHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Register a shortcut handler.
 * @param {string} shortcut  e.g. 'Ctrl+Z', 'G', 'Numpad1'
 * @param {'global'|'viewport'|'outliner'|'properties'} context
 * @param {function} callbackFn
 */
export function register(shortcut, context, callbackFn) {
  _handlers.set(`${shortcut}::${context}`, callbackFn);
}

/**
 * Read-only mode (phone viewer, 8.6): shortcuts outside the camera / select
 * allow-list, body drags and the context menu are ignored.
 * @param {boolean} on
 */
export function setReadOnly(on) {
  _readOnly = !!on;
  if (_readOnly) { _bodyDrag = null; _touchBody = null; _rmbPending = null; }
}

/** @returns {boolean} */
export function isReadOnly() { return _readOnly; }

/**
 * Unregister a shortcut.
 * @param {string} shortcut
 * @param {string} context
 */
export function unregister(shortcut, context) {
  _handlers.delete(`${shortcut}::${context}`);
}

/**
 * Set the active input context.
 * @param {'global'|'viewport'|'outliner'|'properties'} context
 */
export function setContext(context) {
  _currentContext = context;
}

// ── Pointer observable ───────────────────────────────────

function _onPointer(info) {
  if (!info?.event) return;
  const ev = info.event;
  if (_viewportToolHandler?.(info) === true) {
    ev.preventDefault?.();
    return;
  }

  if (ev.pointerType === 'touch') { _onTouchPointer(info); return; }

  // Keep gizmo Ctrl-snap in sync with the live modifier state (covers a Ctrl
  // pressed while focus was elsewhere, e.g. in another window).
  if (!_modal) setGizmoSnap(!!(ev.ctrlKey || ev.metaKey));

  if (info.type === PointerEventTypes.POINTERMOVE) {
    if (_rmbPending) {
      const dx = ev.clientX - _rmbPending.x;
      const dy = ev.clientY - _rmbPending.y;
      if (Math.abs(dx) > RMB_DRAG_THRESHOLD_PX || Math.abs(dy) > RMB_DRAG_THRESHOLD_PX) {
        _rmbPending = null;  // promoted to drag → Babylon pans, no menu
      }
    }
    if (_modal)        _onModalMouseMove(ev);
    else if (_bodyDrag) _onBodyDragMove();
    else if (BoxSelect.isActive()) BoxSelect.update(_scene.pointerX, _scene.pointerY);
    // Hover highlight (overhaul 5.6): throttled to ≤1 pick per frame inside
    // Hover; any held button (drag / orbit / pan / marquee) clears it.
    else Hover.request(_scene.pointerX, _scene.pointerY, ev.buttons ?? 0);
    return;
  }

  if (info.type === PointerEventTypes.POINTERDOWN) {
    Hover.clear();
    if (_modal) {
      if (ev.button === 0)      _commitModal();
      else if (ev.button === 2) _cancelModal();
      return;
    }
    if (ev.button === 0) _onSelectionPointerDown(info);
    else if (ev.button === 2) {
      if (BoxSelect.isActive()) { BoxSelect.cancel(); return; }
      if (_bodyDrag) { _onBodyDragCancel(); return; }
      if (ev.shiftKey) { _placeCursorAtPick(); return; }
      // Defer the context menu until RMB-UP so RMB-drag can pan the camera
      // (Babylon ArcRotateCamera's panningMouseButton=2). If the pointer moved
      // past RMB_DRAG_THRESHOLD_PX before release, the menu is suppressed.
      _rmbPending = { x: ev.clientX, y: ev.clientY, info };
    }
  }

  if (info.type === PointerEventTypes.POINTERUP) {
    if (BoxSelect.isActive() && ev.button === 0) { BoxSelect.end(); return; }
    if (_bodyDrag && ev.button === 0) _onBodyDragUp();
    if (ev.button === 2 && _rmbPending) {
      _onContextMenuRMB(_rmbPending.info);
      _rmbPending = null;
    }
  }
}

function _onSelectionPointerDown(info) {
  const ev = info.event;

  // No raw-pick pre-guard: gizmo arrows live in Babylon's utility layer and
  // are never returned by main-scene picks, so the old "leave selection for
  // the gizmo" early-return only ever fired on stray helper meshes — making
  // clicks on real content randomly dead (field report: selection buggy).
  // pickMeshIdAt's predicate now ignores everything without a meshId chain.
  const meshId = SceneManager.pickMeshIdAt(_scene.pointerX, _scene.pointerY);
  // Click-depth (task 3.2, plan §4.5): the pick maps to the top-most item
  // within the current scope (parts → lead; at root a top-level group or a
  // bare object). A pick outside the scope exits to root first.
  const id = meshId ? Selection.resolveClick(meshId) : null;

  // Modifier clicks (same contract as the Outliner): Shift = add to the
  // selection, Ctrl/Cmd = toggle. Both skip the body drag.
  if (ev.ctrlKey || ev.metaKey) {
    _lastClick = null;
    if (id) Selection.toggle(id);
    else    BoxSelect.begin(_scene.pointerX, _scene.pointerY, true);  // Ctrl-drag empty → additive marquee
    return;
  }
  if (ev.shiftKey) {
    _lastClick = null;
    if (id) Selection.add(id);
    else    BoxSelect.begin(_scene.pointerX, _scene.pointerY, true);  // Shift-drag empty → additive marquee
    return;
  }

  // Empty pick → start a marquee. A sub-threshold drag falls back to a plain
  // click (clears the selection + exits the scope) inside BoxSelect.end().
  if (!id) {
    _lastClick = null;
    BoxSelect.begin(_scene.pointerX, _scene.pointerY, false);
    return;
  }

  // Double-click on a group at the current depth → enter it and select the
  // child under the cursor. On an object a double-click is just a click.
  const click = { t: _now(), x: _scene.pointerX, y: _scene.pointerY, target: id };
  if (_isDoubleClick(_lastClick, click)) {
    _lastClick = null;
    if (isGroupId(id, getState().scene.groups) && Selection.enterScope(id, meshId)) {
      _canvas?.focus();
      return;
    }
  } else {
    _lastClick = click;
  }

  _promoteClicked(id);

  // Read-only viewer: selection only, never a body drag.
  if (_readOnly) { _canvas?.focus(); return; }

  // Stage a body drag. We don't engage the pivot until the pointer crosses
  // BODY_DRAG_THRESHOLD_PX so a plain click still reads as just-a-click.
  const planeY = SceneManager.getBodyDragPlaneY();
  const startWorld = _pickHorizontalPlaneAtPointer(planeY);
  if (startWorld) {
    _bodyDrag = {
      planeY,
      startWorld,
      startX: _scene.pointerX,
      startY: _scene.pointerY,
      engaged: false,
    };
  }

  _canvas?.focus();
}

// Promote the picked item to active without disturbing an existing multi-
// selection. If the click landed outside the current selection, single-select.
function _promoteClicked(id) {
  if (!Selection.contains(id)) {
    Selection.set([id], id);
  } else if (Selection.getActiveId() !== id) {
    Selection.setActive(id);
  }
}

// ── Touch (overhaul 8.4) ─────────────────────────────────

function _canvasLocal(x, y) {
  const r = _canvas?.getBoundingClientRect?.();
  return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
}

function _clearLongPress() {
  if (_longPressTimer != null) clearTimeout(_longPressTimer);
  _longPressTimer = null;
}

function _onTouchPointer(info) {
  const ev = info.event;
  const T = PointerEventTypes;
  const p = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: _now() };
  if (info.type === T.POINTERDOWN) {
    Hover.clear();
    const out = _gest.down(p);
    if (out.some(g => g.type === 'press')) {
      _clearLongPress();
      _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        _onTouchGestures(_gest.poll(_now()));
      }, TOUCH_LONG_PRESS_MS);
    }
    _onTouchGestures(out);
  } else if (info.type === T.POINTERMOVE) {
    _onTouchGestures(_gest.move(p));
  } else if (info.type === T.POINTERUP) {
    const out = _gest.up(p);
    if (_gest.count() === 0) _clearLongPress();
    _onTouchGestures(out);
  }
}

function _onTouchGestures(list) {
  for (const g of list ?? []) _onTouchGesture(g);
}

/**
 * Map one recognised gesture onto the mouse-equivalent action:
 *   press      → stage a body drag when it lands on a selected, unlocked item
 *   orbit      → body drag (staged) else camera orbit; never a marquee on touch
 *   pan/pinch  → camera pan / zoom towards the pinch centre
 *   tap        → click (click-depth mapping); doubletap → double-click
 *   longpress  → context menu at that point
 * During a modal G/R/S op a tap confirms, a long-press cancels.
 */
function _onTouchGesture(g) {
  if (g.type === 'press') {
    _touchBody = null;
    if (_modal) return;
    const l = _canvasLocal(g.x, g.y);
    const meshId = SceneManager.pickMeshIdAt(l.x, l.y);
    const id = meshId ? hoverTarget(meshId, getState().scene, Selection.getScope()) : null;
    if (id && !_readOnly && Selection.contains(id) && !Selection.isEffectivelyLocked(id)) {
      _touchBody = { itemId: id, planeY: 0, startWorld: null, engaged: false };
    }
    _canvas?.focus?.();
    return;
  }
  if (g.type === 'orbit') {
    if (_modal) return;
    if (g.phase === 'start' && _touchBody) _touchBodyBegin(g);
    if (_touchBody?.engaged) {
      if (g.phase === 'end') {
        if (g.interrupted || g.cancelled) SceneManager.cancelBodyDrag();
        else SceneManager.endBodyDrag();
        _touchBody = null;
      } else {
        _touchBodyMove(g);
      }
      return;
    }
    _touchBody = null;
    if (g.phase !== 'end') _touchCam.orbit(g.dx, g.dy);
    return;
  }
  if (g.type === 'pan' || g.type === 'pinch') {
    _touchBody = null;
    if (_modal) return;
    if (g.type === 'pan') _touchCam.pan(g.dx, g.dy);
    else {
      const l = _canvasLocal(g.x, g.y);
      _touchCam.pinch(g.scale, l.x, l.y);
    }
    return;
  }
  if (g.type === 'tap' || g.type === 'doubletap') {
    _touchBody = null;
    if (_modal) { if (g.type === 'tap') _commitModal(); return; }
    const l = _canvasLocal(g.x, g.y);
    _touchSelectAt(l.x, l.y, g.type === 'doubletap');
    return;
  }
  if (g.type === 'longpress') {
    _touchBody = null;
    _lastTouchTap = null;
    if (_modal) { _cancelModal(); return; }
    const l = _canvasLocal(g.x, g.y);
    _openContextMenuAt(l.x, l.y, g.x, g.y);
  }
}

function _touchBodyBegin(g) {
  const b = _touchBody;
  if (Selection.getActiveId() !== b.itemId) Selection.setActive(b.itemId);
  b.planeY = SceneManager.getBodyDragPlaneY();
  const s = _canvasLocal(g.startX, g.startY);
  b.startWorld = _pickHorizontalPlaneAtPointer(b.planeY, s.x, s.y);
  b.engaged = !!b.startWorld && SceneManager.beginBodyDrag();
  if (!b.engaged) _touchBody = null;   // nothing movable → the drag orbits instead
}

function _touchBodyMove(g) {
  const b = _touchBody;
  const l = _canvasLocal(g.x, g.y);
  const now = _pickHorizontalPlaneAtPointer(b.planeY, l.x, l.y);
  if (!now) return;
  const delta = now.subtract(b.startWorld);
  delta.y = 0;
  SceneManager.setBodyDragOffset(delta);
}

// Tap = mouse click at the same click depth (no marquee on touch); empty tap
// clears + exits the scope like an empty click. Double-tap on the same group
// enters it (mouse double-click rule, with the touch distance tolerance).
function _touchSelectAt(x, y, isDouble) {
  const meshId = SceneManager.pickMeshIdAt(x, y);
  const id = meshId ? Selection.resolveClick(meshId) : null;
  if (!id) {
    _lastTouchTap = null;
    Selection.setScope(null);
    Selection.clear();
    return;
  }
  if (isDouble && _lastTouchTap === id) {
    _lastTouchTap = null;
    if (isGroupId(id, getState().scene.groups) && Selection.enterScope(id, meshId)) return;
  } else {
    _lastTouchTap = id;
  }
  _promoteClicked(id);
}

function _onBodyDragMove() {
  if (!_bodyDrag) return;
  const dx = _scene.pointerX - _bodyDrag.startX;
  const dy = _scene.pointerY - _bodyDrag.startY;

  if (!_bodyDrag.engaged) {
    if (Math.hypot(dx, dy) < BODY_DRAG_THRESHOLD_PX) return;
    _bodyDrag.engaged = SceneManager.beginBodyDrag();
    if (!_bodyDrag.engaged) { _bodyDrag = null; return; }
  }

  const now = _pickHorizontalPlaneAtPointer(_bodyDrag.planeY);
  if (!now) return;
  const delta = now.subtract(_bodyDrag.startWorld);
  delta.y = 0;  // pin to the horizontal plane the drag started on
  SceneManager.setBodyDragOffset(delta);
}

function _onBodyDragUp() {
  const drag = _bodyDrag;
  _bodyDrag = null;
  if (drag?.engaged) SceneManager.endBodyDrag();
}

function _onBodyDragCancel() {
  if (_bodyDrag?.engaged) SceneManager.cancelBodyDrag();
  _bodyDrag = null;
}

/**
 * Cast a ray from the pointer onto a horizontal plane at world Y = `y`.
 * Returns `null` when the ray is parallel to the plane or points away from it.
 */
function _pickHorizontalPlaneAtPointer(y, px = _scene.pointerX, py = _scene.pointerY) {
  const cam = _scene.activeCamera;
  if (!cam) return null;
  const ray = _scene.createPickingRay(px, py, BABYLON.Matrix.Identity(), cam);
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  return ray.origin.add(ray.direction.scale(t));
}

function _onContextMenuRMB(info) {
  const ev = info.event;
  _openContextMenuAt(_scene.pointerX, _scene.pointerY, ev.clientX, ev.clientY);
}

// Shared by RMB-up and touch long-press: (x,y) canvas px for the pick,
// (clientX, clientY) viewport px for the menu position.
function _openContextMenuAt(x, y, clientX, clientY) {
  if (_readOnly) return;
  const { meshId, pick } = SceneManager.pickAt?.(x, y)
    ?? { meshId: SceneManager.pickMeshIdAt(x, y), pick: null };   // one pick, not two
  const id = meshId ? Selection.resolveClick(meshId) : null;   // same click-depth as LMB
  if (id && !Selection.contains(id)) {
    Selection.set([id], id);
  }
  if (_onContextMenu) {
    // Geometric FACE normal (useVerticesNormals = false): welded imports carry
    // smoothed vertex normals, and Place Face on Bed must land the clicked
    // facet flat, not a blend of its neighbours (review I2).
    const normal = pick?.hit ? pick.getNormal?.(true, false) : null;
    _onContextMenu({
      x: clientX, y: clientY, source: 'viewport',
      hit: !!id,   // false = empty space under the cursor (scene menu)
      faceNormal: normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
    });
  }
}

function _placeCursorAtPick() {
  // Prefer a real surface pick (mesh or ground) so cursor lands on geometry.
  // Falls back to the analytic ground-plane intersection so empty-space drops
  // still place the cursor on Y=0 instead of failing silently.
  const pick = _scene.pick(_scene.pointerX, _scene.pointerY, m => !!m && m.isPickable !== false);
  let point = (pick?.hit && pick.pickedPoint) ? pick.pickedPoint : null;
  if (!point) {
    const ray = _scene.createPickingRay(_scene.pointerX, _scene.pointerY, BABYLON.Matrix.Identity(), _scene.activeCamera);
    if (Math.abs(ray.direction.y) > 1e-6) {
      const t = -ray.origin.y / ray.direction.y;
      if (t >= 0) point = ray.origin.add(ray.direction.scale(t));
    }
  }
  if (!point) return;
  SceneManager.setCursor(point);
  SceneManager.setCursorVisible(true);
}

// ── Modal G / R / S ──────────────────────────────────────

function _enterModal(op) {
  const { targets, activeNode, activeGeometry, lockedSkipped } = Selection.getTransformTargets();
  if (!targets.length) {
    Toast.show(t(lockedSkipped ? 'toast.lockedNoTransform' : 'toast.nothingSelected'), 'info', 2000);
    return;
  }
  // Detach gizmo pivot so nodes are in their canonical parents during the op
  // — we'll manipulate them directly and refresh after commit/cancel.
  SceneManager.attachToSelection([], 'median', null);

  // Overhaul 2.2: a selected group's TransformNode is a target in its own
  // right (moves rigidly); anything under a selected ancestor is dropped so
  // nothing is transformed twice. Snapshots are keyed by NODE id.
  const top = SceneManager.topmostTransformTargets(targets, e => e.node);
  const snapshots = {};
  const nodes = new Map();
  for (const { id, node } of top) {
    nodes.set(id, node);
    snapshots[id] = _snapshotMesh(node);
  }

  // Same pivot rule as the gizmo (PivotSession.computePivotPosition).
  const pivotMode = getState().selection?.pivotMode ?? 'median';
  const pivot = SceneManager.computePivotPosition(top.map(e => e.node), pivotMode, activeNode, activeGeometry);

  _modal = {
    op,
    axis: null,
    planar: null,
    typed: '',
    snap: false,
    snapshots,
    pivot,
    nodes,
    meshIds: top.map(e => e.id),   // node ids (object meshIds + group ids)
    startX: _scene.pointerX,
    startY: _scene.pointerY,
  };

  document.body.classList.add(`modal-${op}`);
  Hover.setSuspended(true);
  _updateHint();
}

function _commitModal() {
  if (!_modal) return;
  const prev = _modal.snapshots;
  const next = _captureCurrent(_modal);
  const same = isNoopTransform(prev, next);
  _exitModal();
  if (!same) {
    push(new TransformCommand(prev, next, { alreadyApplied: true }));
  }
}

function _cancelModal() {
  if (!_modal) return;
  // Restore snapshots to revert any visual movement.
  for (const id of _modal.meshIds) {
    const mesh = _modal.nodes.get(id);
    if (!mesh) continue;
    _setMeshFromSnapshot(mesh, _modal.snapshots[id]);
  }
  _exitModal();
}

function _exitModal() {
  if (!_modal) return;
  document.body.classList.remove('modal-translate', 'modal-rotate', 'modal-scale');
  _modal = null;
  Hover.setSuspended(false);
  StatusBar.setHint(_defaultHint());
  Selection.refresh();
}

function _handleModalKey(e) {
  if (e.key === 'Escape') { _cancelModal(); return true; }
  if (e.key === 'Enter')  { _commitModal(); return true; }

  if (e.key === 'Control' || e.key === 'Meta') {
    _modal.snap = true;
    _reapplyModal();
    return true;
  }
  if (e.key === 'Backspace') {
    if (_modal.typed.length) _modal.typed = _modal.typed.slice(0, -1);
    _reapplyModal();
    return true;
  }

  const k = (e.key || '').toUpperCase();
  if (k === 'X' || k === 'Y' || k === 'Z') {
    if (e.shiftKey) {
      _modal.planar = _modal.planar === k ? null : k;
      _modal.axis = null;
    } else {
      _modal.axis = _modal.axis === k ? null : k;
      _modal.planar = null;
    }
    _reapplyModal();
    return true;
  }

  if (/^[\d.\-]$/.test(e.key)) {
    if (e.key === '-') {
      _modal.typed = _modal.typed.startsWith('-') ? _modal.typed.slice(1) : '-' + _modal.typed;
    } else if (e.key === '.' && _modal.typed.includes('.')) {
      // ignore second decimal
    } else {
      _modal.typed += e.key;
    }
    _reapplyModal();
    return true;
  }

  return false;
}

function _onModalMouseMove() {
  _reapplyModal();
}

function _reapplyModal() {
  if (!_modal) return;
  const dx = _scene.pointerX - _modal.startX;
  const dy = _scene.pointerY - _modal.startY;
  _applyModal(dx, dy);
  _updateHint();
}

function _applyModal(dx, dy) {
  const m = _modal;
  if (m.op === 'translate')      _applyTranslate(dx, dy);
  else if (m.op === 'rotate')    _applyRotate(dx, dy);
  else if (m.op === 'scale')     _applyScale(dx, dy);
}

function _typedAsTranslateBU() {
  if (!_modal.typed) return null;
  const v = parseFloat(_modal.typed);
  if (!Number.isFinite(v)) return null;
  return v / BU_TO_MM;  // mm → BU
}
function _typedAsRotateRad() {
  if (!_modal.typed) return null;
  const v = parseFloat(_modal.typed);
  if (!Number.isFinite(v)) return null;
  return v * Math.PI / 180;
}
function _typedAsScaleFactor() {
  if (!_modal.typed) return null;
  const v = parseFloat(_modal.typed);
  if (!Number.isFinite(v)) return null;
  return v;
}

function _applyTranslate(dx, dy) {
  const m = _modal;
  const typed = _typedAsTranslateBU();
  const cam = _scene.activeCamera;
  const camRadius = cam?.radius ?? 10;
  const worldPerPx = TRANSLATE_PX_SENS * (camRadius / 10);

  let delta;
  if (typed != null) {
    // Typed value drives axis-magnitude. Default to X if no axis chosen.
    const axisVec = _axisVector(m.axis ?? 'X');
    delta = axisVec.scale(_maybeSnap(typed, 'translate'));
  } else if (m.axis) {
    const axisVec = _axisVector(m.axis);
    const amount = _maybeSnap((dx + (-dy)) * worldPerPx, 'translate');
    delta = axisVec.scale(amount);
  } else if (m.planar) {
    // Planar: move in plane perpendicular to chosen axis.
    const along = _axisVector(m.planar);
    const camRight = cam.getDirection(BABYLON.Vector3.Right()).clone();
    const camUp    = cam.getDirection(BABYLON.Vector3.Up()).clone();
    const right    = camRight.subtract(along.scale(BABYLON.Vector3.Dot(camRight, along))); _normalize(right);
    const up       = camUp.subtract(along.scale(BABYLON.Vector3.Dot(camUp, along))); _normalize(up);
    const amtX = _maybeSnap(dx * worldPerPx, 'translate');
    const amtY = _maybeSnap(-dy * worldPerPx, 'translate');
    delta = right.scale(amtX).addInPlace(up.scale(amtY));
  } else {
    const camRight = cam.getDirection(BABYLON.Vector3.Right()).clone();
    const camUp    = cam.getDirection(BABYLON.Vector3.Up()).clone();
    const amtX = _maybeSnap(dx * worldPerPx, 'translate');
    const amtY = _maybeSnap(-dy * worldPerPx, 'translate');
    delta = camRight.scale(amtX).addInPlace(camUp.scale(amtY));
  }

  for (const id of m.meshIds) {
    const mesh = m.nodes.get(id);
    if (!mesh) continue;
    const snap = m.snapshots[id];
    const target = {
      position: { x: snap.position.x + delta.x, y: snap.position.y + delta.y, z: snap.position.z + delta.z },
      rotation: { ...snap.rotation },
      scaling:  { ...snap.scaling },
    };
    _setMeshFromSnapshot(mesh, target);
  }
}

function _applyRotate(dx, _dy) {
  const m = _modal;
  const typed = _typedAsRotateRad();
  const angle = typed != null
    ? _maybeSnap(typed, 'rotate')
    : _maybeSnap(dx * ROTATE_PX_SENS, 'rotate');
  const axis = _axisVector(m.axis ?? 'Y');
  const q = BABYLON.Quaternion.RotationAxis(axis, angle);

  for (const id of m.meshIds) {
    const mesh = m.nodes.get(id);
    if (!mesh) continue;
    const snap = m.snapshots[id];
    // Rotate position around pivot
    const rel = new BABYLON.Vector3(
      snap.position.x - m.pivot.x,
      snap.position.y - m.pivot.y,
      snap.position.z - m.pivot.z,
    );
    const rotated = new BABYLON.Vector3();
    rel.rotateByQuaternionToRef(q, rotated);
    const sq = new BABYLON.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w);
    const nq = q.multiply(sq);
    _setMeshFromSnapshot(mesh, {
      position: { x: rotated.x + m.pivot.x, y: rotated.y + m.pivot.y, z: rotated.z + m.pivot.z },
      rotation: { x: nq.x, y: nq.y, z: nq.z, w: nq.w },
      scaling:  { ...snap.scaling },
    });
  }
}

function _applyScale(dx, _dy) {
  const m = _modal;
  const typed = _typedAsScaleFactor();
  let factor = typed != null ? typed : 1 + (dx * SCALE_PX_SENS);
  if (factor < 0.001) factor = 0.001;
  if (m.snap) {
    const step = scaleSnapStep(getState().gizmo.snap);
    factor = Math.max(step, snapToStep(factor, step));
  }

  const axisMask = m.axis
    ? { x: m.axis === 'X' ? factor : 1, y: m.axis === 'Y' ? factor : 1, z: m.axis === 'Z' ? factor : 1 }
    : { x: factor, y: factor, z: factor };

  for (const id of m.meshIds) {
    const mesh = m.nodes.get(id);
    if (!mesh) continue;
    const snap = m.snapshots[id];
    _setMeshFromSnapshot(mesh, {
      position: {
        x: m.pivot.x + (snap.position.x - m.pivot.x) * axisMask.x,
        y: m.pivot.y + (snap.position.y - m.pivot.y) * axisMask.y,
        z: m.pivot.z + (snap.position.z - m.pivot.z) * axisMask.z,
      },
      rotation: { ...snap.rotation },
      scaling: {
        x: snap.scaling.x * axisMask.x,
        y: snap.scaling.y * axisMask.y,
        z: snap.scaling.z * axisMask.z,
      },
    });
  }
}

// Snap steps are persisted in user units (translate mm, rotate deg, scale ×)
// and converted to scene units in SnapUnits.js (overhaul 5.6).
function _maybeSnap(value, kind) {
  if (!_modal?.snap) return value;
  const snaps = getState().gizmo.snap;
  if (kind === 'translate') return snapToStep(value, translateSnapBU(snaps));
  if (kind === 'rotate')    return snapToStep(value, rotateSnapRad(snaps));
  if (kind === 'scale')     return snapToStep(value, scaleSnapStep(snaps));
  return value;
}

function _axisVector(axis) {
  if (axis === 'X') return new BABYLON.Vector3(1, 0, 0);
  if (axis === 'Y') return new BABYLON.Vector3(0, 1, 0);
  if (axis === 'Z') return new BABYLON.Vector3(0, 0, 1);
  return new BABYLON.Vector3(1, 0, 0);
}

function _normalize(v) {
  const l = v.length();
  if (l > 1e-9) v.scaleInPlace(1 / l);
  return v;
}

function _snapshotMesh(mesh) {
  mesh.computeWorldMatrix(true);
  const aq = mesh.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
  const ap = mesh.getAbsolutePosition();
  const as = mesh.absoluteScaling ?? mesh.scaling;
  return {
    position: { x: ap.x, y: ap.y, z: ap.z },
    rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
    scaling:  { x: as.x, y: as.y, z: as.z },
  };
}

function _setMeshFromSnapshot(mesh, snap) {
  const parent = mesh.parent;
  mesh.setParent(null);
  mesh.position.set(snap.position.x, snap.position.y, snap.position.z);
  mesh.rotationQuaternion = new BABYLON.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w);
  mesh.scaling.set(snap.scaling.x, snap.scaling.y, snap.scaling.z);
  mesh.setParent(parent);
}

function _captureCurrent(modal) {
  const out = {};
  for (const id of modal.meshIds) {
    const node = modal.nodes.get(id);
    if (node) out[id] = _snapshotMesh(node);
  }
  return out;
}

// ── Status hint ──────────────────────────────────────────

function _defaultHint() {
  // Single source: locale key (RMB orbit, MMB pan — the implemented CAD scheme, §7).
  return t('status.defaultHint');
}

function _updateHint() {
  if (!_modal) { StatusBar.setHint(_defaultHint()); return; }
  const m = _modal;
  const label = m.op === 'translate' ? 'Grab' : (m.op === 'rotate' ? 'Rotate' : 'Scale');
  const axis  = m.axis ? ` ${m.axis}` : (m.planar ? ` ⊥${m.planar}` : '');
  let valueStr;
  if (m.op === 'translate') {
    const v = _typedAsTranslateBU() ?? _currentTranslateAmount();
    valueStr = `${(v * BU_TO_MM).toFixed(2)} mm`;
  } else if (m.op === 'rotate') {
    const v = _typedAsRotateRad() ?? (_scene.pointerX - m.startX) * ROTATE_PX_SENS;
    valueStr = `${(v * 180 / Math.PI).toFixed(2)}°`;
  } else {
    const v = _typedAsScaleFactor() ?? (1 + (_scene.pointerX - m.startX) * SCALE_PX_SENS);
    valueStr = `×${v.toFixed(3)}`;
  }
  const snap = m.snap ? ' (snap)' : '';
  StatusBar.setHint(`${label}${axis}: ${valueStr}${snap} · LMB/Enter commit · Esc/RMB cancel`);
}

function _currentTranslateAmount() {
  if (!_modal) return 0;
  const dx = _scene.pointerX - _modal.startX;
  const dy = _scene.pointerY - _modal.startY;
  const cam = _scene.activeCamera;
  const camRadius = cam?.radius ?? 10;
  const worldPerPx = TRANSLATE_PX_SENS * (camRadius / 10);
  return (dx + (-dy)) * worldPerPx;
}

// ── Shortcut handlers ────────────────────────────────────

function _frameSelection() {
  const meshes = Selection.getSelectedResolved().map(r => r.mesh);
  if (!meshes.length) return;
  SceneManager.frameSelected(meshes);
}

function _hideSelected() {
  const objects = getState().scene.objects;
  const ids = logicalObjectCommandIds(Selection.getSelectedIds(), objects);
  if (!ids.length) return;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.visible;
  // Toggle: if all visible → hide; if any hidden → show all.
  const anyVisible = ids.some(id => objects[id]?.visible);
  push(new VisibilityCommand(ids, prev, !anyVisible));
}

function _unhideAll() {
  const objects = getState().scene.objects;
  const hidden = Object.values(objects).filter(o => o.visible === false).map(o => o.id);
  if (!hidden.length) return;
  const prev = {};
  for (const id of hidden) prev[id] = false;
  push(new VisibilityCommand(hidden, prev, true));
}

function _lockToggleSelected() {
  const objects = getState().scene.objects;
  const groups = getState().scene.groups;
  const sel = Selection.getSelectedIds();
  // Objects (expanded to all parts) AND selected groups toggle together.
  const ids = [...logicalObjectCommandIds(sel, objects), ...sel.filter(id => !objects[id] && groups[id])];
  if (!ids.length) return;
  const isLocked = id => !!(objects[id] ?? groups[id])?.locked;
  const prev = {};
  for (const id of ids) prev[id] = isLocked(id);
  const anyUnlocked = ids.some(id => !isLocked(id));
  push(new LockCommand(ids, prev, anyUnlocked));
}

function _deleteSelected() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  // Lock = transform-lock; Delete ASKS (Decision 9): a selection that holds a
  // locked object/group (or anything inside a locked group) needs a confirm.
  if (ids.some(id => Selection.isEffectivelyLocked(id))) {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'confirmAction',
      title: t('context.deleteLockedTitle'),
      body: t('context.deleteLockedBody'),
      confirmLabel: t('context.deleteLockedConfirm'),
      danger: true,
      onClose: (r) => { if (r === 'confirm') push(new DeleteCommand(ids)); },
    });
    return;
  }
  push(new DeleteCommand(ids));
}

function _duplicateSelected() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new DuplicateCommand(ids));
}

function _groupSelected() {
  const ids = Selection.getSelectedIds();
  if (ids.length < 1) return;
  const cmd = new GroupCommand(ids);
  push(cmd);
  // Groups are selectable (2.1): select the new group so one click/drag moves everything.
  if (getState().scene.groups[cmd.groupId]) Selection.set([cmd.groupId], cmd.groupId);
}

function _ungroupSelected() {
  // Selected groups dissolve; selected objects ungroup their parent group.
  const groupIds = UngroupCommand.targetsFor(Selection.getSelectedIds());
  if (!groupIds.length) return;
  push(new UngroupCommand(groupIds));
}

// ── Arrow-key nudge (overhaul 5.6, plan §4.7) ───────────
// Arrows move the selection 1 mm (Shift 10 mm, Alt 0.1 mm) along the world
// axis nearest the view direction; Ctrl+Up/Down moves vertically. Locked items
// are skipped (Decision 9) and the selection already respects the click-depth
// scope. One undoable TransformCommand per press.
function _nudge(e) {
  if (_modal || _bodyDrag || BoxSelect.isActive()) return;
  // The Outliner owns arrow keys while a row has focus (expand / collapse).
  if (document.activeElement?.closest?.('#outliner')) return;
  const cam = _scene?.activeCamera;
  if (!cam) return;
  const dir = nudgeDirection(e.key, !!(e.ctrlKey || e.metaKey), {
    right:   cam.getDirection(BABYLON.Vector3.Right()),
    forward: cam.getDirection(BABYLON.Vector3.Forward()),
    up:      cam.getDirection(BABYLON.Vector3.Up()),
  });
  if (!dir) return;
  const { targets, lockedSkipped } = Selection.getTransformTargets();
  if (!targets.length) {
    if (lockedSkipped) Toast.show(t('toast.lockedNoTransform'), 'info', 2000);
    return;
  }
  // Detach the gizmo pivot so nodes sit in their canonical parents, then drop
  // anything covered by a selected ancestor (no double move).
  SceneManager.attachToSelection([], 'median', null);
  const top = SceneManager.topmostTransformTargets(targets, en => en.node);
  const d = nudgeStepMM(e) / BU_TO_MM;
  const prev = {}, next = {};
  for (const { id, node } of top) {
    const snap = _snapshotMesh(node);
    prev[id] = snap;
    next[id] = {
      position: { x: snap.position.x + dir.x * d, y: snap.position.y + dir.y * d, z: snap.position.z + dir.z * d },
      rotation: { ...snap.rotation },
      scaling:  { ...snap.scaling },
    };
  }
  push(new TransformCommand(prev, next));   // applyTransforms re-attaches the pivot
}

function _toggleOrtho() {
  // In-place projection toggle preserving the current view direction (L25).
  SceneManager.toggleOrthographic();
}

function _orbitCamera(deltaDegH, deltaDegV) {
  if (!_scene?.activeCamera) return;
  const cam = _scene.activeCamera;
  cam.alpha += (deltaDegH * Math.PI) / 180;
  cam.beta  += (deltaDegV * Math.PI) / 180;
}

function _toggleGizmoSpace() {
  const cur = getState().gizmo.space;
  SceneManager.setGizmoSpace(cur === 'world' ? 'local' : 'world');
}

// Ctrl+I — Import model (same picker as the context menu / header Import).
// Dynamic import: ViewportDrop pulls in the asset pipeline, keep this module light.
function _importModel() {
  import('../ui/ViewportDrop.js')
    .then(m => m.ViewportDrop.promptImport())
    .catch(err => Toast.show(`${t('toast.operationFailed')}: ${err?.message ?? err}`, 'error'));
}

// F2 — inline-rename the active object/group in the Outliner. Dynamic import:
// the Outliner imports this module's neighbours, so a static edge would cycle.
function _renameActive() {
  if (!Selection.getActiveId()) return;
  import('../ui/Outliner.js').then(m => m.renameActive?.());
}

function _registerAll() {
  // ── Global ─────────────────────────
  register('Ctrl+Z',       'global', () => undo());
  register('Ctrl+Shift+Z', 'global', () => redo());
  register('Ctrl+Y',       'global', () => redo());
  register('Ctrl+I',       'global', _importModel);

  // Save / Save As / New / Open are registered by src/app/main.ts.

  // ── Viewport: transforms ──────────
  register('G', 'viewport', () => _enterModal('translate'));
  register('R', 'viewport', () => _enterModal('rotate'));
  register('S', 'viewport', () => _enterModal('scale'));

  // ── Viewport: selection ───────────
  register('A',     'viewport', () => Selection.selectAll());
  register('Alt+A', 'viewport', () => Selection.clear());
  register('F2',     'viewport', _renameActive);
  register('L',      'viewport', _lockToggleSelected);

  // ── Viewport: framing ─────────────
  register('F', 'viewport', _frameSelection);
  register('Home', 'viewport', () => SceneManager.frameAll());

  // ── Viewport: camera numpad ───────
  register('Numpad0',      'viewport', () => setCameraPreset('perspective'));
  register('Numpad1',      'viewport', () => setCameraPreset('front'));
  register('Numpad3',      'viewport', () => setCameraPreset('right'));
  register('Numpad7',      'viewport', () => setCameraPreset('top'));
  register('Ctrl+Numpad1', 'viewport', () => setCameraPreset('back'));
  register('Ctrl+Numpad3', 'viewport', () => setCameraPreset('left'));
  register('Ctrl+Numpad7', 'viewport', () => setCameraPreset('bottom'));
  register('Numpad5',      'viewport', _toggleOrtho);
  register('Numpad4',      'viewport', () => _orbitCamera(-15,  0));
  register('Numpad6',      'viewport', () => _orbitCamera( 15,  0));
  register('Numpad8',      'viewport', () => _orbitCamera(  0, -15));
  register('Numpad2',      'viewport', () => _orbitCamera(  0,  15));

  register('Alt+1',      'viewport', () => setCameraPreset('front'));
  register('Alt+3',      'viewport', () => setCameraPreset('right'));
  register('Alt+7',      'viewport', () => setCameraPreset('top'));
  register('Ctrl+Alt+1', 'viewport', () => setCameraPreset('back'));
  register('Ctrl+Alt+3', 'viewport', () => setCameraPreset('left'));
  register('Ctrl+Alt+7', 'viewport', () => setCameraPreset('bottom'));

  // ── Viewport: visibility / hierarchy ──
  register('H',            'viewport', _hideSelected);
  register('Alt+H',        'viewport', _unhideAll);
  register('Ctrl+G',       'viewport', _groupSelected);
  register('Ctrl+Shift+G', 'viewport', _ungroupSelected);
  register('Shift+D',      'viewport', _duplicateSelected);
  register('Delete',       'viewport', _deleteSelected);
  register('X',            'viewport', _deleteSelected);

  // ── Viewport: misc ────────────────
  register('`',   'viewport', _toggleGizmoSpace);  // `~` shares key with backtick
  register('~',   'viewport', _toggleGizmoSpace);
  register('.',   'viewport', () => Selection.cyclePivotMode());

  // ── Viewport: arrow-key nudge (overhaul 5.6) ──
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    for (const mod of ['', 'Shift+', 'Alt+']) register(`${mod}${key}`, 'viewport', _nudge);
  }
  for (const key of ['ArrowUp', 'ArrowDown']) {
    for (const mod of ['Ctrl+', 'Ctrl+Shift+', 'Ctrl+Alt+']) register(`${mod}${key}`, 'viewport', _nudge);
  }
}

export const InputManager = {
  init, register, unregister, setContext, setContextMenuHandler, setViewportToolHandler,
  setReadOnly, isReadOnly,
  // Test seam (tests/safety-commands.test.mjs) — not part of the app API.
  __test: {
    isViewportKeyTarget: _isViewportKeyTarget,
    registerAll: _registerAll,
    hasHandler: (shortcut, context) => _handlers.has(`${shortcut}::${context}`),
    clearHandlers: () => _handlers.clear(),
    setCanvas: (c) => { _canvas = c; },
    deleteSelected: _deleteSelected,
    lockToggleSelected: _lockToggleSelected,
    // Click-depth seams (tests/selection-scope.test.mjs).
    isDoubleClick: _isDoubleClick,
    selectionPointerDown: _onSelectionPointerDown,
    keyDown: _handleKeyDown,
    setScene: (sc) => { _scene = sc; },
    setNow: (fn) => { _now = typeof fn === 'function' ? fn : () => performance.now(); },
    resetClick: () => { _lastClick = null; },
    nudge: _nudge,
    // Touch seams (tests/touch-gestures.test.mjs).
    touchPointer: _onTouchPointer,
    touchPoll: () => _onTouchGestures(_gest.poll(_now())),
    setTouchCamera: (cam) => { _touchCam = cam ?? { orbit: touchOrbit, pan: touchPan, pinch: touchPinch }; },
    resetTouch: () => {
      _clearLongPress();
      _gest = createTouchGestures({ now: () => _now() });
      _touchBody = null;
      _lastTouchTap = null;
    },
  },
};
