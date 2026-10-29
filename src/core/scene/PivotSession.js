// Pivot session + gizmos (split from SceneManager.js — Blueprint §0.5 file-
// size budget, same pattern as SelectionOutline/BedGrid): the GizmoManager,
// the temp selectionPivot TransformNode that parents the selection during a
// drag (BLUEPRINT §7), gizmo drag → TransformCommand snapshots, and the LMB
// body-drag (ground-plane translate) that shares the same commit pipeline.
// SceneManager re-exports the public functions so its surface is unchanged.

import { getState, setState, dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { gizmoSnapDistances, snapToStep } from '../SnapUnits.js';

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
let _gizmoSnapOn        = false; // Ctrl held → gizmo drags snap (overhaul 5.6)
let _viewOnly = false;
let _coarseInput        = false; // touch/pen is the live input → bigger gizmo handles (8.5)

/** Gizmo handle size multiplier: 1 = Babylon default (mouse), larger on touch. */
export const TOUCH_GIZMO_SCALE = 1.7;

/** @param {boolean} coarse @returns {number} */
export function gizmoScaleRatioFor(coarse) {
  return coarse ? TOUCH_GIZMO_SCALE : 1;
}

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
  _initCoarseInputTracking();
  _initDragInterruptGuard();

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
  _wireTranslateSnap(_gizmos.gizmos.positionGizmo);
  _wireRotateSnap(_gizmos.gizmos.rotationGizmo);
  _wireScaleSnap(_gizmos.gizmos.scaleGizmo);
}

// ── Translate Ctrl-snap (P6.3) ───────────────────────────
// Babylon's snapDistance path keeps its remainder in a closure that no API can
// reset (planeDragGizmo / axisDragGizmo `currentSnapDragDistance`), so a snapped
// drag starts with the leftover of the drag before it. Translate snapping
// therefore runs here instead: Babylon's snapDistance stays 0 (free drag) and,
// after each of its moves, the pivot is put at origin + snap(this drag's total
// travel). Nothing carries over between drags.
const TRANSLATE_HANDLES = [
  ['xGizmo', true], ['yGizmo', true], ['zGizmo', true],          // axis arrows
  ['xPlaneGizmo', false], ['yPlaneGizmo', false], ['zPlaneGizmo', false], // plane squares
];
let _snapStep = 0;     // translate step in BU, 0 = off
let _snapDrag = null;  // { origin: Vector3, travel: Vector3, axis: boolean } for the live drag

function _wireTranslateSnap(pg) {
  if (!pg || pg._mixomeshSnapWired) return;
  pg._mixomeshSnapWired = true;
  for (const [name, isAxis] of TRANSLATE_HANDLES) {
    const db = pg[name]?.dragBehavior;
    if (!db) continue;
    db.onDragStartObservable.add(() => {
      _snapDrag = _pivotNode ? { origin: _pivotNode.position.clone(), travel: BABYLON.Vector3.Zero(), axis: isAxis } : null;
    });
    db.onDragObservable.add(_snapTranslateDrag);
  }
}

// Babylon's own snap rounds toward zero per step (floor on |x|), so do the same.
function _snapToStep(v, s) {
  return Math.sign(v) * Math.floor(Math.abs(v) / s) * s;
}

function _snapTranslateDrag(e) {
  const d = _snapDrag;
  if (!d || !_snapStep || !e?.delta || !_pivotNode) return;
  d.travel.addInPlace(e.delta);
  const t = d.travel, s = _snapStep;
  let snapped;
  if (d.axis) {
    // Axis arrow: travel is along the arrow, so snap its length.
    const len = t.length();
    snapped = len > 0 ? t.scale((Math.floor(len / s) * s) / len) : BABYLON.Vector3.Zero();
  } else {
    // Plane square: snap each world axis, as Babylon's plane gizmo does.
    snapped = new BABYLON.Vector3(_snapToStep(t.x, s), _snapToStep(t.y, s), _snapToStep(t.z, s));
  }
  const corr = d.origin.add(snapped).subtract(_pivotNode.position);
  if (corr.lengthSquared() > 1e-24) {
    _pivotNode.position.addInPlace(corr);
    _pivotNode.computeWorldMatrix(true);
  }
}

