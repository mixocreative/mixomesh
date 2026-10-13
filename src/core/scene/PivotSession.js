// Pivot session + gizmos (split from SceneManager.js — Blueprint §0.5 file-
// size budget, same pattern as SelectionOutline/BedGrid): the GizmoManager,
// the temp selectionPivot TransformNode that parents the selection during a
// drag (BLUEPRINT §7), gizmo drag → TransformCommand snapshots, and the LMB
// body-drag (ground-plane translate) that shares the same commit pipeline.
// SceneManager re-exports the public functions so its surface is unchanged.

import { getState, setState, dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';

const BABYLON = window.BABYLON;

let _scene  = null;
let _gizmos = null;
let _getCursorPosition = null;   // injected — pivotMode 'cursor' anchor

// Pivot-based selection (see core/Selection.js + BLUEPRINT §7).
let _pivotNode          = null;
let _parentingSnapshots = [];   // [{ mesh, prevParent }]
let _selectedMeshes     = [];   // topmost transform nodes under the pivot
let _activeMesh         = null;   // active transform node (mesh or group node)
let _activeGeometry     = null;   // nodes defining the 'active' pivot AABB
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
 * `{ prev, next }` keyed by node id (object meshId or groupId). Wired in src/app/main.ts to push a
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
    dispatch(EVENTS.GIZMO_CHANGED, { mode });
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
    dispatch(EVENTS.GIZMO_CHANGED, { space });
  }
  // Recompute pivot orientation if currently attached.
  if (_selectedMeshes.length) {
    attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh, _activeGeometry);
  }
}

// ── Pivot attach / detach ────────────────────────────────

/** Selection-entry id of a transform node: object meshId or user groupId. */
function _nodeId(node) {
  return node?.metadata?.meshId ?? node?.metadata?.groupId ?? null;
}

/**
 * Drop every node that has an ANCESTOR also in the list, so an object selected
 * together with its group (or a subgroup with its parent group) is transformed
 * exactly once — rigidly, by the topmost node. Must run while nodes sit in
 * their canonical parents (pivot detached). Order and identity are kept;
 * duplicates are removed.
 * @param {any[]} nodes
 * @param {(e: any) => any} [nodeOf]  maps an entry to its node (default identity)
 * @returns {any[]}
 */
export function topmostTransformTargets(nodes, nodeOf = (e) => e) {
  const list = (nodes ?? []).filter(e => nodeOf(e));
  const set = new Set(list.map(nodeOf));
  const out = [];
  const seen = new Set();
  for (const e of list) {
    const n = nodeOf(e);
    if (seen.has(n)) continue;
    let p = n.parent ?? null;
    let covered = false;
    while (p) {
      if (set.has(p)) { covered = true; break; }
      p = p.parent ?? null;
    }
    if (covered) continue;
    seen.add(n);
    out.push(e);
  }
  return out;
}

/** Geometry meshes a node contributes to a pivot AABB: itself + descendants. */
function _geometryMeshes(node) {
  const out = [];
  const take = (m) => {
    if (!m || out.includes(m)) return;
    if (typeof m.getBoundingInfo !== 'function') return;
    if ((m.getTotalVertices?.() ?? 0) <= 0) return;
    if (m.isEnabled && !m.isEnabled()) return;
    out.push(m);
  };
  take(node);
  for (const c of node?.getChildMeshes?.(false) ?? []) take(c);
  return out;
}

/**
 * World-AABB centre of every mesh under `nodes` (union), or null when none of
 * them carries geometry.
 * @param {any[]} nodes
 */
export function geometryAABBCenter(nodes) {
  let min = null, max = null;
  for (const n of nodes ?? []) {
    for (const m of _geometryMeshes(n)) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const lo = bb.minimumWorld, hi = bb.maximumWorld;
      if (!min) { min = lo.clone(); max = hi.clone(); continue; }
      min = BABYLON.Vector3.Minimize(min, lo);
      max = BABYLON.Vector3.Maximize(max, hi);
    }
  }
  if (!min) return null;
  return new BABYLON.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
}

function _originCentroid(nodes) {
  const sum = new BABYLON.Vector3(0, 0, 0);
  if (!nodes.length) return sum;
  nodes.forEach(n => { n.computeWorldMatrix?.(true); sum.addInPlace(n.getAbsolutePosition()); });
  return sum.scaleInPlace(1 / nodes.length);
}

