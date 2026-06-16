import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { AssetLoader } from './AssetLoader.js';
import { canonicalObjectId, logicalObjectPartIds, logicalObjectLeadIds } from './LogicalObjects.js';

// Selection writes are silent against PROJECT_DIRTY — clicking around shouldn't
// flag the project as needing a save. The persisted schema (BLUEPRINT §11) still
// includes selection, it just isn't a dirty trigger.
const SILENT = { silent: true };

const VALID_PIVOTS = new Set(['world', 'median', 'active', 'individual', 'cursor']);

/**
 * Resolve a list of meshIds to live Babylon meshes, dropping unknowns / ghosts.
 * @param {string[]} ids
 * @returns {{ id: string, mesh: any }[]}
 */
function _resolve(ids) {
  const out = [];
  const objects = getState().scene.objects;
  const seen = new Set();
  for (const id of ids) {
    const partIds = logicalObjectPartIds(id, objects);
    for (const partId of (partIds.length ? partIds : [id])) {
      if (seen.has(partId)) continue;
      seen.add(partId);
      const obj = objects[partId];
      if (!obj || obj.isGhost) continue;
      const mesh = AssetLoader.getBabylonMesh(partId);
      if (mesh) out.push({ id: partId, mesh });
    }
  }
  return out;
}

function _applyVisuals() {
  const { selectedIds, activeId, pivotMode } = getState().selection;
  const objects = getState().scene.objects;
  const resolved = _resolve(selectedIds);
  // The ACTIVE object may be multi-part (multi-primitive / split) — every one
  // of its parts gets the active tint, not just the lead.
  const activePartIds = activeId ? new Set(logicalObjectPartIds(activeId, objects)) : new Set();
  const activeMeshes = resolved.filter(r => activePartIds.has(r.id)).map(r => r.mesh);
  const others = resolved.filter(r => !activePartIds.has(r.id)).map(r => r.mesh);
  const leadMesh = (activeId && resolved.find(r => r.id === activeId)?.mesh) || activeMeshes[0] || null;

  SceneManager.setActive(activeMeshes);
  SceneManager.setSelected(others);
  SceneManager.attachToSelection(resolved.map(r => r.mesh), pivotMode, leadMesh);
}

/**
 * Replace the current selection.
 * @param {string[]} ids
 * @param {string|null} [activeId]  Defaults to last id, or null if empty.
 */
export function set(ids, activeId) {
  const objects = getState().scene.objects;
  const cleaned = Array.from(new Set((ids ?? [])
    .map(id => canonicalObjectId(id, objects))
    .filter(id => id && objects[id] && !objects[id].isGhost)));
  const canonicalActive = activeId != null ? canonicalObjectId(activeId, objects) : null;
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
  const canonical = canonicalObjectId(id, getState().scene.objects);
  const { selectedIds } = getState().selection;
  if (selectedIds.includes(canonical)) { setActive(canonical); return; }
  set([...selectedIds, canonical], canonical);
}

/** Remove `id` from the selection. */
export function remove(id) {
  const canonical = canonicalObjectId(id, getState().scene.objects);
  const { selectedIds, activeId } = getState().selection;
  if (!selectedIds.includes(canonical)) return;
  const next = selectedIds.filter(x => x !== canonical);
  const nextActive = activeId === canonical ? (next[next.length - 1] ?? null) : activeId;
  set(next, nextActive);
}

/** Add or remove `id` depending on whether it's currently selected. */
export function toggle(id) {
  const canonical = canonicalObjectId(id, getState().scene.objects);
  const { selectedIds } = getState().selection;
  if (selectedIds.includes(canonical)) remove(canonical);
  else add(canonical);
}

/** Replace the active id. Must already be in the selection set. */
export function setActive(id) {
  const canonical = canonicalObjectId(id, getState().scene.objects);
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
  const canonical = canonicalObjectId(id, getState().scene.objects);
  return getState().selection.selectedIds.includes(canonical);
}

/** @returns {{ id: string, mesh: any }[]} */
export function getSelectedResolved() {
  return _resolve(getState().selection.selectedIds);
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
  getSelectedIds, getActiveId, contains, getSelectedResolved,
};