// ── Rotate / scale Ctrl-snap (P6.4) ──────────────────────
// Babylon's rotation ring keeps its snap remainder in a closure nothing resets
// between drags (the same leftover as translate, P6.3). Babylon's scale snap
// works on drag strength rather than the factor, so a 60 px drag stopped at
// 1.058 instead of a 0.1 step. Rotate and scale therefore snap here, with
// Babylon's snapDistance held at 0. Each drag event rebuilds the pivot from its
// DRAG-START value and the TOTAL free amount for this drag, so nothing carries
// over. Steps come from SnapUnits, as in the G/R/S modal.
const ROTATE_RINGS = [['xGizmo', [1, 0, 0]], ['yGizmo', [0, 1, 0]], ['zGizmo', [0, 0, 1]]];
const SCALE_HANDLES = ['xGizmo', 'yGizmo', 'zGizmo', 'uniformScaleGizmo'];
let _rotateStep = 0;   // radians, 0 = off
let _scaleStep  = 0;   // multiplier step, 0 = off
let _rotDrag    = null; // { ring, axis: Vector3, q0: Quaternion } for the live rotate drag
let _scaleDrag  = null; // { start, prev, free: Vector3 } for the live scale drag

function _wireRotateSnap(rg) {
  if (!rg || rg._mixomeshSnapWired) return;
  rg._mixomeshSnapWired = true;
  for (const [name, [x, y, z]] of ROTATE_RINGS) {
    const ring = rg[name];
    const db = ring?.dragBehavior;
    if (!db) continue;
    db.onDragStartObservable.add(() => {
      const q = _pivotNode?.rotationQuaternion;
      _rotDrag = _pivotNode
        ? { ring, axis: new BABYLON.Vector3(x, y, z), q0: q ? q.clone() : BABYLON.Quaternion.Identity() }
        : null;
    });
    db.onDragObservable.add(_snapRotateDrag);
  }
}

// Babylon's ring keeps `angle` = the free total of this drag (reset at drag start,
// accumulated about the ring normal in the pivot's frame). Pivot = start * snapped total.
function _snapRotateDrag() {
  const d = _rotDrag;
  if (!d || !_pivotNode) return;
  const free = d.ring.angle;
  const a = _rotateStep > 0 ? snapToStep(free, _rotateStep) : free;
  _pivotNode.rotationQuaternion = d.q0.multiply(BABYLON.Quaternion.RotationAxis(d.axis, a));
  _pivotNode.computeWorldMatrix(true);
}

function _wireScaleSnap(sg) {
  if (!sg || sg._mixomeshSnapWired) return;
  sg._mixomeshSnapWired = true;
  for (const name of SCALE_HANDLES) {
    const db = sg[name]?.dragBehavior;
    if (!db) continue;
    db.onDragStartObservable.add(() => {
      const s = _pivotNode?.scaling;
      _scaleDrag = s ? { start: s.clone(), prev: s.clone(), free: new BABYLON.Vector3(1, 1, 1) } : null;
    });
    db.onDragObservable.add(_snapScaleDrag);
  }
}

// Babylon scales incrementally from whatever the pivot holds, so each event's free
// step is (its new scaling / the scaling we last set). Multiplying those steps gives
// the free total factor for this drag; snap that (min one step, as the G/S modal).
function _snapScaleDrag() {
  const d = _scaleDrag;
  if (!d || !_pivotNode) return;
  const s = _pivotNode.scaling;
  const target = new BABYLON.Vector3(1, 1, 1);
  for (const c of ['x', 'y', 'z']) {
    if (d.prev[c]) d.free[c] *= s[c] / d.prev[c];
    let f = d.free[c];
    if (_scaleStep > 0 && Math.abs(f - 1) > 1e-9) f = Math.max(_scaleStep, snapToStep(f, _scaleStep));
    target[c] = d.start[c] * f;
  }
  _pivotNode.scaling.copyFrom(target);
  _pivotNode.computeWorldMatrix(true);
  d.prev = target.clone();
}

// Babylon centres each plane square on the pivot, hidden under the arrow bases
// and overlapping the other two. Slide each into its own plane corner (local
// to the gizmo root, so it follows screen-constant scale and world/local space).
const PLANE_HANDLE_OFFSET = 0.05;
function _enablePlaneHandles(pos) {
  if (!pos) return;
  pos.planarGizmoEnabled = true;
  const o = PLANE_HANDLE_OFFSET;
  const layout = [[pos.xPlaneGizmo, [0, o, o]], [pos.yPlaneGizmo, [o, 0, o]], [pos.zPlaneGizmo, [o, o, 0]]];
  for (const [g, [x, y, z]] of layout) g?._gizmoMesh?.position.set(x, y, z);
}

