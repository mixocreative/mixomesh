import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { AssetLoader } from './AssetLoader.js';
import {
  canonicalObjectId, logicalObjectPartIds, logicalObjectLeadIds, canonicalSelectableId, isGroupId,
} from './LogicalObjects.js';

// Selection writes are silent against PROJECT_DIRTY — clicking around shouldn't
// flag the project as needing a save. The persisted schema (BLUEPRINT §11) still
// includes selection, it just isn't a dirty trigger.
const SILENT = { silent: true };

const VALID_PIVOTS = new Set(['world', 'median', 'active', 'individual', 'cursor']);

/**
 * Find the runtime TransformNode for a user group (`metadata.groupId`).
 * Inlined rather than imported from commands/support.js, which imports
 * Selection (cycle).
 * @param {string} groupId
 */
function _findGroupNode(groupId) {
  const scene = SceneManager.getScene?.();
  if (!scene) return null;
  for (const t of scene.transformNodes ?? []) {
    if (t?.metadata?.groupId === groupId) return t;
  }
  return null;
}

/**
 * Resolve one selection entry to its live node.
 * Objects resolve to their lead's Babylon mesh; groups to their TransformNode.
 * Ghosts, unknown ids and ids without a live node return null.
 * @param {string} id
 * @returns {{ id: string, node: any, kind: 'object'|'group' } | null}
 */
function _resolve(id) {
  const { objects, groups } = getState().scene;
  const obj = objects[id];
  if (obj) {
    if (obj.isGhost) return null;
    const mesh = AssetLoader.getBabylonMesh(id);
    return mesh ? { id, node: mesh, kind: 'object' } : null;
  }
  if (isGroupId(id, groups)) {
    const node = _findGroupNode(id);
    return node ? { id, node, kind: 'group' } : null;
  }
  return null;
}

/**
 * Resolve selected OBJECT ids to live meshes, expanding each logical object to
 * all of its material parts and dropping unknowns / ghosts / group ids.
 * This is the long-standing mesh-only contract of `getSelectedResolved()`.
 * @param {string[]} ids
 * @returns {{ id: string, mesh: any }[]}
 */
function _resolveObjectMeshes(ids) {
  const out = [];
  const objects = getState().scene.objects;
  const seen = new Set();
  for (const id of ids) {
    if (!objects[id]) continue;
    for (const partId of logicalObjectPartIds(id, objects)) {
      if (seen.has(partId)) continue;
      seen.add(partId);
      const r = _resolve(partId);
      if (r) out.push({ id: partId, mesh: r.node });
    }
  }
  return out;
}

/**
 * Strict canonical id for WRITES: group ids as-is, object ids → lead,
 * null for unknown / ghost.
 * @param {string|null|undefined} id
 */
function _canon(id) {
  return canonicalSelectableId(id, getState().scene);
}

/**
 * Loose canonical id for membership checks (remove / contains): never drops
 * the id, so stale entries can still be found.
 * @param {string|null|undefined} id
 */
function _canonLoose(id) {
  const { objects, groups } = getState().scene;
  if (!objects[id] && isGroupId(id, groups)) return id;
  return canonicalObjectId(id, objects);
}

/** Object meshes under a group node (for outline); helper meshes excluded. */
function _groupMeshes(node) {
  return (node?.getChildMeshes?.(false) ?? []).filter(m => m?.metadata?.meshId);
}

/**
 * Transform targets of the current selection (overhaul 2.2), in selection
 * order: every material part mesh of each selected object (`id` = part
 * meshId) and each selected group's TransformNode (`id` = groupId). Not
 * ancestor-filtered — the pivot drops nodes covered by a selected ancestor
 * (`topmostTransformTargets`) once canonical parents are back in place.
 * `activeNode` = active group node or active object's lead mesh;
 * `activeGeometry` = nodes whose geometry defines the 'active' pivot.
 * @returns {{ targets: { id: string, node: any, kind: 'object'|'group' }[],
 *             activeNode: any|null, activeGeometry: any[] }}
 */
export function getTransformTargets() {
  const { selectedIds, activeId } = getState().selection;
  const objects = getState().scene.objects;
  const targets = [];
  let activeNode = null;
  let activeGeometry = [];
  for (const id of selectedIds) {
    if (objects[id]) {
      const parts = _resolveObjectMeshes([id]);
      for (const r of parts) targets.push({ id: r.id, node: r.mesh, kind: 'object' });
      if (id === activeId && parts.length) {
        activeNode = parts.find(r => r.id === id)?.mesh ?? parts[0].mesh;
        activeGeometry = parts.map(r => r.mesh);
      }
      continue;
    }
    const r = _resolve(id);
    if (r?.kind !== 'group') continue;
    targets.push(r);
    if (id === activeId) { activeNode = r.node; activeGeometry = [r.node]; }
  }
  return { targets, activeNode, activeGeometry };
}

function _applyVisuals() {
  const { activeId, pivotMode } = getState().selection;
  const { targets, activeNode, activeGeometry } = getTransformTargets();
  // Outline: object parts directly; a selected group outlines its member
  // meshes. The ACTIVE entry (multi-part object or group) gets the active tint.
  const activeSet = new Set();
  for (const t of targets) {
    if (t.kind === 'object' && activeGeometry.includes(t.node)) activeSet.add(t.node);
    if (t.kind === 'group' && t.id === activeId) for (const m of _groupMeshes(t.node)) activeSet.add(m);
  }
  const others = new Set();
  for (const t of targets) {
    const ms = t.kind === 'group' ? _groupMeshes(t.node) : [t.node];
    for (const m of ms) if (!activeSet.has(m)) others.add(m);
  }

  SceneManager.setActive([...activeSet]);
  SceneManager.setSelected([...others]);
  // Group nodes go under the pivot as a whole → rigid group transforms (2.2).
  SceneManager.attachToSelection(targets.map(t => t.node), pivotMode, activeNode, activeGeometry);
}

