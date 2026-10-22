// Live import paths: blob/handle → AssetContainer → scene, with progress
// overlay, OBJ sibling resolution, split-on-import, library-GLB registration,
// and asset re-instantiation from the cached blob URL.

import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { SceneManager } from '../SceneManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { ProgressOverlay } from '../../ui/ProgressOverlay.js';
import { SHOW_DELAY_MS, MIN_VISIBLE_MS } from '../workers/JobActivity.js';
import { sha256HexOfBlob } from '../hash.js';
import {
  assertImportFileSize, assertTriangleCapacity, assertPreParseCapacity, needsExactCount, OVER_BUDGET,
} from '../import/ImportLimits.js';
import { estimateFileTriangles, countFileTriangles } from '../import/TriangleEstimate.js';
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
import { setBlobUrl, getBlobUrl, getBlob, revokeBlobUrl } from './BlobUrls.js';
import {
  newId, registerContainer, removeContainer,
} from './MeshRegistry.js';
import {
  collectObjSiblings, rememberObjSiblings, getObjSiblings,
  installSiblingUrls, noteMissingMtl, revokeObjSiblings,
} from './ObjSiblings.js';
import { isWorkerImportSupported, loadObjContainerViaWorker } from '../WorkerImport.js';
import { isMeshWorkerImport, loadMeshContainerViaWorker } from '../MeshImportWorker.js';
import { splitMultiMaterialMeshesInContainer } from './MeshSplit.js';
import {
  uniqueHierarchyName, registerAssetEntry, registerInstantiatedMeshes,
  createCollectionFromFilename, queueValidation,
} from './AssetRegistration.js';
import { queueThumbnail } from './AssetThumbnail.js';
import { isLoading as isProjectLoading } from '../persist/LoadGate.js';
import { caps, isDesktop } from '../storage/capabilities.js';
import { t } from '../../i18n/index.js';
import { Toast } from '../../ui/Toast.js';
import { countSceneTriangles, countContainerTriangles, formatTriCount } from '../scene/TriangleCount.js';
// Side-effect: registers the `.3mf` SceneLoader plugin so the LoadAssetContainer
// paths below (drop / re-instantiate / project restore) handle 3MF unchanged.
import '../ThreeMFLoader.js';
import '../import/MixoPrimitiveExtras.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Import progress overlay (field request) ─────────────────────────────
// An import changes the scene the user is editing, so it keeps the blocking
// overlay (heavy-mesh spec §5.4) — with Cancel: parsing runs in a worker, the
// UI stays live, and Cancel aborts every running import (nothing half-added)
// AND the rest of a multi-file drop (importCancelGeneration). The overlay is
// the ONE progress surface for an import (its worker jobs are hidden from the
// activity panel) and follows JobActivity's NN/g timing (shown after
// SHOW_DELAY_MS, then at least MIN_VISIBLE_MS). Imports running together share
// one overlay session until the LAST one finishes; it is a session of its own,
// so an export's overlay underneath survives it (cia B-08).

let _importDepth = 0;
const _importAborts = new Set();
let _cancelGen = 0;
let _overlay = null;

/** Bumped by every Cancel. A drop loop that sees it change stops (review I5). */
export function importCancelGeneration() { return _cancelGen; }

function _cancelImports() {
  _cancelGen++;
  for (const a of [..._importAborts]) a.abort();
}

/**
 * A multi-file import (drop, pick, open) is one batch with one cancel: the
 * overlay's Cancel, the caller's `signal`, or any file's AbortError (e.g. its
 * hash cancelled in the activity panel) ends the running file and every file
 * after it.
 * @param {{ signal?: AbortSignal }} [opts]  the caller's cancel (API request)
 * @returns {{ signal: AbortSignal, run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>, end(): void }}
 *   pass `signal` to each file's import inside `run`; call `end()` in finally
 */