// Gizmo palette (P6.2): X / Y / Z hues come from the mixo-app-style tokens
// (src/kit/styles/tokens.css): X = --red #7f0019, Y = --success #4a6b3a,
// Z = --info #3b4a5c with saturation lifted (HSL s 22% -> 40%, same hue and
// lightness) to #2c476a so it reads as blue next to the ink-dark UI. Hover /
// active (Babylon shows the hover material while dragging) = each hue mixed
// 40% toward white. Plane squares share the hue at 0.45 alpha (0.75 hovered).
export const GIZMO_AXIS_HEX = Object.freeze({ x: '#7f0019', y: '#4a6b3a', z: '#2c476a' });
export const GIZMO_PLANE_ALPHA = 0.45;
export const GIZMO_PLANE_ALPHA_HOVER = 0.75;
const GIZMO_HOVER_MIX = 0.4;

function _styleGizmo(g, hex, plane) {
  if (!g?.coloredMaterial || !g.hoverMaterial) return;
  const base = BABYLON.Color3.FromHexString(hex);
  const hover = BABYLON.Color3.Lerp(base, BABYLON.Color3.White(), GIZMO_HOVER_MIX);
  g.coloredMaterial.diffuseColor = base;
  g.coloredMaterial.specularColor = base.scale(0.5);
  g.hoverMaterial.diffuseColor = hover;
  if (plane) {
    g.coloredMaterial.alpha = GIZMO_PLANE_ALPHA;
    g.hoverMaterial.alpha = GIZMO_PLANE_ALPHA_HOVER;
  }
}

function _applyGizmoColours() {
  const pos = _gizmos?.gizmos?.positionGizmo;
  const scl = _gizmos?.gizmos?.scaleGizmo;
  for (const a of ['x', 'y', 'z']) {
    _styleGizmo(pos?.[`${a}Gizmo`], GIZMO_AXIS_HEX[a], false);
    _styleGizmo(pos?.[`${a}PlaneGizmo`], GIZMO_AXIS_HEX[a], true);
    _styleGizmo(scl?.[`${a}Gizmo`], GIZMO_AXIS_HEX[a], false);
  }
}

// A drag cut short (window blur, pointercancel, tab hidden) never gets its
// pointerup: PointerDragBehavior would stay `dragging` with the camera
// controls detached. Release every live handle drag: Babylon fires drag-end
// (our _onGizmoDragEnd commits ONE undo step, or none when nothing moved) and
// re-attaches the camera.
export function releaseGizmoDrags() {
  const g = _gizmos?.gizmos;
  if (!g) return 0;
  let n = 0;
  for (const name of ['positionGizmo', 'rotationGizmo', 'scaleGizmo']) {
    const sub = g[name];
    if (!sub) continue;
    for (const k of ['x', 'y', 'z']) {
      for (const h of [sub[`${k}Gizmo`], sub[`${k}PlaneGizmo`]]) {
        const b = h?.dragBehavior;
        if (b?.dragging) { b.releaseDrag(); n++; }
      }
    }
  }
  return n;
}

function _initDragInterruptGuard() {
  const release = () => { releaseGizmoDrags(); };
  window.addEventListener?.('blur', release);
  document.addEventListener?.('visibilitychange', () => { if (document.hidden) release(); });
  _scene.getEngine().getRenderingCanvas?.()?.addEventListener('pointercancel', release);
}

function _enabledGizmoChanged() {
  // Babylon recreates the sub-gizmos when modes toggle. Re-attach observers.
  _wireGizmoObservers();
  // P6.1: XY / YZ / XZ plane squares on the move gizmo. Their drags feed the
  // same positionGizmo drag observables, so one drag = one undo step; snap
  // (snapDistance) and space (updateGizmoRotationToMatchAttachedMesh) apply too.
  _enablePlaneHandles(_gizmos.gizmos.positionGizmo);
  _applyGizmoColours();
  _applyGizmoSnap();
  _applyGizmoScale();
}

// ── Touch sizing (overhaul 8.5) ──────────────────────────
// Coarse pointer (matchMedia) or last pointerType touch/pen → larger handles
// (a bigger visual is also a bigger hit area); a mouse press switches back.
// Mouse ratio is Babylon's default 1, so mouse behaviour is unchanged.

function _applyGizmoScale() {
  const g = _gizmos?.gizmos;
  if (!g) return;
  const r = gizmoScaleRatioFor(_coarseInput);
  for (const name of ['positionGizmo', 'rotationGizmo', 'scaleGizmo']) {
    if (g[name]) g[name].scaleRatio = r;
  }
}

