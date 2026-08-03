/** Normalize persisted group provenance without risking deletion of old user groups. */
export function normalizeGroupOrigin(group) {
  return { ...group, origin: group.origin === 'import' ? 'import' : 'user' };
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
