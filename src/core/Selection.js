import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { AssetLoader } from './AssetLoader.js';
import {
  canonicalObjectId, logicalObjectPartIds, logicalObjectLeadIds, canonicalSelectableId, isGroupId,
  isPartScopeId, selectableAtDepth,
} from './LogicalObjects.js';

// Selection writes are silent against PROJECT_DIRTY — clicking around shouldn't
// flag the project as needing a save. The persisted schema (BLUEPRINT §11) still
// includes selection, it just isn't a dirty trigger.
const SILENT = { silent: true };

const VALID_PIVOTS = new Set(['world', 'median', 'active', 'individual', 'cursor']);

// Click-depth scope (task 3.2): the group the user has "entered" by
// double-click, or null = root. Session-only (Decision 12) — deliberately NOT
// in state.selection, which ProjectSerializer persists wholesale.
let _scopeId = null;

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
  const scene = getState().scene;
  // Inside an object (U5) its PARTS are the selectable items, so a part id has
  // to survive here. Everywhere else a part still collapses to its lead, which
  // is what keeps parts unselectable in the rest of the app -- one exception,
  // in one place, rather than a second selection model.
  const scope = getScope();
  if (scope != null && isPartScopeId(scope, scene.objects)
      && logicalObjectPartIds(scope, scene.objects).includes(id) && !scene.objects[id]?.isGhost) return id;
  return canonicalSelectableId(id, scene);
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
 * True when the object/group itself, or any ancestor group, is locked
 * (lock cascades DOWN, overhaul 2.5). Object ids resolve through their
 * logical-object lead, so locking either the lead or a part counts.
 * @param {string|null|undefined} id
 */