/** @param {boolean} coarse */
export function setCoarseInput(coarse) {
  const next = !!coarse;
  if (next === _coarseInput) return;
  _coarseInput = next;
  document.body?.classList?.toggle('touch-input', next);
  _applyGizmoScale();
  document.dispatchEvent?.(new CustomEvent('mx:input-kind', { detail: { coarse: next } }));
}

/** @returns {boolean} touch/pen is the live input kind. */
export function isCoarseInput() { return _coarseInput; }

function _initCoarseInputTracking() {
  try {
    if (window.matchMedia?.('(pointer: coarse)')?.matches) setCoarseInput(true);
  } catch { /* matchMedia unavailable */ }
  window.addEventListener?.('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setCoarseInput(true);
    else if (e.pointerType === 'mouse') setCoarseInput(false);
  }, { capture: true, passive: true });
}

// Push the current Ctrl-snap state into every live sub-gizmo. Babylon's
// `snapDistance` is in the gizmo's own units: position = BU, rotation =
// radians, scale = multiplier; 0 = free drag. Steps come from
// state.gizmo.snap (translate in mm) via SnapUnits.
function _applyGizmoSnap() {
  const g = _gizmos?.gizmos;
  if (!g) return;
  const d = gizmoSnapDistances(getState().gizmo?.snap, _gizmoSnapOn);
  // Translate, rotate and scale snap all run in PivotSession (P6.3 / P6.4), so
  // Babylon's own snapDistance stays 0 everywhere.
  _snapStep = d.translate;
  _rotateStep = d.rotate;
  _scaleStep = d.scale;
  if (g.positionGizmo) g.positionGizmo.snapDistance = 0;
  if (g.rotationGizmo) g.rotationGizmo.snapDistance = 0;
  if (g.scaleGizmo)    g.scaleGizmo.snapDistance    = 0;
}

/**
 * Gizmo Ctrl-snap (overhaul 5.6, plan §4.7): while `on`, gizmo drags snap to
 * the same steps as the G/R/S modal (translate mm, rotate deg, scale ×).
 * Driven by InputManager from Ctrl keydown/keyup and live pointer modifiers.
 * @param {boolean} on
 */
export function setGizmoSnap(on) {
  const next = !!on;
  if (next === _gizmoSnapOn) return;
  _gizmoSnapOn = next;
  _applyGizmoSnap();
}

/** @returns {boolean} gizmo Ctrl-snap currently engaged. */
export function isGizmoSnapOn() { return _gizmoSnapOn; }

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

  _gizmos?.attachToMesh(_viewOnly ? null : _pivotNode);
}

/**
 * View-only (phone viewer, 8.6): the gizmo never attaches, so no handle can
 * be grabbed. The pivot parenting itself is unchanged; edits stay blocked by
 * InputManager's read-only mode.
 * @param {boolean} on
 */
export function setViewOnly(on) {
  _viewOnly = !!on;
  if (_viewOnly) _gizmos?.attachToMesh(null);
  else if (_pivotNode) _gizmos?.attachToMesh(_pivotNode);
}

/**
 * Detach the gizmo for a capture; the returned restore re-attaches it to the
 * current pivot (unless view-only). Pivot parenting is untouched.
 * @returns {() => void}
 */
export function suspendGizmo() {
  if (!_gizmos || !_pivotNode || _viewOnly) return () => {};
  _gizmos.attachToMesh(null);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (!_viewOnly && _pivotNode) _gizmos?.attachToMesh(_pivotNode);
  };
}

/** The Babylon GizmoManager (handle geometry lookup for browser smokes). */
export function getGizmoManager() {
  return _gizmos;
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

/** True when two snapshot maps (same shape as _snapshotAbsolute) hold the same transforms. */
export function isNoopTransform(prev, next) {
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

// A press and release on the gizmo or the body with no movement is a click,
// not an edit: no undo step (L2-08).
function _commitDrag(prev, next) {
  if (_onTransformCommit && !isNoopTransform(prev, next)) _onTransformCommit({ prev, next, alreadyApplied: true });
}

function _onGizmoDragStart() {
  _dragSnapshot = _snapshotAbsolute(_selectedMeshes);
}

function _onGizmoDragEnd() {
  _snapDrag = null;
  _rotDrag = null;
  _scaleDrag = null;
  if (!_dragSnapshot) return;
  const prev = _dragSnapshot;
  const next = _snapshotAbsolute(_selectedMeshes);
  _dragSnapshot = null;
  _commitDrag(prev, next);
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
  _commitDrag(prev, next);
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