export function beginImportBatch({ signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  _importAborts.add(controller);
  return {
    signal: controller.signal,
    async run(fn) {
      try { return await fn(controller.signal); }
      catch (err) { if (err?.name === 'AbortError') abort(); throw err; }
    },
    end() {
      _importAborts.delete(controller);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function _overlayUpdate(frac, label) {
  _overlay?.update(frac, label);
}

function _importBegin(label, abort = null) {
  if (abort) _importAborts.add(abort);
  if (++_importDepth === 1) {
    _overlay = ProgressOverlay.open(t('job.importModel'), {
      onCancel: _cancelImports, delayMs: SHOW_DELAY_MS, minVisibleMs: MIN_VISIBLE_MS,
    });
  }
  _overlayUpdate(0.02, label);
}

/** Overlay text for a worker stage: "<file> — <translated stage>". */
function _stageText(filename, stage) {
  const key = `job.stage.${stage ?? 'read'}`;
  const text = t(key);
  return `${filename} — ${text === key ? stage : text}`;
}

function _importProgress(filename) {
  return (evt) => {
    if (evt && typeof evt.fraction === 'number') {
      _overlayUpdate(0.02 + 0.73 * Math.min(1, evt.fraction), _stageText(filename, evt.stage));
    } else if (evt?.lengthComputable && evt.total > 0) {
      _overlayUpdate(0.02 + 0.73 * (evt.loaded / evt.total), _stageText(filename, 'read'));
    } else {
      _overlayUpdate(0.4, _stageText(filename, evt?.stage ?? 'read'));
    }
  };
}

function _importEnd(abort = null) {
  if (abort) _importAborts.delete(abort);
  _importDepth = Math.max(0, _importDepth - 1);
  if (_importDepth !== 0) return;
  _overlay?.close();
  _overlay = null;
}

function _throwIfAborted(signal, container) {
  if (!signal?.aborted) return;
  try { container?.dispose?.(); } catch { /* not scene-owned */ }
  throw new DOMException('Import cancelled', 'AbortError');
}

/** True while any loadFromBlob / instantiateAsset is in flight (F20 / M2). */
export function isImporting() {
  return _importDepth > 0;
}

export const PROJECT_LOADING_MESSAGE =
  'A project is still loading — wait for it to finish before importing';

// F20: an import that lands mid-load would mint objects into a world that
// loadProject is still rebuilding (or that resetWorld is about to wipe).
// Surfaced through the normal safeImport modal by the caller.
function _assertNoProjectLoad() {
  if (isProjectLoading()) throw new Error(PROJECT_LOADING_MESSAGE);
}

/** Above this size a failed worker parse is NOT retried on the main thread:
 *  the files that time out or crash a worker are exactly the ones that would
 *  freeze or kill the tab there (audit area 2c). */
export const MAIN_THREAD_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;

/** Worker failures the main thread must not retry: it would freeze or refuse too. */
const NO_RETRY_CODES = new Set(['timeout', OVER_BUDGET]);

/** Worker failure → may the main-thread SceneLoader retry it? */
export function mayFallBackToMainThread(err, size) {
  if (err?.name === 'AbortError') return false;
  if (NO_RETRY_CODES.has(err?.code)) return false;
  return !(size > MAIN_THREAD_FALLBACK_MAX_BYTES);
}

/**
 * Load an AssetContainer from a blob URL. STL and 3MF parse + weld in
 * workers/MeshImport.worker.js and OBJ in workers/ObjParse.worker.js when
 * Worker exists; a worker failure on a small file falls back to the
 * main-thread SceneLoader path (which the installed PreprocessUrl sibling
 * swap still covers); a big file, a timeout or Cancel never does.
 * @param {string} blobUrl
 * @param {string} ext
 * @param {BABYLON.Scene} scene
 * @param {Function|null} onProgress
 * @param {Map<string,string>|null} siblings
 * @param {{ signal?: AbortSignal, size?: number, hidden?: boolean }} [opts]
 *   `hidden`: the caller shows its own progress (the import overlay), so the
 *   worker job stays out of the activity panel (one progress surface).
 */
export async function loadContainer(blobUrl, ext, scene, onProgress, siblings, opts = {}) {
  const { signal, size, hidden = false } = opts;
  if (isMeshWorkerImport(ext)) {
    try {
      return await loadMeshContainerViaWorker(scene, blobUrl, ext, { onProgress: onProgress ?? undefined, signal, hidden });
    } catch (err) {
      if (!mayFallBackToMainThread(err, size)) throw err;
      console.warn(`${ext} worker parse failed — main-thread fallback:`, err);
    }
  } else if (ext === '.obj' && isWorkerImportSupported()) {
    try {
      return await loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress ?? undefined, { signal, hidden });
    } catch (err) {
      if (!mayFallBackToMainThread(err, size)) throw err;
      console.warn('OBJ worker parse failed — main-thread fallback:', err);
    }
  }
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  return BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, onProgress, ext);
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

// ── Re-import dedupe (Decision 16, §4.4 rule 2) ──────────────────────────

/** Choices of the "already in this project" prompt. */
export const DUPLICATE_CHOICE = Object.freeze({ COPY: 'copy', SEPARATE: 'separate' });

/**
 * In-project dedupe: the first instantiable mesh asset whose source bytes hash
 * to `contentHash`, in library order. Library-pack items (one file → many
 * assets) and assets without cached bytes (ghosts) never match — "add another
 * copy" must be able to re-instantiate what it found.
 * @param {string|null|undefined} contentHash  sha256 hex
 * @param {object} [state]
 * @returns {string|null} assetId
 */
export function findByHash(contentHash, state = getState()) {
  if (!contentHash) return null;
  for (const a of Object.values(state.scene?.assetLibrary ?? {})) {
    if (!a || a.contentHash !== contentHash) continue;
    if ((a.kind ?? 'mesh') !== 'mesh' || a.libraryItem || a.isGhost) continue;
    if (!getBlobUrl(a.id)) continue;
    return a.id;
  }
  return null;
}

/**
 * Decision 16 prompt — the designed "already in this project" dialog
 * (`duplicateImport`, rendered by AssetPanel): [Import as separate asset]
 * [Add another copy]. "Add another copy" is the primary, focused default;
 * × / Esc / backdrop = cancel the import.
 * @param {{ filename: string, existingName: string }} info
 * @returns {Promise<'copy'|'separate'|null>}
 */
export function askDuplicateImport({ filename, existingName }) {
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'duplicateImport',
      filename,
      existingName,
      onClose: (r) => resolve(r === 'copy' ? DUPLICATE_CHOICE.COPY
        : r === 'separate' ? DUPLICATE_CHOICE.SEPARATE : null),
    });
  });
}

