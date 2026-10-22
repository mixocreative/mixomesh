// Library-GLB imports: a glTF tagged as a Mixo library pack (ImportMetadata)
// registers one asset per geometry-bearing root instead of landing in the
// scene, and a later "add to scene" trims a fresh container down to that
// one item's subtree.

import { dispatch, setState } from '../StateManager.js';
import { EVENTS } from '../events.js';
import {
  findLibraryItemRoots, findLibraryRootByItem, isLibraryImport, isNodeWithinRoot,
} from '../import/ImportMetadata.js';
import { setBlobUrl, revokeBlobUrl } from './BlobUrls.js';
import { newId } from './MeshRegistry.js';

function _stripExtension(filename) {
  return String(filename || 'asset').replace(/\.[^.]+$/, '');
}

function _safePartName(value) {
  return String(value || 'Object').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'Object';
}

/**
 * Register a library pack's items as assets. Returns false (and nothing
 * registered) when the file is not a library pack or registration failed,
 * so the caller runs the normal import.
 */
export async function tryRegisterLibraryImport({
  container, blob, filename, ext, opts, initialAssetId, initialBlobUrl,
  sourceFileHash, sourceUnit, modelRatio,
}) {
  if ((ext !== '.glb' && ext !== '.gltf') || !isLibraryImport(container)) return false;

  const createdIds = [];
  try {
    const roots = findLibraryItemRoots(container);
    if (!roots.length) throw new Error('No geometry-bearing library objects found.');

    const sourceStem = _stripExtension(filename);
    const entries = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const assetId = i === 0 ? initialAssetId : newId('asset');
      const assetBlobUrl = i === 0 ? initialBlobUrl : URL.createObjectURL(blob);
      setBlobUrl(assetId, assetBlobUrl, blob);
      createdIds.push(assetId);

      const fileHandleKey = opts.fileHandleKey ?? null;
      const partName = _safePartName(root.name);
      entries.push({
        id: assetId,
        name: partName,
        displayName: `${sourceStem} / ${partName}`,
        filename: `${sourceStem}__${partName}${ext}`,
        originalPath: opts.originalPath ?? filename,
        extension: ext,
        kind: 'mesh',
        sourceUnit,
        unitConfirmed: true,
        modelRatio,
        directoryHandleKey: opts.directoryHandleKey ?? null,
        fileHandleKey,
        contentHash: sourceFileHash,
        thumbnailDataUrl: null,
        libraryItem: {
          sourceFilename: filename,
          rootName: root.name,
          rootPath: root.path,
        },
      });
    }

    setState(s => {
      const next = { ...s.scene.assetLibrary };
      for (const entry of entries) next[entry.id] = entry;
      return { ...s, scene: { ...s.scene, assetLibrary: next } };
    }, { silent: true });
    for (const entry of entries) dispatch(EVENTS.ASSET_REGISTERED, { assetId: entry.id, entry });
    return true;
  } catch (err) {
    console.warn(`${filename}: library import failed, falling back to normal GLB import:`, err);
    for (const id of createdIds) {
      if (id !== initialAssetId) revokeBlobUrl(id);
    }
    return false;
  }
}

/**
 * Trim a loaded container down to ONE library item's node subtree (meshes,
 * transform ancestors/descendants, used materials); everything else disposes.
 */
export function filterContainerToLibraryItem(container, libraryItem) {
  const root = findLibraryRootByItem(container, libraryItem);
  if (!root) {
    throw new Error(`Library object not found: ${libraryItem?.rootPath ?? libraryItem?.rootName ?? 'unknown'}`);
  }

  const allMeshes = container.meshes ?? [];
  const allTransforms = container.transformNodes ?? [];
  const keepMeshes = allMeshes.filter(mesh =>
    mesh === root.node || isNodeWithinRoot(mesh, root.node));
  if (!keepMeshes.some(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0)) {
    throw new Error(`Library object has no geometry: ${root.path || root.name}`);
  }

  const keepTransforms = new Set();
  let ancestor = root.node;
  while (ancestor) {
    if (allTransforms.includes(ancestor)) keepTransforms.add(ancestor);
    ancestor = ancestor.parent;
  }
  for (const t of allTransforms) {
    if (isNodeWithinRoot(t, root.node)) keepTransforms.add(t);
  }

  for (const mesh of allMeshes) {
    if (!keepMeshes.includes(mesh)) {
      try { mesh.dispose?.(); } catch { /* not scene-owned */ }
    }
  }
  for (const node of allTransforms) {
    if (!keepTransforms.has(node)) {
      try { node.dispose?.(); } catch { /* not scene-owned */ }
    }
  }

  const usedMaterials = new Set(keepMeshes.map(m => m.material).filter(Boolean));
  container.meshes = keepMeshes;
  container.transformNodes = allTransforms.filter(t => keepTransforms.has(t));
  if (Array.isArray(container.materials) && usedMaterials.size) {
    container.materials = container.materials.filter(mat => usedMaterials.has(mat));
  }
}
