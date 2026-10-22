// Live import paths: blob/handle → AssetContainer → scene, and asset
// re-instantiation from the cached blob URL. The pieces live beside it:
//   ImportSession.js  blocking job, cancel scope, multi-file batch
//   ImportBudget.js   pre-parse estimate + triangle-budget warnings
//   ContainerLoad.js  blob URL → container (worker first, plugin fallback)
//   ImportDedupe.js   "already in this project" lookup + prompt
//   LibraryImport.js  library-GLB registration + item filtering
// This module is their façade for AssetLoader, the UI and the tests.

import { getState, markDirty } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { sha256HexOfBlob } from '../hash.js';
import { assertImportFileSize } from '../import/ImportLimits.js';
import { bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT } from '../ImportNormalizer.js';
import { extractModelRatio } from '../import/ImportMetadata.js';
import { buildImportHierarchy } from '../import/ImportHierarchy.js';
import { SUPPORTED_EXTENSIONS, extOf } from './AssetTypes.js';
import { setBlobUrl, getBlobUrl, getBlob, revokeBlobUrl } from './BlobUrls.js';
import { newId, registerContainer, removeContainer } from './MeshRegistry.js';
import {
  collectObjSiblings, rememberObjSiblings, getObjSiblings,
  installSiblingUrls, noteMissingMtl, revokeObjSiblings,
} from './ObjSiblings.js';
import { splitMultiMaterialMeshesInContainer } from './MeshSplit.js';
import {
  uniqueHierarchyName, registerAssetEntry, registerInstantiatedMeshes,
  createCollectionFromFilename, queueValidation,
} from './AssetRegistration.js';
import { queueThumbnail } from './AssetThumbnail.js';
import { isLoading as isProjectLoading } from '../persist/LoadGate.js';
import { linkedAbort, beginImport, importProgress, endImport, throwIfAborted } from './ImportSession.js';
import { preParseCheck, showBudgetWarning, assertContainerCapacity, warnIfOverBudget } from './ImportBudget.js';
import { loadContainer } from './ContainerLoad.js';
import { DUPLICATE_CHOICE, findByHash, askDuplicateImport } from './ImportDedupe.js';
import { tryRegisterLibraryImport, filterContainerToLibraryItem } from './LibraryImport.js';

export { beginImportBatch, isImporting } from './ImportSession.js';
export { preParseCheck } from './ImportBudget.js';
export { loadContainer, mayFallBackToMainThread, MAIN_THREAD_FALLBACK_MAX_BYTES } from './ContainerLoad.js';
export { DUPLICATE_CHOICE, findByHash, askDuplicateImport } from './ImportDedupe.js';
export { filterContainerToLibraryItem } from './LibraryImport.js';

export const PROJECT_LOADING_MESSAGE =
  'A project is still loading — wait for it to finish before importing';

// F20: an import that lands mid-load would mint objects into a world that
// loadProject is still rebuilding (or that resetWorld is about to wipe).
// Surfaced through the normal safeImport modal by the caller.
function _assertNoProjectLoad() {
  if (isProjectLoading()) throw new Error(PROJECT_LOADING_MESSAGE);
}

/**
 * Load an asset from a FileSystemFileHandle (Asset Panel drag / double-click
 * on a mounted-folder file). A folder file is a NEW import, so it gets the
 * Decision 16 "already in this project" check.
 * @param {FileSystemFileHandle} fileHandle
 * @param {BABYLON.Vector3} [position]
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromHandle(fileHandle, position, opts = {}) {
  const file = await fileHandle.getFile();
  return importWithDedupe(file, file.name, position, opts);
}

/**
 * New-file import entry point for UI drops / picks (OS drop, Import picker,
 * mounted-folder file). Hashes the bytes BEFORE the duplicate prompt (the
 * overlay swallows input, the prompt needs it); identical bytes already
 * in the project prompt (Decision 16):
 *   copy     → re-instantiate the existing asset (no new AssetEntry)
 *   separate → a normal import that mints a second asset with the same hash
 *   dismiss  → nothing is imported
 * Project-tab drops (`instantiateAsset`) and project load never come here,
 * so they never prompt.
 * @param {Blob} blob
 * @param {string} filename
 * @param {BABYLON.Vector3} [position]
 * @param {object} [opts]  loadFromBlob opts
 * @param {{ ask?: typeof askDuplicateImport }} [deps]  test seam
 * @returns {Promise<string[]>} created meshIds
 */
