// Pivot session + gizmos (split from SceneManager.js — Blueprint §0.5 file-
// size budget, same pattern as SelectionOutline/BedGrid): the GizmoManager,
// the temp selectionPivot TransformNode that parents the selection during a
// drag (BLUEPRINT §7), gizmo drag → TransformCommand snapshots, and the LMB
// body-drag (ground-plane translate) that shares the same commit pipeline.
// SceneManager re-exports the public functions so its surface is unchanged.

import { getState, setState } from '../StateManager.js';

const BABYLON = window.BABYLON;

let _scene  = null;
let _gizmos = null;
let _getCursorPosition = null;   // injected — pivotMode 'cursor' anchor

// Pivot-based selection (see core/Selection.js + BLUEPRINT §7).
let _pivotNode          = null;
let _parentingSnapshots = [];   // [{ mesh, prevParent }]
let _selectedMeshes     = [];
let _activeMesh         = null;
let _currentPivotMode   = 'median';
let _dragSnapshot       = null;
let _bodyDragOriginPivot = null; // pivot world position at body-drag start
let _onTransformCommit  = null; // injected by src/app/main.ts to avoid circular imports

// ── Init ─────────────────────────────────────────────────

/**
 * Create the GizmoManager, wire drag observers, and apply the initial gizmo
 * mode/space from state.
 * @param {BABYLON.Scene} scene
 * @param {{ getCursorPosition: () => BABYLON.Vector3 }} deps
 */
export function initPivotSession(scene, { getCursorPosition }) {
  _scene = scene;
  _getCursorPosition = getCursorPosition;

  _gizmos = new BABYLON.GizmoManager(_scene);
  _gizmos.positionGizmoEnabled     = false;
  _gizmos.rotationGizmoEnabled     = false;
  _gizmos.scaleGizmoEnabled        = false;
  _gizmos.usePointerToAttachGizmos = false;
  _wireGizmoObservers();

  const gz = getState().gizmo;
  setGizmoMode(gz.mode);
  setGizmoSpace(gz.space);
}

/**
 * Register the callback invoked after a gizmo/body drag completes, with
 * `{ prev, next }` keyed by meshId. Wired in src/app/main.ts to push a
 * TransformCommand without creating a circular import here.
 */
export function setTransformCommitHandler(fn) {
  _onTransformCommit = fn;
}

// ── Gizmo manager ────────────────────────────────────────

function _wireGizmoObservers() {
  for (const name of ['positionGizmo', 'rotationGizmo', 'scaleGizmo']) {
    const sub = _gizmos.gizmos[name];
    if (!sub || sub._mixomeshWired) continue;
    sub.onDragStartObservable?.add(_onGizmoDragStart);
    sub.onDragEndObservable?.add(_onGizmoDragEnd);
    sub._mixomeshWired = true;
  }
}

function _enabledGizmoChanged() {
  // Babylon recreates the sub-gizmos when modes toggle. Re-attach observers.
  _wireGizmoObservers();
}

/**
 * @param {'translate'|'rotate'|'scale'|'none'} mode
 */
export function setGizmoMode(mode) {
  _gizmos.positionGizmoEnabled = mode === 'translate';
  _gizmos.rotationGizmoEnabled = mode === 'rotate';
  _gizmos.scaleGizmoEnabled    = mode === 'scale';
  _enabledGizmoChanged();
  // Babylon recreates the scale sub-gizmos when scaleGizmoEnabled flips on.
  // Re-apply the user's scale-lock preference so the per-axis arrows match
  // the Properties panel state.
  if (mode === 'scale') setScaleLock(getState().ui?.scaleLocked !== false);
  if (getState().gizmo.mode !== mode) {
    setState(s => ({ ...s, gizmo: { ...s.gizmo, mode } }), { silent: true });
  }
}

/**
 * Toggle proportional / per-axis scaling on the viewport scale gizmo.
 *
 * When `locked` is true, only the central uniform handle is shown — dragging
 * it scales every axis equally. When false, the per-axis arrows are restored
 * so the user can scale a single axis. Mirrors the Properties Panel lock UX.
 *
 * @param {boolean} locked
 */
export function setScaleLock(locked) {
  const sg = _gizmos?.gizmos?.scaleGizmo;
  if (!sg) return;
  const show = !locked;
  for (const key of ['xGizmo', 'yGizmo', 'zGizmo']) {
    const sub = sg[key];
    if (!sub) continue;
    sub.isEnabled = show;
  }
}

/** @param {'world'|'local'} space */
export function setGizmoSpace(space) {
  ['positionGizmo', 'rotationGizmo', 'scaleGizmo'].forEach(name => {
    const g = _gizmos.gizmos[name];
    if (g) g.updateGizmoRotationToMatchAttachedMesh = (space === 'local');
  });
  if (getState().gizmo.space !== space) {
    setState(s => ({ ...s, gizmo: { ...s.gizmo, space } }), { silent: true });
  }
  // Recompute pivot orientation if currently attached.
  if (_selectedMeshes.length) {
    attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
  }
}

// ── Pivot attach / detach ────────────────────────────────

/**
 * Compute the world position the pivot TransformNode should occupy for a
 * given pivot mode. Falls back to the median for unsupported modes.
 */
function _computePivotPosition(meshes, mode, activeMesh) {
  if (mode === 'world') {
    return BABYLON.Vector3.Zero();
  }
  if (mode === 'active' && activeMesh) {
    return activeMesh.getAbsolutePosition().clone();
  }
  if (mode === 'cursor') {
    return _getCursorPosition ? _getCursorPosition() : BABYLON.Vector3.Zero();
  }
  // 'median' / 'individual' (treated as median for Phase 3)
  let sum = new BABYLON.Vector3(0, 0, 0);
  meshes.forEach(m => { sum.addInPlace(m.getAbsolutePosition()); });
  return sum.scaleInPlace(1 / meshes.length);
}

