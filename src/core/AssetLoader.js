// Mesh-asset loading, registration, instancing, and project restore.
// Texture assets live in ./assets/TextureAssets.js, the split-on-import
// invariant in ./assets/MeshSplit.js, and the shared blob-URL registry in
// ./assets/BlobUrls.js (review L29 split) — all re-exported below so the
// AssetLoader public surface is unchanged.

import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { ProgressOverlay } from '../ui/ProgressOverlay.js';
import { putHandle } from './idb.js';
import { sha256Hex } from './hash.js';
import {
  bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT,
} from './ImportNormalizer.js';
import {
  extractModelRatio,
  findLibraryItemRoots,
  findLibraryRootByItem,
  isLibraryImport,
  isNodeWithinRoot,
} from './import/ImportMetadata.js';
import { buildImportHierarchy } from './import/ImportHierarchy.js';
import {
  SUPPORTED_EXTENSIONS,
  extOf as _extOf,
  isMeshExt,
  isTextureExt,
} from './assets/AssetTypes.js';
import { setBlobUrl, getBlobUrl, revokeBlobUrl, revokeAllBlobUrls } from './assets/BlobUrls.js';
import {
  newId as _newId,
  getContainer, registerContainer, removeContainer,
  getBabylonMesh, registerMesh, hasMesh, trackOrphan,
  getContainerGeomMeshes, bindRestoredMesh, resetRegistry,
} from './assets/MeshRegistry.js';
import { mountDirectory, restoreDirectory, getDirectoryHandle } from './assets/DirMounts.js';
import {
  collectObjSiblings, rememberObjSiblings, getObjSiblings,
  installSiblingUrls, noteMissingMtl, revokeObjSiblings, revokeAllObjSiblings,
} from './assets/ObjSiblings.js';
import {
  uniqueHierarchyName as _uniqueHierarchyName,
  nextDupName as _nextDupName,
  registerAssetEntry as _registerAssetEntry,
  registerInstantiatedMeshes as _registerInstantiatedMeshes,
  createCollectionFromFilename as _createCollectionFromFilename,
  queueValidation as _queueValidation,
} from './assets/AssetRegistration.js';
import { queueThumbnail } from './assets/AssetThumbnail.js';
import { isWorkerImportSupported, loadObjContainerViaWorker } from './WorkerImport.js';
import {
  splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer,
} from './assets/MeshSplit.js';
import {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture,
  releaseTextureAsset, resetTextures, recapAllTextures,
} from './assets/TextureAssets.js';
// Side-effect: registers the `.3mf` SceneLoader plugin so the LoadAssetContainer
// paths below (drop / re-instantiate / project restore) handle 3MF unchanged.
import './ThreeMFLoader.js';

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
async function _loadContainer(blobUrl, ext, scene, onProgress, siblings) {
  if (ext === '.obj' && isWorkerImportSupported()) {
    try {
      return await loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress ?? undefined);
    } catch (err) {
      console.warn('OBJ worker parse failed — main-thread fallback:', err);
    }
  }
  return BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, onProgress, ext);
}

// ── Public API ───────────────────────────────────────────

// Directory mounts — owned by ./assets/DirMounts.js, re-exported so the
// AssetLoader surface stays unchanged.
export { mountDirectory, restoreDirectory, getDirectoryHandle };

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