export async function importWithDedupe(blob, filename, position, opts = {}, deps = {}) {
  _assertNoProjectLoad();
  assertImportFileSize(blob.size, filename);   // before reading the bytes to hash
  // The estimate and the hash are the import's first steps: its blocking job
  // covers them (Cancel ends this import and the rest of the drop) and closes
  // before the duplicate prompt, which needs the input the overlay swallows.
  const abort = linkedAbort(opts.signal);
  const job = beginImport(filename, abort);
  let preParse;
  let contentHash = null;
  try {
    // Heavy-mesh spec §3: refuse on the triangle count BEFORE hashing; the
    // over-budget warning waits until the dedupe decision (loadFromBlob shows it).
    preParse = await preParseCheck(blob, filename);
    job.progress({ stage: 'hash' });
    try { contentHash = await sha256HexOfBlob(blob, { signal: abort.signal }); }
    catch (err) {
      if (err?.name === 'AbortError') throw err;
      /* no hash → no dedupe; loadFromBlob proceeds as before */
    }
  } finally {
    endImport(job, abort);
  }
  const existingId = findByHash(contentHash);
  if (existingId) {
    const existing = getState().scene.assetLibrary[existingId];
    const ask = deps.ask ?? askDuplicateImport;
    const choice = await ask({
      filename,
      existingName: existing?.displayName ?? existing?.filename ?? filename,
    });
    if (choice === DUPLICATE_CHOICE.COPY) {
      // Re-check: a project open/new while the prompt was up can drop it.
      if (findByHash(contentHash) === existingId) return instantiateAsset(existingId, position);
    } else if (choice !== DUPLICATE_CHOICE.SEPARATE) {
      return [];
    }
  }
  return loadFromBlob(blob, filename, position, { ...opts, contentHash, preParse });
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
 *           fileHandleKey?: string, contentHash?: string|null,
 *           preParse?: { verdict: 'ok'|'warn'|'unknown', projected: number },
 *           signal?: AbortSignal }} [opts]
 *   `fileHandleKey` = an already-persisted storage-adapter key for a loose
 *   file (ViewportDrop persists the ref before calling); `contentHash` = the
 *   sha256 `importWithDedupe` already computed (skips a second hash);
 *   `preParse` = its pre-parse verdict (skips a second estimate); `signal` =
 *   the caller's cancel (an API request that timed out or lost its client)
 *   aborts this import only, like the overlay's Cancel (cia F-08).
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromBlob(blob, filename, position, opts = {}) {
  _assertNoProjectLoad();
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }
  assertImportFileSize(blob.size, filename);   // Decision 19: before any state change

  // F20: flag the import BEFORE the first await (hash / sibling collection
  // below) — otherwise Open/New started in that window races a running import.
  const abort = linkedAbort(opts.signal);
  const job = beginImport(filename, abort);
  let restoreUrls = () => {};
  const scene = SceneManager.getScene();
  const assetId = newId('asset');
  const blobUrl = URL.createObjectURL(blob);
  setBlobUrl(assetId, blobUrl, blob);

  try {
    // importWithDedupe refused-or-passed before hashing but held the warning
    // until the duplicate prompt was answered (review M12).
    const preParse = opts.preParse ?? await preParseCheck(blob, filename);
    if (preParse.verdict === 'warn') showBudgetWarning(preParse.projected);

    // §10b texture-identity scope: hash the source bytes once. Reused as the
    // AssetEntry contentHash so persistence doesn't re-hash at save time.
    let sourceFileHash = opts.contentHash ?? null;
    if (!sourceFileHash) {
      try { sourceFileHash = await sha256HexOfBlob(blob, { signal: abort.signal }); }
      catch (err) { if (err?.name === 'AbortError') throw err; /* hash is an identity optimisation — import proceeds without it */ }
    }

    // OBJ: resolve mtllib/texture references against drop-set or directory
    // siblings (blob URLs have no usable base URL).
    let siblings = null;
    if (ext === '.obj') {
      siblings = await collectObjSiblings(opts);
      if (siblings.size) rememberObjSiblings(assetId, siblings);
      await noteMissingMtl(blob, filename, siblings);
    }

    restoreUrls = installSiblingUrls(siblings);
    const container = await loadContainer(blobUrl, ext, scene, importProgress(job), siblings,
      { signal: abort.signal, size: blob.size });
    throwIfAborted(abort.signal, container);
    assertContainerCapacity(container);
    job.progress({ stage: 'materials', fraction: 0.8 });

    const sourceUnit = DEFAULT_SOURCE_UNIT;
    const modelRatio = extractModelRatio(container) ?? 1;

    if (await tryRegisterLibraryImport({
      container, blob, filename, ext, opts,
      initialAssetId: assetId,
      initialBlobUrl: blobUrl,
      sourceFileHash,
      sourceUnit,
      modelRatio,
    })) {
      job.progress({ stage: 'addedToAssets', fraction: 0.98 });
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

    job.progress({ stage: 'addingToScene', fraction: 0.9 });
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName, {
      fileName: filename.replace(/\.[^.]+$/, ''),
    });

    if (preParse.verdict !== 'warn') warnIfOverBudget(container);   // warned pre-parse already
    container.addAllToScene();
    _applyResinDefault(container);   // AFTER add — container meshes have geometry bound now

    // Apply unit + working-ratio scaling. modelRatio comes from a glTF "ratio"
    // custom property if present (Blender custom prop), else 1:1. The result is
    // that 1 BU in the scene == 1 m at the scene's working ratio (its print size).
    // Export-time rescaling from working → target ratio happens in PrintManager.
    bakeImportTransform(container, importScaleFactor(sourceUnit, modelRatio), position);
    hierarchy.attachFileGroup(scene);   // multi-object file → one group named after it

    // A loose OS drop / picked file arrives with its ref already persisted by
    // the storage adapter (ViewportDrop) — that key is its relink path.
    const fileHandleKey = opts.fileHandleKey ?? null;

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
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, modelRatio, {
      singleObjectName: ext === '.stl' ? entry.name : null,
    });

    job.progress({ stage: 'ready', fraction: 0.98 });

    queueThumbnail(assetId);
    for (const meshId of meshIds) queueValidation(meshId);
    await _selectImported(hierarchy, meshIds);

    // F24: a zero-byte / geometry-less file used to import "successfully"
    // with no object and no message. (Library GLBs return earlier, above.)
    if (!meshIds.length) throw new Error(`${filename}: no geometry found in file`);
    // Import is a non-undoable mutation of the project (assets + objects), so
    // it must count as unsaved work — otherwise "close without saving" reads
    // clean after dropping models in (audit 2026-09-17, H2).
    markDirty();
    return meshIds;
  } catch (err) {
    revokeBlobUrl(assetId);
    revokeObjSiblings(assetId);
    removeContainer(assetId);
    throw err;
  } finally {
    restoreUrls();
    endImport(job, abort);
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
  _assertNoProjectLoad();
  const asset = getState().scene.assetLibrary[assetId];
  if (!asset) throw new Error(`Asset ${assetId} not in library`);

  const blobUrl = getBlobUrl(assetId);
  if (!blobUrl) throw new Error(`No cached data for ${asset.filename} — cannot re-instantiate`);

  const scene = SceneManager.getScene();
  const abort = linkedAbort(null);
  const sourceBlob = getBlob(assetId);
  const job = beginImport(asset.filename, abort);
  // Re-instantiated OBJs need their sibling map again for MTL/textures.
  const siblings = getObjSiblings(assetId);
  const restoreUrls = installSiblingUrls(siblings);
  try {
    // Another copy of a heavy mesh gets the same pre-parse budget check and
    // the same no-main-thread-retry rule as a fresh import (review I4).
    const preParse = sourceBlob ? await preParseCheck(sourceBlob, asset.filename) : null;
    if (preParse?.verdict === 'warn') showBudgetWarning(preParse.projected);
    const container = await loadContainer(
      blobUrl, asset.extension, scene, importProgress(job), siblings,
      { signal: abort.signal, size: sourceBlob?.size }
    );
    throwIfAborted(abort.signal, container);
    if (asset.libraryItem) filterContainerToLibraryItem(container, asset.libraryItem);
    assertContainerCapacity(container);
    splitMultiMaterialMeshesInContainer(container);
    registerContainer(assetId, container);
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash: asset.contentHash ?? null,
    });
    const fileStem = String(asset.displayName ?? asset.filename ?? '').replace(/\.[^.]+$/, '');
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName, { fileName: fileStem });
    if (preParse?.verdict !== 'warn') warnIfOverBudget(container);
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);
    hierarchy.attachFileGroup(scene);

    const collectionId = createCollectionFromFilename(asset.displayName ?? asset.filename, assetId);
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, asset.modelRatio ?? 1, {
      singleObjectName: asset.extension === '.stl' ? fileStem || null : null,
    });
    for (const meshId of meshIds) queueValidation(meshId);
    await _selectImported(hierarchy, meshIds);
    if (!meshIds.length) throw new Error(`${asset.displayName ?? asset.filename}: no geometry found in asset`);
    markDirty();
    return meshIds;
  } finally {
    restoreUrls();
    endImport(job, abort);
  }
}

/**
 * The new file group (multi-object file) or the single imported object becomes
 * the selection. Dynamic import: Selection imports AssetLoader (cycle).
 */
async function _selectImported(hierarchy, meshIds) {
  const ids = hierarchy?.fileGroupId ? [hierarchy.fileGroupId] : meshIds;
  if (!ids.length) return;
  try {
    const { Selection } = await import('../Selection.js');
    Selection.set(ids);
  } catch { /* selection is a convenience; never fail an import over it */ }
}
