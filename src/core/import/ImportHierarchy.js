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
/** Bottom-centre (centre X/Z, min Y) of the meshes' world AABBs, or null. */
export function bottomCentreOfMeshes(meshes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const m of meshes) {
    m.computeWorldMatrix?.(true);
    const bb = m.getBoundingInfo?.()?.boundingBox;
    if (!bb?.minimumWorld || !bb?.maximumWorld) continue;
    minX = Math.min(minX, bb.minimumWorld.x); minY = Math.min(minY, bb.minimumWorld.y);
    minZ = Math.min(minZ, bb.minimumWorld.z);
    maxX = Math.max(maxX, bb.maximumWorld.x); maxZ = Math.max(maxZ, bb.maximumWorld.z);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: minY, z: (minZ + maxZ) / 2 };
}

/**
 * @param {object} container
 * @param {(prefix:string)=>string} makeId
 * @param {(name:string)=>string} uniqueName
 * @param {{ fileName?: string }} [opts]  `fileName` (stem, no extension): when
 *   the file holds MORE THAN ONE logical object (material parts of one object
 *   count once) the result carries a `fileGroupId`: one user group named after
 *   the file that adopts every top-level object/group. Omit to never wrap.
 */
export function buildImportHierarchy(container, makeId, uniqueName, opts = {}) {
  const meshes = (container?.meshes ?? []).filter(_isGeometryMesh);
  const allCandidates = (container?.transformNodes ?? [])
    .filter(node => node && !_isSyntheticRoot(node))
    .filter(node => meshes.some(mesh => _isDescendantOf(mesh, node)))
    .sort((a, b) => _nodeDepth(a) - _nodeDepth(b));

  // Origin node of every mesh, captured BEFORE the bake detaches it: the
  // logical-object key in AssetRegistration groups `<stem>_primitive<N>`
  // siblings by (origin node, stem), so two different nodes that happen to
  // carry same-named primitives never merge into one object.
  const originKeyByMesh = new Map();
  for (const mesh of meshes) {
    const parent = mesh.parent ?? null;
    originKeyByMesh.set(mesh, parent ? `n${parent.uniqueId ?? parent.name ?? ''}` : 'root');
  }

  // A wrapper node becomes an Outliner GROUP only when it has two or more
  // structural children — logical objects (a multi-primitive mesh counts
  // once) and/or surviving sub-groups. Single-child wrappers (the glTF node
  // that merely holds one mesh, or a chain of empties around one assembly)
  // collapse: they carried nothing the user could act on and showed every
  // single-object scan as three rows (owner decision 2026-09-18; matches
  // Blender / PrusaSlicer: one row per object, hierarchy only when authored
  // with several objects). Decided deepest-first so a parent sees its
  // children's verdicts.
  const survivors = new Set(allCandidates);
  const nearestSurvivor = (node) => {
    let current = node?.parent ?? null;
    while (current) {
      if (survivors.has(current)) return current;
      current = current.parent ?? null;
    }
    return null;
  };
  const stemOf = (mesh) => {
    const m = /^(.*)_primitive\d+$/.exec(String(mesh?.name ?? ''));
    return m ? m[1] : `#${mesh?.uniqueId ?? mesh?.name ?? ''}`;
  };
  // One printable object = material parts together: the MultiMaterial split's
  // shared `sourceGroupId`, or glTF `_primitive<N>` siblings of one origin node.
  const logicalKeyOf = (mesh) => {
    const sg = mesh?.metadata?.sourceGroupId;
    return sg ? `sg:${sg}` : `${originKeyByMesh.get(mesh)}|${stemOf(mesh)}`;
  };
  for (const node of [...allCandidates].sort((a, b) => _nodeDepth(b) - _nodeDepth(a))) {
    const logical = new Set();
    for (const mesh of meshes) {
      if (nearestSurvivor(mesh) === node) logical.add(logicalKeyOf(mesh));
    }
    let subgroups = 0;
    for (const other of survivors) if (other !== node && nearestSurvivor(other) === node) subgroups++;
    if (logical.size + subgroups < 2) survivors.delete(node);
  }
  const candidates = allCandidates.filter(node => survivors.has(node));

  const groupNodes = new Set(candidates);
  const groupIdByNode = new Map();
  const groupIdByMesh = new Map();
  const groups = {};
  const usedNames = new Set();

  // Multi-object file → ONE user group named after the file (declared first so
  // it owns the plain name; inner groups uniquify around it).
  let fileGroupId = null;
  if (opts.fileName && new Set(meshes.map(logicalKeyOf)).size > 1) {
    fileGroupId = makeId('grp');
    groups[fileGroupId] = {
      id: fileGroupId,
      name: _uniqueLocalName(uniqueName(String(opts.fileName)), usedNames),
      childIds: [],
      parentId: null,
      origin: 'user',
    };
  }

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
      parentId: parentNode ? groupIdByNode.get(parentNode) ?? null : fileGroupId,
      origin: 'import',
    };
  }

  for (const mesh of meshes) {
    const groupId = _nearestGroupForMesh(mesh, groupIdByNode) ?? fileGroupId;
    if (groupId) groupIdByMesh.set(mesh, groupId);
  }

  return {
    groups,
    groupIdByNode,
    /** Id of the file-named wrapper group, or null (single logical object). */
    fileGroupId,
    groupIdForMesh(mesh) {
      return groupIdByMesh.get(mesh) ?? _nearestGroupForMesh(mesh, groupIdByNode) ?? fileGroupId;
    },
    /**
     * Create the wrapper's runtime TransformNode. Call AFTER bakeImportTransform
     * (meshes are then world-positioned, parentless; group nodes identity at
     * the origin). Origin = bottom-centre of the content (2.3 rule); direct
     * children get the inverse offset so nothing moves in world space.
     */
    attachFileGroup(scene) {
      if (!fileGroupId) return null;
      const BABYLON = window.BABYLON;
      const node = new BABYLON.TransformNode(groups[fileGroupId].name, scene);
      node.metadata = { ...(node.metadata ?? {}), groupId: fileGroupId };
      const c = bottomCentreOfMeshes(meshes) ?? { x: 0, y: 0, z: 0 };
      if (node.position?.set) node.position.set(c.x, c.y, c.z);
      else node.position = new BABYLON.Vector3(c.x, c.y, c.z);
      const tops = [
        ...candidates.filter(n => groups[groupIdByNode.get(n)].parentId === fileGroupId),
        ...meshes.filter(m => groupIdByMesh.get(m) === fileGroupId),
      ];
      for (const child of tops) {
        child.parent = node;
        child.position.x -= c.x; child.position.y -= c.y; child.position.z -= c.z;
      }
      node.computeWorldMatrix?.(true);
      return node;
    },
    /** Stable key of the node the mesh was authored under (pre-bake). */
    originNodeKey(mesh) {
      return originKeyByMesh.get(mesh) ?? null;
    },
  };
}