/**
 * New-file import entry point for UI drops / picks (OS drop, Import picker,
 * mounted-folder file). Hashes the bytes BEFORE the progress overlay goes up
 * (the overlay swallows input, the prompt needs it); identical bytes already
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
  // Heavy-mesh spec §3: refuse on the triangle count BEFORE hashing; the
  // over-budget warning waits until the dedupe decision (loadFromBlob shows it).
  const preParse = await preParseCheck(blob, filename);
  let contentHash = null;
  try { contentHash = await sha256HexOfBlob(blob, { cancellable: true, signal: opts.signal }); }
  catch (err) {
    // Cancel from the activity panel ends this import and the rest of the drop.
    if (err?.name === 'AbortError') { _cancelGen++; throw err; }
    /* no hash → no dedupe; loadFromBlob proceeds as before */
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

/**
 * Pre-parse budget decision (heavy-mesh spec §1/§3): estimate the file's
 * triangles from a few small slices and refuse above 4× the budget (throws the
 * user-readable message) before anything is parsed, hashed or copied. The
 * caller that owns the moment shows the over-budget warning for 'warn'.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<{ verdict: 'ok'|'warn'|'unknown', projected: number }>}
 *   `projected` = scene triangles plus this file's estimate
 */
export async function preParseCheck(blob, filename) {
  const ext = extOf(filename);
  const sceneTriangles = countSceneTriangles();
  let estimate = await estimateFileTriangles(blob, ext);
  if (needsExactCount(estimate, { sceneTriangles, budget: caps.triangleBudget })) {
    estimate = (await countFileTriangles(blob, ext)) ?? estimate;
  }
  const verdict = assertPreParseCapacity(estimate, {
    sceneTriangles, budget: caps.triangleBudget, filename, desktop: isDesktop(),
  });
  return { verdict, projected: sceneTriangles + (estimate?.triangles ?? 0) };
}

