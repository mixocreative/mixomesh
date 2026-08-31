/** Normalize persisted group provenance without risking deletion of old user groups. */
export function normalizeGroupOrigin(group) {
  return { ...group, origin: group.origin === 'import' ? 'import' : 'user' };
}

function _objects(state) {
  return state?.scene?.objects ?? {};
}

function _groups(state) {
  return state?.scene?.groups ?? {};
}

function _hasObject(id, state) {
  return !!_objects(state)[id];
}

function _hasGroup(id, state) {
  return !!_groups(state)[id];
}

function _parentIdOf(id, state) {
  return _objects(state)[id]?.parentId ?? _groups(state)[id]?.parentId ?? null;
}

function _assertNodeExists(id, state) {
  if (!_hasObject(id, state) && !_hasGroup(id, state)) {
    throw new Error(`Invalid hierarchy: missing node "${id}"`);
  }
}

/**
 * Validate a prospective hierarchy parent update. Mesh objects are leaf
 * geometry in the current runtime, so legal parents are groups or scene root.
 * @param {string} nodeId
 * @param {string|null} nextParentId
 * @param {object} state
 * @returns {true}
 */
export function validateParentChange(nodeId, nextParentId, state) {
  _assertNodeExists(nodeId, state);
  if (nextParentId == null) return true;
  if (nodeId === nextParentId) throw new Error('Invalid hierarchy: self-parent is not allowed');
  if (!_hasGroup(nextParentId, state)) throw new Error(`Invalid hierarchy: missing parent "${nextParentId}"`);

  const seen = new Set();
  let cursor = nextParentId;
  while (cursor) {
    if (cursor === nodeId) throw new Error('Invalid hierarchy: cycle would be created');
    if (seen.has(cursor)) throw new Error(`Invalid hierarchy: existing cycle at "${cursor}"`);
    seen.add(cursor);
    cursor = _parentIdOf(cursor, state);
  }
  return true;
}

/**
 * Validate every persisted parent edge in a scene snapshot.
 * @param {object} state
 * @returns {true}
 */
export function validateHierarchy(state) {
  for (const id of Object.keys(_objects(state))) validateParentChange(id, _objects(state)[id]?.parentId ?? null, state);
  for (const id of Object.keys(_groups(state))) validateParentChange(id, _groups(state)[id]?.parentId ?? null, state);
  return true;
}

/**
 * @param {Record<string, {id:string,parentId?: string|null}>} groups
 * @param {string|null} parentId
 * @returns {string[]}
 */
export function directSubgroupIds(groups, parentId) {
  return Object.values(groups ?? {})
    .filter(group => (group.parentId ?? null) === (parentId ?? null))
    .map(group => group.id);
}

/**
 * Return cleaned group membership and imported groups that become structurally
 * empty after removing scene objects. Input records are never mutated.
 */
export function planHierarchyRemoval(groups, removedObjectIds) {
  const next = Object.fromEntries(Object.entries(groups).map(([id, group]) => [
    id,
    {
      ...normalizeGroupOrigin(group),
      childIds: (group.childIds ?? []).filter(childId => !removedObjectIds.has(childId)),
    },
  ]));

  const pruneIds = [];
  const pruned = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of Object.values(next)) {
      if (group.origin !== 'import' || group.childIds.length || pruned.has(group.id)) continue;
      const hasLiveSubgroup = Object.values(next).some(candidate =>
        candidate.parentId === group.id && !pruned.has(candidate.id));
      if (hasLiveSubgroup) continue;
      pruneIds.push(group.id);
      pruned.add(group.id);
      changed = true;
    }
  }

  return { groups: next, pruneIds };
}
