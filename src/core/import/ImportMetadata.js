import { parseScaleRatioText } from '../scale/ScaleMath.js';

const LIBRARY_MODE = 'library';

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

function _mixomeshBag(extras) {
  const direct = _extraValue(extras, 'mixomesh');
  if (direct && typeof direct === 'object') return direct;
  return null;
}

function _nodeImportMode(node) {
  const extras = _extras(node);
  if (!extras) return null;
  const flat = _extraValue(extras, 'mixomeshImportMode');
  const nested = _extraValue(_mixomeshBag(extras), 'importMode');
  const value = flat ?? nested;
  return value == null ? null : String(value).trim().toLowerCase();
}

function _isGeometryMesh(mesh) {
  return !!mesh?.geometry && (mesh.getTotalVertices?.() ?? 0) > 0;
}

function _isSyntheticRoot(node) {
  return String(node?.name ?? '') === '__root__';
}

function _isLibraryBoundary(node) {
  return _isSyntheticRoot(node) || _nodeImportMode(node) === LIBRARY_MODE;
}

function _libraryRootForMesh(mesh) {
  let current = mesh;
  while (current?.parent && !_isLibraryBoundary(current.parent)) {
    current = current.parent;
  }
  return current;
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

export function getImportMode(container) {
  for (const node of _metadataNodes(container)) {
    const mode = _nodeImportMode(node);
    if (mode) return mode;
  }
  return null;
}

export function isLibraryImport(container) {
  return getImportMode(container) === LIBRARY_MODE;
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
