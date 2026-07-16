// Live import paths: blob/handle → AssetContainer → scene, with progress
// overlay, OBJ sibling resolution, split-on-import, library-GLB registration,
// and asset re-instantiation from the cached blob URL.

import { dispatch, setState, getState } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { SceneManager } from '../SceneManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { ProgressOverlay } from '../../ui/ProgressOverlay.js';
import { putHandle } from '../idb.js';
import { sha256Hex } from '../hash.js';
import {
  bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT,
} from '../ImportNormalizer.js';
import {
  extractModelRatio,
  findLibraryItemRoots,
  findLibraryRootByItem,
  isLibraryImport,
  isNodeWithinRoot,
} from '../import/ImportMetadata.js';
import { buildImportHierarchy } from '../import/ImportHierarchy.js';
import { SUPPORTED_EXTENSIONS, extOf } from './AssetTypes.js';
import { setBlobUrl, getBlobUrl, revokeBlobUrl } from './BlobUrls.js';
import {
  newId, registerContainer, removeContainer,
} from './MeshRegistry.js';
import {
  collectObjSiblings, rememberObjSiblings, getObjSiblings,
  installSiblingUrls, noteMissingMtl, revokeObjSiblings,
} from './ObjSiblings.js';
import { isWorkerImportSupported, loadObjContainerViaWorker } from '../WorkerImport.js';
import { splitMultiMaterialMeshesInContainer } from './MeshSplit.js';
import {
  uniqueHierarchyName, registerAssetEntry, registerInstantiatedMeshes,
  createCollectionFromFilename, queueValidation,
} from './AssetRegistration.js';
import { queueThumbnail } from './AssetThumbnail.js';
// Side-effect: registers the `.3mf` SceneLoader plugin so the LoadAssetContainer
// paths below (drop / re-instantiate / project restore) handle 3MF unchanged.
import '../ThreeMFLoader.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Import progress overlay (field request) ─────────────────────────────
// Imports block the UI thread during parse; the overlay stops false clicks
// and shows real byte progress where Babylon reports it. Ref-counted so a
// multi-file drop keeps one overlay up until the LAST import finishes.

let _importDepth = 0;

function _importBegin(label) {
  if (++_importDepth === 1) ProgressOverlay.show('Importing…');
  ProgressOverlay.update(0.02, label);
}

function _importProgress(filename) {
  return (evt) => {
    if (evt?.lengthComputable && evt.total > 0) {
      ProgressOverlay.update(0.02 + 0.73 * (evt.loaded / evt.total), `Reading ${filename}…`);
    } else {
      ProgressOverlay.update(0.4, `Reading ${filename}…`);
    }
  };
}

function _importEnd() {
  _importDepth = Math.max(0, _importDepth - 1);
  if (_importDepth === 0) ProgressOverlay.hide();
}

/**
 * Load an AssetContainer from a blob URL. OBJ parses in a worker when
 * available (Babylon's OBJ loader is a synchronous text parse — big files
 * freeze the UI for seconds on the main thread); any worker failure falls
 * back to the main-thread SceneLoader path, which the installed
 * PreprocessUrl sibling swap still covers.
 */
export async function loadContainer(blobUrl, ext, scene, onProgress, siblings) {
  if (ext === '.obj' && isWorkerImportSupported()) {
    try {
      return await loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress ?? undefined);
    } catch (err) {
      console.warn('OBJ worker parse failed — main-thread fallback:', err);
    }
  }
  return BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, onProgress, ext);
}