export async function loadFromBlob(blob, filename, position, opts = {}) {
  const ext = _extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const scene = SceneManager.getScene();
  const assetId = _newId('asset');
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
    const container = await _loadContainer(blobUrl, ext, scene, _importProgress(filename), siblings);
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
    const hierarchy = buildImportHierarchy(container, _newId, _uniqueHierarchyName);
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
    _registerAssetEntry(entry);

    const collectionId = _createCollectionFromFilename(filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, modelRatio);

    ProgressOverlay.update(0.98, `${filename} ready`);

    queueThumbnail(assetId);
    for (const meshId of meshIds) _queueValidation(meshId);

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
    const container = await _loadContainer(
      blobUrl, asset.extension, scene, _importProgress(asset.filename), siblings
    );
    if (asset.libraryItem) _filterContainerToLibraryItem(container, asset.libraryItem);
    splitMultiMaterialMeshesInContainer(container);
    registerContainer(assetId, container);
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash: asset.contentHash ?? null,
    });
    const hierarchy = buildImportHierarchy(container, _newId, _uniqueHierarchyName);
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);

    const collectionId = _createCollectionFromFilename(asset.displayName ?? asset.filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, asset.modelRatio ?? 1);
    for (const meshId of meshIds) _queueValidation(meshId);
    return meshIds;
  } finally {
    restoreUrls();
    _importEnd();
  }
}

/**
 * Dispose an asset's container / texture if no SceneObjects or shaders still
 * reference it.
 * @param {string} assetId
 */
export function releaseAsset(assetId) {
  const entry = getState().scene.assetLibrary[assetId];
  if (!entry) return;

  if (entry.kind === 'texture') {
    // Refuses while any shader still points at this texture.
    if (!releaseTextureAsset(assetId, entry)) return;
  } else {
    const stillLinked = Object.values(getState().scene.objects).some(o => o.assetId === assetId && !o.isGhost);
    if (stillLinked) return;
    const container = getContainer(assetId);
    if (container) {
      container.removeAllFromScene();
      container.dispose();
      removeContainer(assetId);
    }
    revokeBlobUrl(assetId);
    revokeObjSiblings(assetId);
  }

  setState(s => {
    const next = { ...s.scene.assetLibrary };
    delete next[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: next } };
  }, { silent: true });
}

// Registry lookups — owned by ./assets/MeshRegistry.js, re-exported so the
// AssetLoader surface stays unchanged.
export { getContainer, getBabylonMesh, getContainerGeomMeshes, bindRestoredMesh };

/**
 * Clone an existing SceneObject — duplicates the Babylon mesh and registers
 * a new SceneObject entry referencing the same assetId / shader. The clone
 * appears offset from the source so it doesn't z-fight.
 *
 * @param {string} sourceMeshId
 * @param {{ x?:number, y?:number, z?:number }} [worldOffset]  In BU.
 * @returns {string|null} the new meshId, or null on failure
 */
export function cloneMeshAsNewObject(sourceMeshId, worldOffset) {
  const sourceMesh = getBabylonMesh(sourceMeshId);
  const sourceObj  = getState().scene.objects[sourceMeshId];
  if (!sourceMesh || !sourceObj) return null;

  const newId = _newId('mesh');
  const clone = sourceMesh.clone(`${sourceMesh.name}.dup`, sourceMesh.parent ?? null, /*doNotCloneChildren*/ false);
  if (!clone) return null;
  // Babylon's clone SHARES the source Geometry by reference. Per-object vertex
  // bakes (RescaleObjectCommand, source-unit re-bake) rewrite geometry in place
  // and would corrupt the source instance through the shared buffer. Give the
  // duplicate its own geometry. (Per-object ratio redesign 2026-06-16.)
  clone.makeGeometryUnique?.();
  trackOrphan(clone);   // lives outside the container — track for disposal

  if (worldOffset) {
    clone.position.x += worldOffset.x ?? 0;
    clone.position.y += worldOffset.y ?? 0;
    clone.position.z += worldOffset.z ?? 0;
  }
  clone.metadata   = { ...(sourceMesh.metadata ?? {}), meshId: newId };
  clone.isVisible  = sourceMesh.isVisible !== false;
  // Duplicating while the wireframe-edges overlay is ON also clones the
  // overlay child — dispose it; SceneManager re-ensures a tracked one via
  // the ASSET_INSTANTIATED hook.
  for (const child of clone.getChildMeshes?.(true) ?? []) {
    if (child.metadata?.edgeOverlay) { try { child.dispose(); } catch { /* */ } }
  }
  registerMesh(newId, clone);

  const newObj = {
    ...sourceObj,
    id: newId,
    name: _nextDupName(sourceObj.name),
    parentId: sourceObj.parentId ?? null,
  };
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { ...s.scene.objects, [newId]: newObj },
      groups: newObj.parentId && s.scene.groups[newObj.parentId]
        ? {
            ...s.scene.groups,
            [newObj.parentId]: {
              ...s.scene.groups[newObj.parentId],
              childIds: [...new Set([...(s.scene.groups[newObj.parentId].childIds ?? []), newId])],
            },
          }
        : s.scene.groups,
    },
  }), { silent: true });

  if (sourceObj.shaderId) ShaderLibrary.linkMesh(sourceObj.shaderId, newId);

  dispatch(EVENTS.ASSET_INSTANTIATED, { assetId: sourceObj.assetId, meshId: newId, meshName: clone.name });
  return newId;
}

