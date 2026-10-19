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