function _detachPivot() {
  if (_pivotNode) {
    for (const { mesh, prevParent } of _parentingSnapshots) {
      mesh.setParent(prevParent ?? null);
    }
    _parentingSnapshots = [];
    _pivotNode.dispose();
    _pivotNode = null;
  }
  _selectedMeshes = [];
  _activeMesh = null;
}

/**
 * Attach the gizmo to a temp TransformNode pivot that parents every selected
 * mesh (preserving world transform). Subsequent gizmo drags move the pivot →
 * children inherit. On selection change, the pivot is detached and rebuilt.
 *
 * @param {any[]} meshes        Selected babylon meshes (resolved).
 * @param {'median'|'active'|'individual'|'cursor'} pivotMode
 * @param {any|null} [activeMesh]  The active (primary-selected) mesh.
 */
export function attachToSelection(meshes, pivotMode = 'median', activeMesh = null) {
  _detachPivot();
  if (!meshes || !meshes.length) {
    _gizmos.attachToMesh(null);
    return;
  }
  _currentPivotMode = pivotMode;
  _selectedMeshes   = meshes.slice();
  _activeMesh       = activeMesh ?? meshes[meshes.length - 1];

  _pivotNode = new BABYLON.TransformNode('selectionPivot', _scene);
  _pivotNode.position = _computePivotPosition(meshes, pivotMode, _activeMesh);

  const space = getState().gizmo.space;
  if (space === 'local' && _activeMesh) {
    _activeMesh.computeWorldMatrix(true);
    const aq = _activeMesh.absoluteRotationQuaternion;
    _pivotNode.rotationQuaternion = aq ? aq.clone() : BABYLON.Quaternion.Identity();
  } else {
    _pivotNode.rotationQuaternion = BABYLON.Quaternion.Identity();
  }

  for (const m of meshes) {
    if (m === _pivotNode) continue;
    _parentingSnapshots.push({ mesh: m, prevParent: m.parent ?? null });
    m.setParent(_pivotNode);
  }

  _gizmos.attachToMesh(_pivotNode);
}

// ── Gizmo drag → command ────────────────────────────────

function _snapshotAbsolute(meshes) {
  const out = {};
  for (const m of meshes) {
    const id = m.metadata?.meshId;
    if (!id) continue;
    m.computeWorldMatrix(true);
    const aq = m.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
    const ap = m.getAbsolutePosition();
    const as = m.absoluteScaling ?? m.scaling;
    out[id] = {
      position: { x: ap.x, y: ap.y, z: ap.z },
      rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
      scaling:  { x: as.x, y: as.y, z: as.z },
    };
  }
  return out;
}

function _onGizmoDragStart() {
  _dragSnapshot = _snapshotAbsolute(_selectedMeshes);
}

function _onGizmoDragEnd() {
  if (!_dragSnapshot) return;
  const prev = _dragSnapshot;
  const next = _snapshotAbsolute(_selectedMeshes);
  _dragSnapshot = null;
  if (_onTransformCommit) _onTransformCommit({ prev, next, alreadyApplied: true });
  // Rebuild pivot so it tracks the new median / active position for the next drag.
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
}

// ── Body drag (LMB on mesh body → ground-plane translate) ───────

/**
 * The Y coordinate the body-drag plane should be locked to — taken from the
 * active mesh's world position (or the first selected mesh as a fallback).
 * @returns {number} world Y in BU, or 0 when nothing is selected.
 */
export function getBodyDragPlaneY() {
  const m = _activeMesh ?? _selectedMeshes[0] ?? null;
  if (!m) return 0;
  return m.getAbsolutePosition().y;
}

/**
 * Begin a horizontal pivot drag. Returns false if there's no live pivot
 * (no selection) or another drag is already in progress.
 * @returns {boolean}
 */
export function beginBodyDrag() {
  if (!_pivotNode || !_selectedMeshes.length) return false;
  if (_dragSnapshot) return false;
  _dragSnapshot = _snapshotAbsolute(_selectedMeshes);
  _bodyDragOriginPivot = _pivotNode.position.clone();
  return true;
}

/**
 * Move the selection pivot by `delta` from its position at beginBodyDrag().
 * Caller is responsible for zero-ing the Y component if the drag should stay
 * on the horizontal plane.
 * @param {BABYLON.Vector3} delta
 */
export function setBodyDragOffset(delta) {
  if (!_pivotNode || !_bodyDragOriginPivot || !delta) return;
  _pivotNode.position.copyFrom(_bodyDragOriginPivot).addInPlace(delta);
}

/**
 * Finish a body drag — snapshot the new transforms, push the same
 * TransformCommand pipeline gizmo drags use, and re-anchor the pivot.
 */
export function endBodyDrag() {
  if (!_dragSnapshot) return;
  const prev = _dragSnapshot;
  const next = _snapshotAbsolute(_selectedMeshes);
  _dragSnapshot = null;
  _bodyDragOriginPivot = null;
  if (_onTransformCommit) _onTransformCommit({ prev, next, alreadyApplied: true });
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
}

/** Abort a body drag — revert the pivot to its origin and drop snapshots. */
export function cancelBodyDrag() {
  if (!_dragSnapshot) return;
  if (_pivotNode && _bodyDragOriginPivot) {
    _pivotNode.position.copyFrom(_bodyDragOriginPivot);
  }
  _dragSnapshot = null;
  _bodyDragOriginPivot = null;
}