/**
 * Load an asset from a FileSystemFileHandle (Asset Panel drag).
 * @param {FileSystemFileHandle} fileHandle
 * @param {BABYLON.Vector3} [position]
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromHandle(fileHandle, position, opts = {}) {
  const file = await fileHandle.getFile();
  return loadFromBlob(file, file.name, position, opts);
}

// Resin-grey is applied ONLY to SHADERLESS meshes — those imported with NO
// material at all (STL / missing). Imported materials are NEVER touched, even
// if white: that is authored content.
//
// UNITY: shaderless OBJECTS are assigned the SAME `scene.defaultMaterial` that
// shaderless FACES (submesh slots with no material) already render with. One
// material, one place to tune the grey — `SceneManager.init` sets its colour.
// Change it there and both cases follow.
function _applyResinDefault(container) {
  const grey = SceneManager.getScene().defaultMaterial;
  for (const mesh of container.meshes ?? []) {
    if (!mesh.geometry) continue;            // skip root / transform nodes
    if (!mesh.material) mesh.material = grey; // shaderless → shared default; imports untouched
  }
}

/**
 * Load an asset from a Blob/File. Used by OS drag-drop and Asset Panel drops.
 * @param {Blob} blob
 * @param {string} filename
 * @param {BABYLON.Vector3} [position]
 * @param {{ originalPath?: string, directoryHandleKey?: string,
 *           fileHandle?: FileSystemFileHandle, fileHandleKey?: string }} [opts]
 *   `fileHandle` = a single-file handle (OS drag-drop via
 *   getAsFileSystemHandle) persisted to idb so the loose asset can relink;
 *   `fileHandleKey` = an already-persisted key (project restore path).
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromBlob(blob, filename, position, opts = {}) {
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const scene = SceneManager.getScene();
  const assetId = newId('asset');
  const blobUrl = URL.createObjectURL(blob);
  setBlobUrl(assetId, blobUrl);

  // §10b texture-identity scope: hash the source bytes once. Reused as the
  // AssetEntry contentHash so persistence doesn't re-hash at save time.
  let sourceFileHash = null;
  try { sourceFileHash = await sha256Hex(await blob.arrayBuffer()); }
  catch { /* hash is an identity optimisation — import proceeds without it */ }

  // OBJ: resolve mtllib/texture references against drop-set or directory
  // siblings (blob URLs have no usable base URL).
  let siblings = null;
  if (ext === '.obj') {
    siblings = await collectObjSiblings(opts);
    if (siblings.size) rememberObjSiblings(assetId, siblings);
    noteMissingMtl(blob, filename, siblings);   // fire-and-forget, console only
  }

  _importBegin(`Reading ${filename}…`);
  const restoreUrls = installSiblingUrls(siblings);

  try {
    const container = await loadContainer(blobUrl, ext, scene, _importProgress(filename), siblings);
    ProgressOverlay.update(0.8, `Materials for ${filename}…`);

    const sourceUnit = DEFAULT_SOURCE_UNIT;
    const modelRatio = extractModelRatio(container) ?? 1;

    if (await _tryRegisterLibraryImport({
      container, blob, filename, ext, opts,
      initialAssetId: assetId,
      initialBlobUrl: blobUrl,
      sourceFileHash,
      sourceUnit,
      modelRatio,
    })) {
      ProgressOverlay.update(0.98, `${filename} added to assets`);
      try { container.dispose?.(); } catch { /* not scene-owned */ }
      return [];
    }

    registerContainer(assetId, container);

    // One-mesh-one-shader invariant: any MultiMaterial mesh splits into
    // N single-material siblings, each stamped with a shared sourceGroupId.
    // Runs BEFORE registerFromContainer so MultiMaterial wrappers are gone
    // before ShaderLibrary walks container.materials.
    splitMultiMaterialMeshesInContainer(container);

    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash,
    });

    ProgressOverlay.update(0.9, `Adding ${filename} to scene…`);
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName);
    container.addAllToScene();
    _applyResinDefault(container);   // AFTER add — container meshes have geometry bound now

    // Apply unit + working-ratio scaling. modelRatio comes from a glTF "ratio"
    // custom property if present (Blender custom prop), else 1:1. The result is
    // that 1 BU in the scene == 1 m at the scene's working ratio (its print size).
    // Export-time rescaling from working → target ratio happens in PrintManager.
    bakeImportTransform(container, importScaleFactor(sourceUnit, modelRatio), position);

    // OS drag-drop has no directory handle, but Chrome's
    // DataTransferItem.getAsFileSystemHandle() yields a single FILE handle.
    // Persisting it gives a loose drop a relink path of its own (resolved in
    // PersistenceManager between dir-scan and the embedded snapshot). Without
    // this a dragged file is a permanent frozen snapshot. Best-effort: idb may
    // refuse the structured clone — the embedded copy still guarantees reopen.
    const fileHandleKey = await _fileHandleKeyFor(assetId, opts);

    const entry = {
      id: assetId,
      name: filename.replace(/\.[^.]+$/, ''),
      filename,
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
    };
    registerAssetEntry(entry);

    const collectionId = createCollectionFromFilename(filename, assetId);
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, modelRatio);

    ProgressOverlay.update(0.98, `${filename} ready`);

    queueThumbnail(assetId);
    for (const meshId of meshIds) queueValidation(meshId);

    return meshIds;
  } catch (err) {
    revokeBlobUrl(assetId);
    revokeObjSiblings(assetId);
    removeContainer(assetId);
    throw err;
  } finally {
    restoreUrls();
    _importEnd();
  }
}

/**
 * Re-instantiate an already-loaded asset at a new drop position.
 * Reloads from the cached blob URL so we get full Mesh objects (not InstancedMesh)
 * through the normal registration path, giving independent outliner entries.
 * @param {string} assetId
 * @param {BABYLON.Vector3} position
 * @returns {Promise<string[]>} new meshIds
 */
export async function instantiateAsset(assetId, position) {
  const asset = getState().scene.assetLibrary[assetId];
  if (!asset) throw new Error(`Asset ${assetId} not in library`);

  const blobUrl = getBlobUrl(assetId);
  if (!blobUrl) throw new Error(`No cached data for ${asset.filename} — cannot re-instantiate`);

  const scene = SceneManager.getScene();
  _importBegin(`Reading ${asset.filename}…`);
  // Re-instantiated OBJs need their sibling map again for MTL/textures.
  const siblings = getObjSiblings(assetId);
  const restoreUrls = installSiblingUrls(siblings);
  try {
    const container = await loadContainer(
      blobUrl, asset.extension, scene, _importProgress(asset.filename), siblings
    );
    if (asset.libraryItem) filterContainerToLibraryItem(container, asset.libraryItem);
    splitMultiMaterialMeshesInContainer(container);
    registerContainer(assetId, container);
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash: asset.contentHash ?? null,
    });
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName);
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);

    const collectionId = createCollectionFromFilename(asset.displayName ?? asset.filename, assetId);
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, asset.modelRatio ?? 1);
    for (const meshId of meshIds) queueValidation(meshId);
    return meshIds;
  } finally {
    restoreUrls();
    _importEnd();
  }
}

async function _fileHandleKeyFor(assetId, opts = {}) {
  let fileHandleKey = opts.fileHandleKey ?? null;
  if (!fileHandleKey && opts.fileHandle && !opts.directoryHandleKey) {
    fileHandleKey = `fh_${assetId}`;
    try { await putHandle(fileHandleKey, opts.fileHandle); }
    catch { fileHandleKey = null; }
  }
  return fileHandleKey;
}

function _stripExtension(filename) {
  return String(filename || 'asset').replace(/\.[^.]+$/, '');
}

function _safePartName(value) {
  return String(value || 'Object').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'Object';
}

async function _tryRegisterLibraryImport({
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
      setBlobUrl(assetId, assetBlobUrl);
      createdIds.push(assetId);

      const fileHandleKey = await _fileHandleKeyFor(assetId, opts);
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