/**
 * Replace the current selection. Accepts object ids (collapsed to their
 * logical-object lead) and group ids (`state.scene.groups`, kept as-is — never
 * expanded into children). Unknown ids and ghosts are dropped.
 * @param {string[]} ids
 * @param {string|null} [activeId]  Defaults to last id, or null if empty.
 */
export function set(ids, activeId) {
  const cleaned = Array.from(new Set((ids ?? [])
    .map(_canon)
    .filter(id => id != null)));
  const canonicalActive = _canon(activeId);
  const newActive = canonicalActive != null && cleaned.includes(canonicalActive)
    ? canonicalActive
    : (cleaned.length ? cleaned[cleaned.length - 1] : null);

  const prev = getState().selection;
  if (_eq(prev.selectedIds, cleaned) && prev.activeId === newActive) return;

  setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: cleaned, activeId: newActive },
  }), SILENT);

  dispatch(EVENTS.SELECTION_CHANGED, { selectedIds: cleaned, activeId: newActive });
  if (prev.activeId !== newActive) {
    dispatch(EVENTS.ACTIVE_OBJECT_CHANGED, { activeId: newActive });
  }
  _applyVisuals();
}

/** Add `id` to the selection (idempotent). The added id becomes active. */
export function add(id) {
  const canonical = _canon(id);
  if (canonical == null) return;
  const { selectedIds } = getState().selection;
  if (selectedIds.includes(canonical)) { setActive(canonical); return; }
  set([...selectedIds, canonical], canonical);
}

/** Remove `id` from the selection. */
export function remove(id) {
  const canonical = _canonLoose(id);
  const { selectedIds, activeId } = getState().selection;
  if (!selectedIds.includes(canonical)) return;
  const next = selectedIds.filter(x => x !== canonical);
  const nextActive = activeId === canonical ? (next[next.length - 1] ?? null) : activeId;
  set(next, nextActive);
}

/** Add or remove `id` depending on whether it's currently selected. */
export function toggle(id) {
  const canonical = _canon(id);
  if (canonical == null) return;
  const { selectedIds } = getState().selection;
  if (selectedIds.includes(canonical)) remove(canonical);
  else add(canonical);
}

/** Replace the active id. Must already be in the selection set. */
export function setActive(id) {
  const canonical = id == null ? null : _canon(id);
  if (id != null && canonical == null) return;
  const { selectedIds, activeId } = getState().selection;
  if (canonical === activeId) return;
  if (canonical != null && !selectedIds.includes(canonical)) return;
  setState(s => ({ ...s, selection: { ...s.selection, activeId: canonical } }), SILENT);
  dispatch(EVENTS.ACTIVE_OBJECT_CHANGED, { activeId: canonical });
  _applyVisuals();
}

/** Empty the selection. */
export function clear() {
  set([], null);
}

/**
 * Select every visible non-ghost SceneObject in state.scene.objects. If
 * everything is already selected, clear instead (Blender-style A toggle).
 */
export function selectAll() {
  const all = logicalObjectLeadIds(getState().scene.objects);
  const cur = getState().selection.selectedIds;
  if (all.length && cur.length === all.length) {
    clear();
  } else {
    set(all, all[all.length - 1] ?? null);
  }
}

/**
 * @param {'world'|'median'|'active'|'individual'|'cursor'} mode
 */
export function setPivotMode(mode) {
  if (!VALID_PIVOTS.has(mode)) return;
  if (getState().selection.pivotMode === mode) return;
  setState(s => ({ ...s, selection: { ...s.selection, pivotMode: mode } }), SILENT);
  SceneManager.setCursorVisible?.(mode === 'cursor');
  _applyVisuals();
  dispatch(EVENTS.PIVOT_MODE_CHANGED, { mode });
}

/** Cycle through pivot modes in order: world → median → active → individual → cursor. */
export function cyclePivotMode() {
  const order = ['world', 'median', 'active', 'individual', 'cursor'];
  const cur = getState().selection.pivotMode;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setPivotMode(next);
}

/** Force the visuals to re-sync — call after the scene gets a new mesh. */
export function refresh() {
  _applyVisuals();
}

/** @returns {string[]} */
export function getSelectedIds() {
  return getState().selection.selectedIds;
}

/** @returns {string|null} */
export function getActiveId() {
  return getState().selection.activeId;
}

/** @returns {boolean} */
export function contains(id) {
  const canonical = _canonLoose(id);
  return getState().selection.selectedIds.includes(canonical);
}

/**
 * Selected OBJECTS as live meshes (every material part of each logical
 * object). Group entries are skipped — use `getSelectedNodes()` for those.
 * @returns {{ id: string, mesh: any }[]}
 */
export function getSelectedResolved() {
  return _resolveObjectMeshes(getState().selection.selectedIds);
}

/**
 * Every selected entry (objects and groups) resolved to its live node, in
 * selection order. Objects resolve to their lead mesh only (no part
 * expansion); groups to their TransformNode. Unknown / ghost / node-less ids
 * are skipped.
 * @returns {{ id: string, node: any, kind: 'object'|'group' }[]}
 */
export function getSelectedNodes() {
  const out = [];
  for (const id of getState().selection.selectedIds) {
    const r = _resolve(id);
    if (r) out.push(r);
  }
  return out;
}

function _eq(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const Selection = {
  set, add, remove, toggle, setActive, clear, selectAll,
  setPivotMode, cyclePivotMode, refresh,
  getSelectedIds, getActiveId, contains, getSelectedResolved, getSelectedNodes,
  getTransformTargets,
};
