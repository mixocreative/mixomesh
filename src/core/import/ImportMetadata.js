import { parseScaleRatioText } from '../scale/ScaleMath.js';

function _metadataNodes(container) {
  return [...(container?.meshes ?? []), ...(container?.transformNodes ?? [])];
}

function _extras(node) {
  return node?.metadata?.gltf?.extras ?? null;
}

function _normKey(key) {
  return String(key ?? '').replace(/[-_\s]/g, '').toLowerCase();
}

function _extraValue(extras, wantedKey) {
  if (!extras || typeof extras !== 'object') return undefined;
  const wanted = _normKey(wantedKey);
  for (const [key, value] of Object.entries(extras)) {
    if (_normKey(key) === wanted) return value;
  }
  return undefined;
}

const MIXO_ORIGIN = 'mixo3d';
const MIXO_MARKER_VERSION = 1;
const MIXO_REFINEMENT_VERSION = 1;
const MIXO_MARKER_KEYS = Object.freeze([
  'mixo_origin',
  'mixo_marker_version',
  'mixo_viewport_subdiv_level',
  'mixo_render_subdiv_level',
]);

function _mixoMarkerOwnFieldCount(extras) {
  return MIXO_MARKER_KEYS.filter(key => Object.hasOwn(extras, key)).length;
}

function _validSubdivLevel(value) {
  return Number.isInteger(value) && value >= 0;
}

function _parseMixoMarker(extras) {
  const ownFieldCount = _mixoMarkerOwnFieldCount(extras);
  if (ownFieldCount === 0) return undefined;
  // A nearest node that declares any marker field owns the decision. It must
  // declare the complete marker itself; prototype-inherited values never fill
  // a partial marker or permit a marked ancestor to authenticate it.
  if (ownFieldCount !== MIXO_MARKER_KEYS.length) return null;
  return normalizeMixoProvenance({
    origin: extras.mixo_origin,
    markerVersion: extras.mixo_marker_version,
    viewportSubdivLevel: extras.mixo_viewport_subdiv_level,
    renderSubdivLevel: extras.mixo_render_subdiv_level,
  });
}

/** Normalize only the versioned provenance persisted on a logical-object lead. */
export function normalizeMixoProvenance(value) {
  if (!value || typeof value !== 'object'
    || value.origin !== MIXO_ORIGIN
    || value.markerVersion !== MIXO_MARKER_VERSION
    || !_validSubdivLevel(value.viewportSubdivLevel)
    || !_validSubdivLevel(value.renderSubdivLevel)) return null;
  return {
    origin: MIXO_ORIGIN,
    markerVersion: MIXO_MARKER_VERSION,
    viewportSubdivLevel: value.viewportSubdivLevel,
    renderSubdivLevel: value.renderSubdivLevel,
  };
}

/**
 * Read the closest glTF node marker for a Babylon mesh. A declared but invalid
 * marker deliberately blocks ancestor fallback, so arbitrary or newer files
 * can never be mistaken for a compatible Mixo-authored import.
 * @param {object|null|undefined} node Babylon mesh or transform node
 * @returns {{origin:'mixo3d', markerVersion:1, viewportSubdivLevel:number, renderSubdivLevel:number}|null}
 */
export function extractMixoProvenance(node) {
  let current = node;
  while (current) {
    const parsed = _parseMixoMarker(_extras(current) ?? {});
    if (parsed !== undefined) return parsed;
    current = current.parent;
  }
  return null;
}

