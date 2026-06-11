import { undo, redo, push, TransformCommand, VisibilityCommand, LockCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand } from './HistoryManager.js';
import { SceneManager, setCameraPreset } from './SceneManager.js';
import { Selection } from './Selection.js';
import { getState, dispatch } from './StateManager.js';
import { EVENTS } from './events.js';
import { Toast } from '../ui/Toast.js';
import { StatusBar } from '../ui/StatusBar.js';

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
let _rmbPending = null;   // pending context-menu request — committed on RMB-UP if not dragged
const RMB_DRAG_THRESHOLD_PX = 4;

// A press has to move farther than this before we promote it to a drag. Below
// the threshold the LMB-down behaves as a plain click (selection only).
const BODY_DRAG_THRESHOLD_PX = 4;

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

// ── Dispatcher ───────────────────────────────────────────

function _handleKeyDown(e) {
  if (_isTypingTarget(document.activeElement) && e.key !== 'Escape') return;

  if (_modal) {
    if (_handleModalKey(e)) e.preventDefault();
    return;  // block normal shortcuts during a modal op
  }

  const key = _buildKey(e);
  const fn  = _handlers.get(`${key}::${_currentContext}`) ?? _handlers.get(`${key}::global`);
  if (fn) { e.preventDefault(); fn(e); }
}