export function isEffectivelyLocked(id) {
  if (!id) return false;
  const { objects, groups } = getState().scene;
  const seen = new Set();
  const own = objects[id];
  if (own) {
    const lead = objects[canonicalObjectId(id, objects)];
    if (own.locked || lead?.locked) return true;
  } else if (groups[id]?.locked) return true;
  let cur = own?.parentId ?? groups[id]?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (groups[cur]?.locked) return true;
    cur = groups[cur]?.parentId ?? null;
  }
  return false;
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
export function getTransformTargets({ includeLocked = false } = {}) {
  // No gizmo inside an object (U5, the plan's decision): the depth exists to
  // PICK parts, and moving one part of a logical object would break the pose
  // its supports were built against. Returning nothing is what turns G/R/S off,
  // because every caller asks here first.
  if (inPartScope()) return { targets: [], activeNode: null, activeGeometry: [], lockedSkipped: 0 };
  const { selectedIds, activeId } = getState().selection;
  const objects = getState().scene.objects;
  const targets = [];
  let activeNode = null;
  let activeGeometry = [];
  let lockedSkipped = 0;
  for (const id of selectedIds) {
    // Lock = transform-lock (overhaul 2.5, Decision 9): locked nodes stay
    // selectable/outlined but never go under the pivot or the G/R/S modal.
    if (!includeLocked && isEffectivelyLocked(id)) { lockedSkipped++; continue; }
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
  return { targets, activeNode, activeGeometry, lockedSkipped };
}

function _applyVisuals() {
  const { activeId, pivotMode } = getState().selection;
  // Outline everything selected (locked included); only the pivot is filtered.
  const { targets, activeGeometry: outlineGeometry } = getTransformTargets({ includeLocked: true });
  const tf = getTransformTargets();
  const activeNode = tf.activeNode, activeGeometry = tf.activeGeometry;
  // Outline: object parts directly; a selected group outlines its member
  // meshes. The ACTIVE entry (multi-part object or group) gets the active tint.
  const activeSet = new Set();
  for (const t of targets) {
    if (t.kind === 'object' && outlineGeometry.includes(t.node)) activeSet.add(t.node);
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
  SceneManager.attachToSelection(tf.targets.map(t => t.node), pivotMode, activeNode, activeGeometry);
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

/**
 * Re-canonicalise the stored selection after a structural change.
 *
 * `set` canonicalises, so the rest of the app may assume `selectedIds` holds DISPLAYABLE ids --
 * the outliner compares them against its row ids directly (`Outliner.js:705`), and a row only
 * exists for a lead. A command that makes a selected object an internal part of another (Join), or
 * puts one back on undo (Separate), rewrites those link fields underneath the stored array; the
 * commands are deliberately silent about selection, because one that drove it would make its own
 * undo depend on a selection the user may have changed since.
 *
 * So the repair lives here instead, and it is the whole of it: `set` maps every id through `_canon`
 * -- a part becomes the lead it now belongs to, a deleted id becomes null and is dropped -- and
 * early-returns when nothing moved, so a reconcile that finds everything canonical is silent.
 *
 * The trap this prevents: the viewport looked RIGHT while the list looked empty. Reads resolve
 * through `logicalObjectPartIds`, which canonicalises, so the gizmo and the outline covered the
 * correct object and only the one reader that compares raw ids disagreed.
 */
export function reconcile() {
  const { selectedIds, activeId } = getState().selection ?? {};
  if (!selectedIds?.length) return;
  set(selectedIds, activeId ?? null);
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

// ── Click-depth scope (overhaul task 3.2, plan §4.5) ─────

/**
 * Current click-depth scope: a group id the user entered, or null (root).
 * A scope whose group no longer exists reads as root.
 * @returns {string|null}
 */
export function getScope() {
  return _scopeId != null && _isScopeId(_scopeId) ? _scopeId : null;
}

/**
 * A scope is a group, or a multi-part OBJECT whose parts are the depth (U5).
 * One predicate, so `getScope`, `setScope` and `enterScope` cannot disagree
 * about what can be entered -- which is how a scope would survive as a stale id.
 * @param {string} id
 * @returns {boolean}
 */
function _isScopeId(id) {
  const scene = getState().scene;
  return isGroupId(id, scene.groups) || isPartScopeId(id, scene.objects);
}

/** Is the current depth an object's parts (U5), rather than a group's children? */
export function inPartScope() {
  const scope = getScope();
  return scope != null && isPartScopeId(scope, getState().scene.objects);
}

/**
 * Set the click-depth scope. `null` = root; a non-group id is a no-op.
 * Emits `SCOPE_CHANGED {scopeId}` when the scope actually changes.
 * @param {string|null} groupId
 */
export function setScope(groupId) {
  const next = groupId == null ? null : groupId;
  if (next != null && !_isScopeId(next)) return;
  if (next === _scopeId) return;
  _scopeId = next;
  dispatch(EVENTS.SCOPE_CHANGED, { scopeId: next });
}

/**
 * Selectable item at the current scope depth for a picked id (object, part
 * or group), WITHOUT side effects. null when outside the scope / unknown.
 * @param {string|null|undefined} id
 * @returns {string|null}
 */
export function targetAtScope(id) {
  return selectableAtDepth(id, getState().scene, getScope());
}

/**
 * Resolve a viewport click on `id` to the item to select: the top-most item
 * within the current scope. A click outside the scope exits to root first
 * (then maps at root). Parts always map to their logical lead.
 * @param {string|null|undefined} id
 * @returns {string|null}
 */
export function resolveClick(id) {
  if (id == null) return null;
  const scope = getScope();
  let target = selectableAtDepth(id, getState().scene, scope);
  if (target == null && (scope != null || _scopeId != null)) {
    setScope(null);
    target = selectableAtDepth(id, getState().scene, null);
  }
  return target;
}

/**
 * Enter `groupId` (double-click): scope = that group, and select the item one
 * level deeper that contains `pickedId` (when it is inside the group).
 * @param {string} groupId
 * @param {string|null} [pickedId]
 * @returns {boolean} true when the scope was entered
 */
export function enterScope(groupId, pickedId = null) {
  if (!_isScopeId(groupId)) return false;
  setScope(groupId);
  const child = pickedId == null ? null : selectableAtDepth(pickedId, getState().scene, groupId);
  if (child != null) set([child], child);
  return true;
}

/**
 * Step out one scope level (Esc): scope = parent of the current scope, and the
 * group just exited becomes the selection.
 * @returns {boolean} true when a scope was exited (false at root)
 */
export function exitScope() {
  const scope = getScope();
  if (scope == null) {
    if (_scopeId != null) setScope(null);  // stale scope (group deleted) → root
    return false;
  }
  const { groups, objects } = getState().scene;
  // A part scope steps out to the OBJECT's parent group (it has no group of its
  // own), and the object just left becomes the selection -- the same shape as
  // stepping out of a group.
  const parent = (groups[scope] ?? objects[scope])?.parentId ?? null;
  setScope(isGroupId(parent, groups) ? parent : null);
  set([scope], scope);
  return true;
}

/**
 * Outliner rule (plan §4.5): selecting a row sets the scope to that item's
 * parent group (root when it has none).
 * @param {string} id
 */
export function scopeToParentOf(id) {
  const { objects, groups } = getState().scene;
  const canonical = _canon(id);
  if (canonical == null) return;
  const parent = objects[canonical]?.parentId ?? groups[canonical]?.parentId ?? null;
  setScope(isGroupId(parent, groups) ? parent : null);
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
  getTransformTargets, isEffectivelyLocked,
  getScope, setScope, inPartScope, targetAtScope, resolveClick, enterScope, exitScope, scopeToParentOf,
  reconcile,
};