function _vertexCount(node) {
  const count = node?.getTotalVertices?.();
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/** Stable identity for one glTF primitive across import and project restore. */
export function mixoPrimitiveId(mesh) {
  const id = mesh?.metadata?.mixoPrimitiveId;
  return typeof id === 'string' && id ? id : `mesh:${String(mesh?.metadata?.sourceMeshName || mesh?.name || 'primitive')}`;
}

function _sharpWeightBits(weight) {
  const bytes = new ArrayBuffer(4);
  new DataView(bytes).setFloat32(0, weight, true);
  return new DataView(bytes).getUint32(0, true);
}

/** Decode the Float32 weight stored in a normalized sharp-edge Uint32 triple. */
export function mixoSharpEdgeWeight(bits) {
  const bytes = new ArrayBuffer(4);
  new DataView(bytes).setUint32(0, bits, true);
  return new DataView(bytes).getFloat32(0, true);
}

/**
 * Validate a primitive-local Mixo refinement payload. The Uint32 edge triples
 * retain fractional weights as IEEE-754 bits in their third member, keeping
 * the public descriptor's topology buffer compact without losing precision.
 */
export function normalizeMixoRefinement(value, vertexCount) {
  const hasCreases = Object.hasOwn(value ?? {}, 'creaseByVertex');
  const creases = hasCreases ? value.creaseByVertex : null;
  const edges = Object.hasOwn(value ?? {}, 'sharpEdges') ? value.sharpEdges : [];
  if (!value || typeof value !== 'object'
    || !Object.hasOwn(value, 'version')
    || value.version !== MIXO_REFINEMENT_VERSION
    || !Number.isInteger(vertexCount) || vertexCount < 0
    || (hasCreases && (!Array.isArray(creases) || creases.length !== vertexCount))
    || !Array.isArray(edges)) return null;
  const creaseByVertex = new Float32Array(vertexCount);
  if (creases) {
    for (let i = 0; i < vertexCount; i++) {
      const crease = creases[i];
      if (!Number.isFinite(crease)) return null;
      creaseByVertex[i] = Math.min(1, Math.max(0, crease));
    }
  }
  const sharpEdges = new Uint32Array(edges.length * 3);
  for (let i = 0; i < edges.length; i++) {
    const row = edges[i];
    if (!Array.isArray(row) || row.length !== 3 || !Object.hasOwn(row, 0) || !Object.hasOwn(row, 1) || !Object.hasOwn(row, 2)) return null;
    const [v0, v1, weight] = row;
    if (!Number.isInteger(v0) || !Number.isInteger(v1)
      || v0 < 0 || v1 < 0 || v0 >= vertexCount || v1 >= vertexCount || v0 === v1
      || !Number.isFinite(weight)) return null;
    sharpEdges[i * 3] = v0;
    sharpEdges[i * 3 + 1] = v1;
    sharpEdges[i * 3 + 2] = _sharpWeightBits(Math.min(1, Math.max(0, weight)));
  }
  return { version: MIXO_REFINEMENT_VERSION, creaseByVertex, sharpEdges };
}

/**
 * Read only a mesh's own primitive extras. A payload on an ancestor is never
 * inherited: its indices are local to a glTF primitive, not a Blender node.
 */
export function extractMixoRefinement(mesh) {
  if (!extractMixoProvenance(mesh)) return null;
  const vertexCount = _vertexCount(mesh);
  if (vertexCount == null) return null;
  const payload = mesh?.metadata?.mixoPrimitiveRefinement;
  return normalizeMixoRefinement(payload, vertexCount);
}

function _isLibraryMarkerNode(node) {
  const extras = _extras(node);
  if (!extras) return false;
  const value = _extraValue(extras, 'library');
  return value === 1 || value === true || String(value ?? '').trim() === '1';
}

function _isGeometryMesh(mesh) {
  return !!mesh?.geometry && (mesh.getTotalVertices?.() ?? 0) > 0;
}

function _isSyntheticRoot(node) {
  return String(node?.name ?? '') === '__root__';
}

function _isLibraryBoundary(node) {
  return _isSyntheticRoot(node) || _isLibraryMarkerNode(node);
}

function _libraryMarkerNodes(container) {
  return _metadataNodes(container).filter(node => _isLibraryMarkerNode(node));
}

function _libraryRootForMesh(mesh) {
  let current = mesh;
  while (current?.parent && !_isLibraryBoundary(current.parent)) {
    current = current.parent;
  }
  return current;
}

function _directChildUnderBoundary(node, boundary) {
  if (node === boundary) return node;
  let current = node;
  let child = null;
  while (current && current !== boundary) {
    child = current;
    current = current.parent;
  }
  return current === boundary ? child : null;
}

function _nodePathFromBoundary(node, boundary) {
  if (node === boundary) return String(node?.name || 'Object');
  const parts = [];
  let current = node;
  while (current && current !== boundary) {
    parts.push(String(current.name || 'Object'));
    current = current.parent;
  }
  return current === boundary ? parts.reverse().join('/') : nodeLibraryPath(node);
}

function _collectRootsFromBoundaries(container, boundaries) {
  const out = [];
  const seen = new Set();
  for (const boundary of boundaries) {
    for (const mesh of container?.meshes ?? []) {
      if (!_isGeometryMesh(mesh)) continue;
      const root = _directChildUnderBoundary(mesh, boundary);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      out.push({
        node: root,
        name: String(root.name || mesh.name || 'Object'),
        path: _nodePathFromBoundary(root, boundary),
      });
    }
  }
  return out;
}

export function extractModelRatio(container) {
  for (const node of _metadataNodes(container)) {
    const extras = _extras(node);
    if (!extras) continue;
    const raw = _extraValue(extras, 'ratio');
    if (raw == null) continue;
    const parsed = parseScaleRatioText(raw);
    if (parsed) return parsed;
  }
  return null;
}

export function isLibraryImport(container) {
  return _libraryMarkerNodes(container).length > 0;
}

export function nodeLibraryPath(node) {
  const parts = [];
  let current = node;
  while (current && !_isLibraryBoundary(current)) {
    parts.push(String(current.name || 'Object'));
    current = current.parent;
  }
  return parts.reverse().join('/');
}

export function isNodeWithinRoot(node, root) {
  let current = node;
  while (current) {
    if (current === root) return true;
    if (_isLibraryBoundary(current)) return false;
    current = current.parent;
  }
  return false;
}

export function findLibraryItemRoots(container) {
  const markers = _libraryMarkerNodes(container);
  if (markers.length) return _collectRootsFromBoundaries(container, markers);

  const out = [];
  const seen = new Set();
  for (const mesh of container?.meshes ?? []) {
    if (!_isGeometryMesh(mesh)) continue;
    const root = _libraryRootForMesh(mesh);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push({
      node: root,
      name: String(root.name || mesh.name || 'Object'),
      path: nodeLibraryPath(root),
    });
  }
  return out;
}

export function findLibraryRootByItem(container, item) {
  const roots = findLibraryItemRoots(container);
  const rootPath = item?.rootPath;
  const rootName = item?.rootName;
  if (rootPath) {
    const byPath = roots.find(r => r.path === rootPath);
    if (byPath) return byPath;
  }
  if (rootName) {
    const byName = roots.find(r => r.name === rootName);
    if (byName) return byName;
  }
  return null;
}