/**
 * World position the pivot occupies for a pivot mode (shared by the gizmo
 * pivot and the keyboard G/R/S modal):
 * - 'world'      → origin
 * - 'cursor'     → the 3D cursor
 * - 'median'     → AABB centre of ALL selected geometry (union of the world
 *                  AABBs of every mesh under the selected nodes)
 * - 'active'     → AABB centre of the active entry's geometry
 *                  (`activeGeometry`, default `[activeNode]`)
 * - 'individual' → centroid of the selected nodes' own origins (a group
 *                  contributes its group node's origin)
 * Geometry-less selections fall back to the origin centroid / active origin.
 * @param {any[]} nodes          topmost transform nodes
 * @param {string} mode
 * @param {any|null} activeNode
 * @param {any[]|null} [activeGeometry]
 */
export function computePivotPosition(nodes, mode, activeNode, activeGeometry = null) {
  if (mode === 'world') return BABYLON.Vector3.Zero();
  if (mode === 'cursor') {
    return _getCursorPosition ? _getCursorPosition() : BABYLON.Vector3.Zero();
  }
  if (mode === 'individual') return _originCentroid(nodes);
  if (mode === 'active' && activeNode) {
    const geo = activeGeometry?.length ? activeGeometry : [activeNode];
    const c = geometryAABBCenter(geo);
    if (c) return c;
    activeNode.computeWorldMatrix?.(true);
    return activeNode.getAbsolutePosition().clone();
  }
  return geometryAABBCenter(nodes) ?? _originCentroid(nodes);
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
  _activeGeometry = null;
}

/**
 * Attach the gizmo to a temp TransformNode pivot that parents every selected
 * transform node (preserving world transform). Nodes are object meshes AND
 * user-group TransformNodes (overhaul 2.2): a group node is parented as a
 * whole, so the group moves rigidly and its children keep their local
 * transforms. Nodes covered by a selected ancestor are dropped (no double
 * transform). Subsequent gizmo drags move the pivot → children inherit. On
 * selection change, the pivot is detached and rebuilt.
 *
 * @param {any[]} nodes         Selected transform nodes (meshes / group nodes).
 * @param {'world'|'median'|'active'|'individual'|'cursor'} pivotMode
 * @param {any|null} [activeNode]  The active (primary-selected) node.
 * @param {any[]|null} [activeGeometry]  Nodes whose geometry defines the
 *   'active' pivot (every part of a multi-part active object); default [activeNode].
 */
export function attachToSelection(nodes, pivotMode = 'median', activeNode = null, activeGeometry = null) {
  _detachPivot();
  const top = topmostTransformTargets(nodes);
  if (!top.length) {
    _gizmos?.attachToMesh(null);
    return;
  }
  _currentPivotMode = pivotMode;
  _selectedMeshes   = top;
  _activeMesh       = activeNode ?? top[top.length - 1];
  _activeGeometry   = activeGeometry ? activeGeometry.slice() : null;

  _pivotNode = new BABYLON.TransformNode('selectionPivot', _scene);
  _pivotNode.position = computePivotPosition(top, pivotMode, _activeMesh, _activeGeometry);

  const space = getState().gizmo.space;
  if (space === 'local' && _activeMesh) {
    _activeMesh.computeWorldMatrix(true);
    const aq = _activeMesh.absoluteRotationQuaternion;
    _pivotNode.rotationQuaternion = aq ? aq.clone() : BABYLON.Quaternion.Identity();
  } else {
    _pivotNode.rotationQuaternion = BABYLON.Quaternion.Identity();
  }

  for (const m of top) {
    if (m === _pivotNode) continue;
    _parentingSnapshots.push({ mesh: m, prevParent: m.parent ?? null });
    m.setParent(_pivotNode);
  }

  _gizmos?.attachToMesh(_pivotNode);
}

/** The live pivot TransformNode (null when nothing is attached). */
export function getPivotNode() {
  return _pivotNode;
}

// ── Gizmo drag → command ────────────────────────────────

/** Absolute transform snapshot keyed by node id (object meshId / groupId). */
function _snapshotAbsolute(nodes) {
  const out = {};
  for (const m of nodes) {
    const id = _nodeId(m);
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
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh, _activeGeometry);
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
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh, _activeGeometry);
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
