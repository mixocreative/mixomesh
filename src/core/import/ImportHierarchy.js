function _isGeometryMesh(mesh) {
  return !!mesh?.geometry && (mesh.getTotalVertices?.() ?? 0) > 0;
}

function _isSyntheticRoot(node) {
  return String(node?.name ?? '') === '__root__';
}

function _nodeDepth(node) {
  let depth = 0;
  let current = node?.parent ?? null;
  while (current) { depth++; current = current.parent ?? null; }
  return depth;
}

function _isDescendantOf(node, ancestor) {
  let current = node?.parent ?? null;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent ?? null;
  }
  return false;
}

function _nearestGroupAncestor(node, groupNodes) {
  let current = node?.parent ?? null;
  while (current) {
    if (groupNodes.has(current)) return current;
    current = current.parent ?? null;
  }
  return null;
}

function _nearestGroupForMesh(mesh, groupIdByNode) {
  let current = mesh?.parent ?? null;
  while (current) {
    const id = groupIdByNode.get(current);
    if (id) return id;
    current = current.parent ?? null;
  }
  return null;
}

function _uniqueLocalName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${baseName}.dup`;
  usedNames.add(fallback);
  return fallback;
}

/**
 * Build outliner group records from meshless transform nodes that carry
 * geometry descendants. Blender's glTF "Full Collection Hierarchy" exports
 * collections this way, and manual Empty parents arrive in the same shape.
 */
export function buildImportHierarchy(container, makeId, uniqueName) {
  const meshes = (container?.meshes ?? []).filter(_isGeometryMesh);
  const candidates = (container?.transformNodes ?? [])
    .filter(node => node && !_isSyntheticRoot(node))
    .filter(node => meshes.some(mesh => _isDescendantOf(mesh, node)))
    .sort((a, b) => _nodeDepth(a) - _nodeDepth(b));

  const groupNodes = new Set(candidates);
  const groupIdByNode = new Map();
  const groupIdByMesh = new Map();
  const groups = {};
  const usedNames = new Set();

  for (const node of candidates) {
    const groupId = makeId('grp');
    groupIdByNode.set(node, groupId);
    node.metadata = { ...(node.metadata ?? {}), groupId, importHierarchy: true };
  }

  for (const node of candidates) {
    const id = groupIdByNode.get(node);
    const parentNode = _nearestGroupAncestor(node, groupNodes);
    const requestedName = uniqueName(String(node.name || 'Folder'));
    groups[id] = {
      id,
      name: _uniqueLocalName(requestedName, usedNames),
      childIds: [],
      parentId: parentNode ? groupIdByNode.get(parentNode) ?? null : null,
    };
  }

  for (const mesh of meshes) {
    const groupId = _nearestGroupForMesh(mesh, groupIdByNode);
    if (groupId) groupIdByMesh.set(mesh, groupId);
  }

  return {
    groups,
    groupIdByNode,
    groupIdForMesh(mesh) {
      return groupIdByMesh.get(mesh) ?? _nearestGroupForMesh(mesh, groupIdByNode);
    },
  };
}