function _showBudgetWarning(projected) {
  Toast.show(t('toast.triangleBudget', {
    current: formatTriCount(projected),
    budget: formatTriCount(caps.triangleBudget),
  }), 'warning');
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
 * Triangle-budget warning (watertight-repair-and-cost task 7): non-blocking —
 * the import always proceeds, this only tells the user before the tab starts
 * feeling it. Checked against the container's own meshes since nothing in it
 * has a meshId yet (that lands later, in registerInstantiatedMeshes, after
 * `addAllToScene()`). Shared by `loadFromBlob` AND `instantiateAsset` — both
 * call `container.addAllToScene()` and both need the same check.
 * @param {BABYLON.AssetContainer} container
 */
function _assertContainerCapacity(container) {
  try {
    assertTriangleCapacity(countSceneTriangles() + countContainerTriangles(container), caps.triangleBudget, 'Scene after import');
  } catch (err) {
    try { container.dispose?.(); } catch { /* retain the capacity error */ }
    throw err;
  }
}

function _warnIfOverBudget(container) {
  const budget = caps.triangleBudget;
  if (!(budget > 0)) return;
  const projectedTris = countSceneTriangles() + countContainerTriangles(container);
  if (projectedTris <= budget) return;
  Toast.show(t('toast.triangleBudget', {
    current: formatTriCount(projectedTris),
    budget: formatTriCount(budget),
  }), 'warning');
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
  const abort = new AbortController();
  const callerAbort = () => abort.abort();
  opts.signal?.addEventListener('abort', callerAbort, { once: true });
  if (opts.signal?.aborted) abort.abort();
  _importBegin(_stageText(filename, 'read'), abort);
  let restoreUrls = () => {};
  const scene = SceneManager.getScene();
  const assetId = newId('asset');
  const blobUrl = URL.createObjectURL(blob);
  setBlobUrl(assetId, blobUrl, blob);

  try {
    // importWithDedupe refused-or-passed before hashing but held the warning
    // until the duplicate prompt was answered (review M12).
    const preParse = opts.preParse ?? await preParseCheck(blob, filename);
    if (preParse.verdict === 'warn') _showBudgetWarning(preParse.projected);

    // §10b texture-identity scope: hash the source bytes once. Reused as the
    // AssetEntry contentHash so persistence doesn't re-hash at save time.
    let sourceFileHash = opts.contentHash ?? null;
    if (!sourceFileHash) {
      try { sourceFileHash = await sha256HexOfBlob(blob, { signal: abort.signal, hidden: true }); }
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
    const container = await loadContainer(blobUrl, ext, scene, _importProgress(filename), siblings,
      { signal: abort.signal, size: blob.size, hidden: true });
    _throwIfAborted(abort.signal, container);
    _assertContainerCapacity(container);
    _overlayUpdate(0.8, t('import.progress.materials', { filename }));

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
      _overlayUpdate(0.98, t('import.progress.addedToAssets', { filename }));
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

    _overlayUpdate(0.9, t('import.progress.addingToScene', { filename }));
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName, {
      fileName: filename.replace(/\.[^.]+$/, ''),
    });

    if (preParse.verdict !== 'warn') _warnIfOverBudget(container);   // warned pre-parse already
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
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, modelRatio);

    _overlayUpdate(0.98, t('import.progress.ready', { filename }));

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
    opts.signal?.removeEventListener('abort', callerAbort);
    restoreUrls();
    _importEnd(abort);
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
  const abort = new AbortController();
  const sourceBlob = getBlob(assetId);
  _importBegin(_stageText(asset.filename, 'read'), abort);
  // Re-instantiated OBJs need their sibling map again for MTL/textures.
  const siblings = getObjSiblings(assetId);
  const restoreUrls = installSiblingUrls(siblings);
  try {
    // Another copy of a heavy mesh gets the same pre-parse budget check and
    // the same no-main-thread-retry rule as a fresh import (review I4).
    const preParse = sourceBlob ? await preParseCheck(sourceBlob, asset.filename) : null;
    if (preParse?.verdict === 'warn') _showBudgetWarning(preParse.projected);
    const container = await loadContainer(
      blobUrl, asset.extension, scene, _importProgress(asset.filename), siblings,
      { signal: abort.signal, size: sourceBlob?.size, hidden: true }
    );
    _throwIfAborted(abort.signal, container);
    if (asset.libraryItem) filterContainerToLibraryItem(container, asset.libraryItem);
    _assertContainerCapacity(container);
    splitMultiMaterialMeshesInContainer(container);
    registerContainer(assetId, container);
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash: asset.contentHash ?? null,
    });
    const hierarchy = buildImportHierarchy(container, newId, uniqueHierarchyName, {
      fileName: String(asset.displayName ?? asset.filename ?? '').replace(/\.[^.]+$/, ''),
    });
    if (preParse?.verdict !== 'warn') _warnIfOverBudget(container);
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);
    hierarchy.attachFileGroup(scene);

    const collectionId = createCollectionFromFilename(asset.displayName ?? asset.filename, assetId);
    const meshIds = registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy, asset.modelRatio ?? 1);
    for (const meshId of meshIds) queueValidation(meshId);
    await _selectImported(hierarchy, meshIds);
    if (!meshIds.length) throw new Error(`${asset.displayName ?? asset.filename}: no geometry found in asset`);
    markDirty();
    return meshIds;
  } finally {
    restoreUrls();
    _importEnd(abort);
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