function _handleKeyUp(e) {
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
  _registerAll();
  document.addEventListener('keydown', _handleKeyDown);
  document.addEventListener('keyup',   _handleKeyUp);
  scene.onPointerObservable.add(_onPointer);

  if (_canvas) {
    _canvas.addEventListener('focus', () => setContext('viewport'));
    _canvas.addEventListener('blur',  () => setContext('global'));
    _canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

/** Inject the context-menu open handler from src/app/main.ts (avoids circular import). */
export function setContextMenuHandler(fn) {
  _onContextMenu = fn;
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
    return;
  }

  if (info.type === PointerEventTypes.POINTERDOWN) {
    if (_modal) {
      if (ev.button === 0)      _commitModal();
      else if (ev.button === 2) _cancelModal();
      return;
    }
    if (ev.button === 0) _onSelectionPointerDown(info);
    else if (ev.button === 2) {
      if (_bodyDrag) { _onBodyDragCancel(); return; }
      if (ev.shiftKey) { _placeCursorAtPick(); return; }
      // Defer the context menu until RMB-UP so RMB-drag can pan the camera
      // (Babylon ArcRotateCamera's panningMouseButton=2). If the pointer moved
      // past RMB_DRAG_THRESHOLD_PX before release, the menu is suppressed.
      _rmbPending = { x: ev.clientX, y: ev.clientY, info };
    }
  }

  if (info.type === PointerEventTypes.POINTERUP) {
    if (_bodyDrag && ev.button === 0) _onBodyDragUp();
    if (ev.button === 2 && _rmbPending) {
      _onContextMenuRMB(_rmbPending.info);
      _rmbPending = null;
    }
  }
}

function _onSelectionPointerDown(info) {
  const ev = info.event;

  // Probe the raw pick first. If we hit a non-meshId pickable (a gizmo arrow,
  // for example), leave the selection untouched so the gizmo can take over.
  const raw = _scene.pick(_scene.pointerX, _scene.pointerY);
  if (raw?.hit && raw.pickedMesh && !raw.pickedMesh.metadata?.meshId) {
    return;
  }

  const id = SceneManager.pickMeshIdAt(_scene.pointerX, _scene.pointerY);

  // Shift-click is a multi-select gesture — toggle and skip drag.
  if (ev.shiftKey) {
    if (id) Selection.toggle(id);
    else    /* clicking empty space with shift is a no-op */;
    return;
  }

  // Empty pick → clear selection. Nothing to drag.
  if (!id) {
    Selection.clear();
    return;
  }

  // Promote the picked mesh to active without disturbing an existing multi-
  // selection. If the click landed outside the current selection, single-select.
  if (!Selection.getSelectedIds().includes(id)) {
    Selection.set([id], id);
  } else if (Selection.getActiveId() !== id) {
    Selection.setActive(id);
  }

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
function _pickHorizontalPlaneAtPointer(y) {
  const cam = _scene.activeCamera;
  if (!cam) return null;
  const ray = _scene.createPickingRay(_scene.pointerX, _scene.pointerY, BABYLON.Matrix.Identity(), cam);
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  return ray.origin.add(ray.direction.scale(t));
}

function _onContextMenuRMB(info) {
  const ev = info.event;
  const id = SceneManager.pickMeshIdAt(_scene.pointerX, _scene.pointerY);
  if (id && !Selection.getSelectedIds().includes(id)) {
    Selection.set([id], id);
  }
  if (_onContextMenu) {
    _onContextMenu({ x: ev.clientX, y: ev.clientY, source: 'viewport' });
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
  const selected = Selection.getSelectedResolved();
  if (!selected.length) {
    Toast.show('Nothing selected', 'info', 2000);
    return;
  }
  // Detach gizmo pivot so meshes are in their canonical parents during the op
  // — we'll manipulate them directly and refresh after commit/cancel.
  SceneManager.attachToSelection([], 'median', null);

  const snapshots = {};
  let center = new BABYLON.Vector3(0, 0, 0);
  for (const { id, mesh } of selected) {
    mesh.computeWorldMatrix(true);
    snapshots[id] = _snapshotMesh(mesh);
    const ap = mesh.getAbsolutePosition();
    center.addInPlace(ap);
  }
  center.scaleInPlace(1 / selected.length);

  _modal = {
    op,
    axis: null,
    planar: null,
    typed: '',
    snap: false,
    snapshots,
    pivot: center,
    meshIds: selected.map(s => s.id),
    startX: _scene.pointerX,
    startY: _scene.pointerY,
  };

  document.body.classList.add(`modal-${op}`);
  _updateHint();
}

function _commitModal() {
  if (!_modal) return;
  const prev = _modal.snapshots;
  const next = _captureCurrent(_modal.meshIds);
  const same = _modalIsNoop(prev, next);
  _exitModal();
  if (!same) {
    push(new TransformCommand(prev, next, { alreadyApplied: true }));
  }
}

function _cancelModal() {
  if (!_modal) return;
  // Restore snapshots to revert any visual movement.
  for (const id of _modal.meshIds) {
    const mesh = _meshOf(id);
    if (!mesh) continue;
    _setMeshFromSnapshot(mesh, _modal.snapshots[id]);
  }
  _exitModal();
}

function _exitModal() {
  if (!_modal) return;
  document.body.classList.remove('modal-translate', 'modal-rotate', 'modal-scale');
  _modal = null;
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
  return v * 0.001;  // mm → BU (1 BU = 1 m at workingRatio = 1000 mm of print)
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
    const mesh = _meshOf(id);
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

function _applyRotate(dx, dy) {
  const m = _modal;
  const typed = _typedAsRotateRad();
  const angle = typed != null
    ? _maybeSnap(typed, 'rotate')
    : _maybeSnap(dx * ROTATE_PX_SENS, 'rotate');
  const axis = _axisVector(m.axis ?? 'Y');
  const q = BABYLON.Quaternion.RotationAxis(axis, angle);

  for (const id of m.meshIds) {
    const mesh = _meshOf(id);
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

function _applyScale(dx, dy) {
  const m = _modal;
  const typed = _typedAsScaleFactor();
  let factor = typed != null ? typed : 1 + (dx * SCALE_PX_SENS);
  if (factor < 0.001) factor = 0.001;
  if (m.snap) {
    const step = getState().gizmo.snap.scale;
    factor = Math.max(step, Math.round(factor / step) * step);
  }

  const axisMask = m.axis
    ? { x: m.axis === 'X' ? factor : 1, y: m.axis === 'Y' ? factor : 1, z: m.axis === 'Z' ? factor : 1 }
    : { x: factor, y: factor, z: factor };

  for (const id of m.meshIds) {
    const mesh = _meshOf(id);
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

function _maybeSnap(value, kind) {
  if (!_modal?.snap) return value;
  const snaps = getState().gizmo.snap;
  if (kind === 'translate') return Math.round(value / snaps.translate) * snaps.translate;
  if (kind === 'rotate')    return Math.round(value / (snaps.rotate * Math.PI / 180)) * (snaps.rotate * Math.PI / 180);
  if (kind === 'scale')     return Math.round(value / snaps.scale) * snaps.scale;
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

function _meshOf(id) {
  // Lazy import-style — avoid pulling AssetLoader into the static import graph.
  // SceneManager already exposes pickMeshIdAt; for mesh-by-id we resolve via Selection.
  for (const r of Selection.getSelectedResolved()) if (r.id === id) return r.mesh;
  // Fallback: search the scene by metadata
  if (!_scene) return null;
  for (const m of _scene.meshes) if (m.metadata?.meshId === id) return m;
  return null;
}

function _captureCurrent(meshIds) {
  const out = {};
  for (const id of meshIds) {
    const mesh = _meshOf(id);
    if (mesh) out[id] = _snapshotMesh(mesh);
  }
  return out;
}

function _modalIsNoop(prev, next) {
  for (const id of Object.keys(prev)) {
    const a = prev[id], b = next[id];
    if (!b) return false;
    for (const k of ['x', 'y', 'z']) {
      if (Math.abs(a.position[k] - b.position[k]) > 1e-9) return false;
      if (Math.abs(a.scaling[k]  - b.scaling[k])  > 1e-9) return false;
    }
    for (const k of ['x', 'y', 'z', 'w']) {
      if (Math.abs(a.rotation[k] - b.rotation[k]) > 1e-9) return false;
    }
  }
  return true;
}

// ── Status hint ──────────────────────────────────────────

function _defaultHint() {
  // Matches the implemented CAD scheme (§7): RMB orbit, MMB pan.
  return 'RMB: Orbit · MMB: Pan · Scroll: Zoom · G/R/S: Transform · F: Frame · Ctrl+G: Group';
}

function _updateHint() {
  if (!_modal) { StatusBar.setHint(_defaultHint()); return; }
  const m = _modal;
  const label = m.op === 'translate' ? 'Grab' : (m.op === 'rotate' ? 'Rotate' : 'Scale');
  const axis  = m.axis ? ` ${m.axis}` : (m.planar ? ` ⊥${m.planar}` : '');
  let valueStr;
  if (m.op === 'translate') {
    const v = _typedAsTranslateBU() ?? _currentTranslateAmount();
    valueStr = `${(v * 1000).toFixed(2)} mm`;
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
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  const prev = {};
  const objects = getState().scene.objects;
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
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  const objects = getState().scene.objects;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.locked;
  const anyUnlocked = ids.some(id => !objects[id]?.locked);
  push(new LockCommand(ids, prev, anyUnlocked));
}

function _deleteSelected() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
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
  push(new GroupCommand(ids));
  // Select the new group's children via their meshIds (groups aren't currently selectable).
  Selection.set(ids, ids[ids.length - 1]);
}

function _ungroupSelected() {
  // Pick the group(s) that contain selected meshes, ungroup each.
  const ids = Selection.getSelectedIds();
  const objects = getState().scene.objects;
  const groupIds = new Set();
  for (const id of ids) {
    const o = objects[id];
    if (o?.parentId) groupIds.add(o.parentId);
  }
  if (!groupIds.size) return;
  for (const gid of groupIds) push(new UngroupCommand(gid));
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

function _cyclePanels() {
  const panels = ['properties', 'shader', 'print'];
  const cur = getState().ui.activePanel ?? 'properties';
  const next = panels[(panels.indexOf(cur) + 1) % panels.length];
  dispatch(EVENTS.UI_PANEL_CHANGED, { panel: next });
}

const _noop = () => {};

function _registerAll() {
  // ── Global ─────────────────────────
  register('Ctrl+Z',       'global', () => undo());
  register('Ctrl+Shift+Z', 'global', () => redo());
  register('Ctrl+Y',       'global', () => redo());

  register('Ctrl+S',       'global', _noop);
  register('Ctrl+Shift+S', 'global', _noop);
  register('Ctrl+N',       'global', _noop);
  register('Ctrl+O',       'global', _noop);

  // ── Viewport: transforms ──────────
  register('G', 'viewport', () => _enterModal('translate'));
  register('R', 'viewport', () => _enterModal('rotate'));
  register('S', 'viewport', () => _enterModal('scale'));

  // ── Viewport: selection ───────────
  register('A',     'viewport', () => Selection.selectAll());
  register('Alt+A', 'viewport', () => Selection.clear());

  // ── Viewport: framing ─────────────
  register('F', 'viewport', _frameSelection);

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
  register('Tab', 'viewport', _cyclePanels);
  register('`',   'viewport', _toggleGizmoSpace);  // `~` shares key with backtick
  register('~',   'viewport', _toggleGizmoSpace);
  register('.',   'viewport', () => Selection.cyclePivotMode());
}

export const InputManager = { init, register, unregister, setContext, setContextMenuHandler };