/** Internal — used by DuplicateCommand's undo/redo to restore a saved clone. */
export function restoreCloneToScene(meshId, savedObj, mesh) {
  if (!hasMesh(meshId)) registerMesh(meshId, mesh);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: savedObj } },
  }), { silent: true });
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
      const assetId = i === 0 ? initialAssetId : _newId('asset');
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

function _filterContainerToLibraryItem(container, libraryItem) {
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

/** True if the extension is a recognised mesh container. */
export { isMeshExt };

/** True if the extension is a recognised image we can load as a Babylon texture. */
export { isTextureExt };

// Texture-asset API — owned by ./assets/TextureAssets.js, re-exported so the
// AssetLoader surface (and its callers/tests) stay unchanged.
export {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture, recapAllTextures,
};

// Split-on-import — owned by ./assets/MeshSplit.js.
export { splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer };

// ── Project restore (Phase 6) ────────────────────────────

/**
 * Raw bytes of a loaded asset, read back from its cached blob URL. Used by
 * PersistenceManager to embed the asset in the project file.
 * @param {string} assetId
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getAssetBytes(assetId) {
  const url = getBlobUrl(assetId);
  if (!url) return null;
  const res = await fetch(url);
  return res.arrayBuffer();
}

/**
 * Load an AssetContainer from a blob for project restore. Unlike loadFromBlob
 * this does NOT mutate state, mint collections/objects, or apply import
 * scaling — the saved per-object world transforms are restored verbatim by
 * PersistenceManager. Registers the container + blob URL under `assetId` so
 * later release / re-instantiate work normally.
 *
 * @param {string} assetId   the persisted asset id (reused, not minted)
 * @param {Blob}   blob
 * @param {string} extension e.g. '.glb'
 * @param {{ dirHandle?: FileSystemDirectoryHandle, directoryHandleKey?: string,
 *           originalPath?: string }} [opts]
 *   OBJ restores pass the live directory so mtllib/texture references rebind
 *   on reload (field report: OBJ materials lost after save/reopen).
 * @returns {Promise<BABYLON.AbstractMesh[]>} ordered geometry meshes
 */
export async function restoreContainer(assetId, blob, extension, opts = {}) {
  const scene = SceneManager.getScene();
  const blobUrl = URL.createObjectURL(blob);
  setBlobUrl(assetId, blobUrl);

  let siblings = null;
  if (extension === '.obj') {
    siblings = await collectObjSiblings(opts);
    if (siblings.size) rememberObjSiblings(assetId, siblings);
  }
  const restoreUrls = installSiblingUrls(siblings);
  let container;
  try {
    container = await _loadContainer(blobUrl, extension, scene, null, siblings);
  } catch (err) {
    // Mirror the live-import cleanup (audit LOW): a failed restore must not
    // leak the source blob URL or the OBJ sibling URLs — the caller turns this
    // asset into a ghost and never revokes them otherwise.
    revokeBlobUrl(assetId);
    revokeObjSiblings(assetId);
    throw err;
  } finally {
    restoreUrls();
  }
  if (opts.libraryItem) _filterContainerToLibraryItem(container, opts.libraryItem);
  // Same split as the live import path — restored containers must match the
  // mesh-per-material shape the saved sceneObjects were minted under, so
  // containerMeshIndex lookups line up. Split is deterministic in subMesh order.
  splitMultiMaterialMeshesInContainer(container);
  registerContainer(assetId, container);
  container.addAllToScene();
  // Run the SAME import normalization as a fresh load (units + glTF RH→LH flip +
  // winding fix, baked into vertices, parent=null, scaling=1) so a restored
  // mesh is byte-for-byte the shape a fresh import produces. The reloaded bytes
  // are raw, and the saved node transform can't carry a reflection — without
  // this glTF restores mirrored. The seed uses ratio = modelRatio (factor =
  // sourceUnit only); PersistenceManager then bakes the per-object ratio delta.
  const asset = getState().scene.assetLibrary[assetId];
  bakeImportTransform(container, importScaleFactor(asset?.sourceUnit ?? DEFAULT_SOURCE_UNIT, asset?.modelRatio ?? 1));
  return container.meshes.filter(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0);
}

/**
 * Register a persisted asset-library entry without loading geometry. Used for
 * ghost / static assets so the Outliner + relink flow have an entry to point
 * at.
 */
export function registerAssetEntry(entry) {
  _registerAssetEntry(entry);
}

/**
 * Cache mesh asset bytes without loading geometry into the scene. Library GLB
 * assets use this on project restore when they have no SceneObjects yet.
 */
export function cacheAssetBlob(assetId, blob) {
  setBlobUrl(assetId, URL.createObjectURL(blob));
}

/**
 * Tear down every loaded asset/texture/mesh. BLUEPRINT §14.2 "on new/load
 * project". Mounted directory handles are session-scoped and kept.
 */
export function resetAll() {
  resetRegistry();
  resetTextures();
  revokeAllBlobUrls();
  revokeAllObjSiblings();
}

/**
 * Clone a restored container mesh for a SECOND+ SceneObject that resolves to the
 * same (assetId, containerMeshIndex) — i.e. a duplicate saved with the source's
 * indices. Each copy gets its OWN geometry so its per-object ratio + transform
 * restore independently instead of all objects collapsing onto one mesh.
 * Tracked in _orphanMeshes for disposal (it lives outside the container).
 */
export function cloneRestoredMesh(srcMesh, meshId, assetId, sourceUnit = DEFAULT_SOURCE_UNIT) {
  const clone = srcMesh.clone?.(`${srcMesh.name}.restdup`, srcMesh.parent ?? null, /*doNotCloneChildren*/ true);
  if (!clone) return srcMesh;
  clone.makeGeometryUnique?.();
  trackOrphan(clone);
  bindRestoredMesh(meshId, clone, assetId, sourceUnit);
  return clone;
}

export function removeAsset(assetId) {
  if (!getState().scene.assetLibrary[assetId]) return;
  setState(s => {
    const lib = { ...s.scene.assetLibrary };
    delete lib[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: lib } };
  });
  dispatch(EVENTS.ASSET_REMOVED, { assetId });
}

export const AssetLoader = {
  mountDirectory, restoreDirectory,
  loadFromHandle, loadFromBlob,
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, recapAllTextures,
  isMeshExt, isTextureExt,
  releaseAsset, removeAsset, instantiateAsset, getContainer, getBabylonMesh, getDirectoryHandle,
  cloneMeshAsNewObject, restoreCloneToScene,
  getContainerGeomMeshes, getAssetBytes, restoreContainer, bindRestoredMesh, cloneRestoredMesh,
  bindRestoredTexture,
  restoreTexture, registerAssetEntry, cacheAssetBlob, resetAll,
  bakeImportTransform, importScaleFactor,
};
