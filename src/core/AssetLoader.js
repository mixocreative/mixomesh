// Mesh-asset loading, registration, instancing, and project restore.
// Texture assets live in ./assets/TextureAssets.js, the split-on-import
// invariant in ./assets/MeshSplit.js, and the shared blob-URL registry in
// ./assets/BlobUrls.js (review L29 split) — all re-exported below so the
// AssetLoader public surface is unchanged.

import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { MeshValidator } from './MeshValidator.js';
import { Toast } from '../ui/Toast.js';
import { ProgressOverlay } from '../ui/ProgressOverlay.js';
import { putHandle, getHandle } from './idb.js';
import {
  bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT,
} from './ImportNormalizer.js';
import {
  SUPPORTED_EXTENSIONS,
  extOf as _extOf,
  isMeshExt,
  isTextureExt,
} from './assets/AssetTypes.js';
import { parseScaleRatioText } from './scale/ScaleMath.js';
import { setBlobUrl, getBlobUrl, revokeBlobUrl, revokeAllBlobUrls } from './assets/BlobUrls.js';
import { isWorkerImportSupported, loadObjContainerViaWorker } from './WorkerImport.js';
import {
  splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer,
} from './assets/MeshSplit.js';
import {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture,
  releaseTextureAsset, resetTextures,
} from './assets/TextureAssets.js';
// Side-effect: registers the `.3mf` SceneLoader plugin so the LoadAssetContainer
// paths below (drop / re-instantiate / project restore) handle 3MF unchanged.
import './ThreeMFLoader.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const THUMB_SIZE  = 128;
const THUMB_LAYER = 0x40000000;     // unique camera mask bit for thumbnail isolation

// Module-local — never persisted in state.
const _containers   = new Map();    // assetId → BABYLON.AssetContainer
const _meshRegistry = new Map();    // meshId  → BABYLON.AbstractMesh
const _dirHandles   = new Map();    // key     → FileSystemDirectoryHandle (session)

let _idCounter = 0;
const _newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++_idCounter}`;

/** sha256 hex of an ArrayBuffer — texture-identity scope (§10b). */
async function _sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── OBJ sibling resolution (field report: "obj fails to read mtl") ──────
// OBJ loads from a blob URL, so the loader's relative `mtllib` / texture
// requests can't resolve. We map sibling filenames → object URLs (from a
// multi-file drop or the file's mounted directory) and swap
// BABYLON.Tools.PreprocessUrl for the duration of the load. The map is kept
// per assetId so re-instantiation rebinds materials too.

const _objSiblings = new Map();   // assetId → Map<lowercase filename, objectURL>
const MAX_SIBLING_FILES = 64;

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

async function _collectObjSiblings(opts) {
  const map = new Map();
  const add = async (name, fileOrHandle) => {
    if (map.size >= MAX_SIBLING_FILES) return;
    const ext = _extOf(name);
    if (ext !== '.mtl' && !isTextureExt(ext)) return;
    try {
      const file = typeof fileOrHandle.getFile === 'function' ? await fileOrHandle.getFile() : fileOrHandle;
      map.set(name.toLowerCase(), URL.createObjectURL(file));
    } catch { /* unreadable sibling — material falls back */ }
  };

  if (Array.isArray(opts.siblingFiles)) {
    for (const f of opts.siblingFiles) await add(f.name, f);
  } else if ((opts.dirHandle || opts.directoryHandleKey) && opts.originalPath) {
    // Project restore passes the idb-resolved handle directly (the session
    // mount map only fills after an explicit remount).
    const root = opts.dirHandle ?? _dirHandles.get(opts.directoryHandleKey);
    if (root) {
      try {
        // Walk to the OBJ's parent directory, then enumerate its files.
        const parts = String(opts.originalPath).split(/[\\/]+/).filter(Boolean);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'file') await add(name, handle);
        }
      } catch { /* directory walk failed — material falls back */ }
    }
  }
  return map;
}

/** Swap Tools.PreprocessUrl to serve sibling files by filename. Returns restore fn. */
function _installSiblingUrls(map) {
  if (!map?.size || !BABYLON.Tools) return () => {};
  // Same-name fallback: when the OBJ's mtllib statement names a file we don't
  // have but exactly ONE .mtl sibling exists, serve that one (artists rename
  // OBJs without updating mtllib constantly).
  const mtlUrls = [...map.entries()].filter(([n]) => n.endsWith('.mtl')).map(([, u]) => u);
  const soloMtl = mtlUrls.length === 1 ? mtlUrls[0] : null;
  const prev = BABYLON.Tools.PreprocessUrl;
  BABYLON.Tools.PreprocessUrl = (url) => {
    const name = String(url).split(/[\\/]/).pop()?.toLowerCase();
    const hit = name ? map.get(name) : null;
    if (hit) return hit;
    if (soloMtl && name?.endsWith('.mtl')) return soloMtl;
    return typeof prev === 'function' ? prev(url) : url;
  };
  return () => { BABYLON.Tools.PreprocessUrl = prev; };
}

/**
 * Note when the OBJ references a .mtl no sibling satisfies. A missing MTL is
 * a VALID import (mesh gets the fallback material) — console note only, no
 * toast nagging (field request).
 */
async function _noteMissingMtl(blob, filename, map) {
  try {
    const head = await blob.slice(0, 65536).text();
    const refs = [...head.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)]
      .map(m => m[1].trim().split(/[\\/]/).pop()?.toLowerCase())
      .filter(Boolean);
    const hasAnyMtl = [...(map?.keys() ?? [])].some(n => n.endsWith('.mtl'));
    const missing = refs.filter(r => !map?.has(r));
    if (missing.length && !hasAnyMtl) {
      console.warn(`${filename}: references ${missing[0]} but no .mtl was provided — using default material. ` +
        'Drop the .mtl/textures together with the .obj, or import from a mounted folder, to bind materials.');
    }
  } catch { /* note only */ }
}

function _revokeObjSiblings(assetId) {
  const map = _objSiblings.get(assetId);
  if (!map) return;
  for (const url of map.values()) URL.revokeObjectURL(url);
  _objSiblings.delete(assetId);
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

/**
 * Prompt the user to mount a directory via the File System Access API.
 * Persists the handle in IndexedDB for session restoration (Phase 6).
 * @returns {Promise<{handle: FileSystemDirectoryHandle, key: string}>}
 */
export async function mountDirectory() {
  const handle = await window.showDirectoryPicker();
  const key = `dir_${handle.name}_${Date.now()}`;
  _dirHandles.set(key, handle);
  await putHandle(key, handle);
  return { handle, key };
}

/**
 * Restore a previously-mounted directory handle (requires re-grant of permission).
 * @param {string} key
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function restoreDirectory(key) {
  const handle = await getHandle(key);
  if (!handle) return null;
  const granted = await handle.requestPermission({ mode: 'read' });
  if (granted !== 'granted') return null;
  _dirHandles.set(key, handle);
  return handle;
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
  try { sourceFileHash = await _sha256Hex(await blob.arrayBuffer()); }
  catch { /* hash is an identity optimisation — import proceeds without it */ }

  // OBJ: resolve mtllib/texture references against drop-set or directory
  // siblings (blob URLs have no usable base URL).
  let siblings = null;
  if (ext === '.obj') {
    siblings = await _collectObjSiblings(opts);
    if (siblings.size) _objSiblings.set(assetId, siblings);
    _noteMissingMtl(blob, filename, siblings);   // fire-and-forget, console only
  }

  _importBegin(`Reading ${filename}…`);
  const restoreUrls = _installSiblingUrls(siblings);

  try {
    const container = await _loadContainer(blobUrl, ext, scene, _importProgress(filename), siblings);
    _containers.set(assetId, container);
    ProgressOverlay.update(0.8, `Materials for ${filename}…`);

    // One-mesh-one-shader invariant: any MultiMaterial mesh splits into
    // N single-material siblings, each stamped with a shared sourceGroupId.
    // Runs BEFORE registerFromContainer so MultiMaterial wrappers are gone
    // before ShaderLibrary walks container.materials.
    splitMultiMaterialMeshesInContainer(container);

    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash,
    });

    ProgressOverlay.update(0.9, `Adding ${filename} to scene…`);
    container.addAllToScene();

    // Apply unit + working-ratio scaling. modelRatio comes from a glTF "ratio"
    // custom property if present (Blender custom prop), else 1:1. The result is
    // that 1 BU in the scene == 1 m at the scene's working ratio (its print size).
    // Export-time rescaling from working → target ratio happens in PrintManager.
    const sourceUnit  = DEFAULT_SOURCE_UNIT;
    const modelRatio  = _extractModelRatio(container) ?? 1;
    bakeImportTransform(container, importScaleFactor(sourceUnit, modelRatio), position);

    // OS drag-drop has no directory handle, but Chrome's
    // DataTransferItem.getAsFileSystemHandle() yields a single FILE handle.
    // Persisting it gives a loose drop a relink path of its own (resolved in
    // PersistenceManager between dir-scan and the embedded snapshot). Without
    // this a dragged file is a permanent frozen snapshot. Best-effort: idb may
    // refuse the structured clone — the embedded copy still guarantees reopen.
    let fileHandleKey = opts.fileHandleKey ?? null;
    if (!fileHandleKey && opts.fileHandle && !opts.directoryHandleKey) {
      fileHandleKey = `fh_${assetId}`;
      try { await putHandle(fileHandleKey, opts.fileHandle); }
      catch { fileHandleKey = null; }
    }

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
    setState(s => ({
      ...s,
      scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
    }), { silent: true });
    dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry });

    const collectionId = _createCollectionFromFilename(filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId);

    ProgressOverlay.update(0.98, `${filename} ready`);

    _scheduleIdle(() => _generateThumbnailFor(assetId));
    for (const meshId of meshIds) _queueValidation(meshId);

    return meshIds;
  } catch (err) {
    revokeBlobUrl(assetId);
    _revokeObjSiblings(assetId);
    _containers.delete(assetId);
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
  const siblings = _objSiblings.get(assetId);
  const restoreUrls = _installSiblingUrls(siblings);
  try {
    const container = await _loadContainer(
      blobUrl, asset.extension, scene, _importProgress(asset.filename), siblings
    );
    splitMultiMaterialMeshesInContainer(container);
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container, {
      sourceAssetId: assetId, sourceFileHash: asset.contentHash ?? null,
    });
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);

    const collectionId = _createCollectionFromFilename(asset.filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId);
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
    const container = _containers.get(assetId);
    if (container) {
      container.removeAllFromScene();
      container.dispose();
      _containers.delete(assetId);
    }
    revokeBlobUrl(assetId);
    _revokeObjSiblings(assetId);
  }

  setState(s => {
    const next = { ...s.scene.assetLibrary };
    delete next[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: next } };
  }, { silent: true });
}

/** @param {string} assetId */
export function getContainer(assetId) {
  return _containers.get(assetId) ?? null;
}

/** @param {string} meshId */
export function getBabylonMesh(meshId) {
  return _meshRegistry.get(meshId) ?? null;
}

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
  const sourceMesh = _meshRegistry.get(sourceMeshId);
  const sourceObj  = getState().scene.objects[sourceMeshId];
  if (!sourceMesh || !sourceObj) return null;

  const newId = _newId('mesh');
  const clone = sourceMesh.clone(`${sourceMesh.name}.dup`, sourceMesh.parent ?? null, /*doNotCloneChildren*/ false);
  if (!clone) return null;

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
  _meshRegistry.set(newId, clone);

  const newObj = {
    ...sourceObj,
    id: newId,
    name: _nextDupName(sourceObj.name),
    parentId: sourceObj.parentId ?? null,
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [newId]: newObj } },
  }), { silent: true });

  if (sourceObj.shaderId) ShaderLibrary.linkMesh(sourceObj.shaderId, newId);

  dispatch(EVENTS.ASSET_INSTANTIATED, { assetId: sourceObj.assetId, meshId: newId, meshName: clone.name });
  return newId;
}

/** Internal — used by DuplicateCommand's undo/redo to restore a saved clone. */
export function restoreCloneToScene(meshId, savedObj, mesh) {
  if (!_meshRegistry.has(meshId)) _meshRegistry.set(meshId, mesh);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: savedObj } },
  }), { silent: true });
}

/**
 * Pick a name that no existing SceneObject already owns. If `baseName` is
 * free, it's returned unchanged; otherwise we append `.NNN` (and increment
 * if it already ends in `.NNN`). Used at every entry point that adds a new
 * SceneObject — import, duplicate, primitive — so the uniqueness invariant
 * `name → at most one object` holds across the whole scene. Per-object
 * export filenames (`${project}_${name}_r{w}to{t}.${ext}`) depend on this.
 */
function _uniqueObjectName(baseName) {
  const objects = getState().scene.objects;
  const taken = new Set(Object.values(objects).map(o => o.name));
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

function _nextDupName(baseName) {
  // Duplicates always increment even when the base is free, so the source
  // and the copy don't share a stem; force a collision then resolve.
  const objects = getState().scene.objects;
  const taken = new Set(Object.values(objects).map(o => o.name));
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/** @param {string} key */
export function getDirectoryHandle(key) {
  return _dirHandles.get(key) ?? null;
}

/** True if the extension is a recognised mesh container. */
export { isMeshExt };

/** True if the extension is a recognised image we can load as a Babylon texture. */
export { isTextureExt };

// Texture-asset API — owned by ./assets/TextureAssets.js, re-exported so the
// AssetLoader surface (and its callers/tests) stay unchanged.
export {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture,
};

// Split-on-import — owned by ./assets/MeshSplit.js.
export { splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer };

// ── Helpers ──────────────────────────────────────────────

function _scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
}

/**
 * Look for a Blender custom property called "ratio" inside the glTF "extras"
 * bag on any node in the container. Accepts '1/72', '1:72', '72', or '2:1'.
 * Returns the authored ratio denominator value, or null when absent/malformed.
 */
function _extractModelRatio(container) {
  const nodes = [...container.meshes, ...container.transformNodes];
  for (const node of nodes) {
    const extras = node.metadata?.gltf?.extras;
    if (!extras) continue;
    const raw = extras.ratio ?? extras.Ratio;
    if (raw == null) continue;
    const parsed = parseScaleRatioText(raw);
    if (parsed) return parsed;
  }
  return null;
}

function _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId) {
  const meshIds = [];
  for (const mesh of container.meshes) {
    if (!mesh.geometry || (mesh.getTotalVertices?.() ?? 0) === 0) continue;
    const meshId = _newId('mesh');
    mesh.metadata = { ...(mesh.metadata ?? {}), meshId, assetId, sourceUnit };
    _meshRegistry.set(meshId, mesh);

    const shaderId = mesh.material ? byMaterial.get(mesh.material) : null;

    const sceneObject = {
      id: meshId,
      name: _uniqueObjectName(mesh.name || 'mesh'),
      assetId,
      collectionId: collectionId ?? null,
      parentId: null,
      shaderId: shaderId ?? null,
      visible: mesh.isVisible !== false,
      locked: false,
      isGhost: false,
      isPrintPart: true,
      sourceGroupId: mesh.metadata?.sourceGroupId ?? null,
    };
    setState(s => ({
      ...s,
      scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: sceneObject } },
    }), { silent: true });

    if (shaderId) ShaderLibrary.linkMesh(shaderId, meshId);

    meshIds.push(meshId);
    dispatch(EVENTS.ASSET_INSTANTIATED, { assetId, meshId, meshName: mesh.name });
  }
  return meshIds;
}

/**
 * Create a new outliner collection (display-only file bucket) for an import.
 * Each import call mints its own collection — re-dragging the same asset still
 * gets a fresh collection (named "<filename>.001", etc.) so the user can tell
 * which drop produced which set of meshes.
 *
 * @param {string} filename  Source filename (with extension)
 * @param {string} assetId   The minted asset id this collection groups
 * @returns {string} collectionId
 */
function _createCollectionFromFilename(filename, assetId) {
  const baseName = filename;
  const taken = new Set(Object.values(getState().scene.collections ?? {}).map(c => c.name));
  let finalName = baseName;
  if (taken.has(baseName)) {
    for (let i = 1; i < 999; i++) {
      const candidate = `${baseName}.${String(i).padStart(3, '0')}`;
      if (!taken.has(candidate)) { finalName = candidate; break; }
    }
  }

  const collectionId = _newId('col');
  const entry = {
    id: collectionId,
    name: finalName,
    sourceFile: filename,
    sourceAssetId: assetId,
    createdAt: new Date().toISOString(),
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, collections: { ...(s.scene.collections ?? {}), [collectionId]: entry } },
  }), { silent: true });
  dispatch(EVENTS.COLLECTION_CREATED, { collectionId, entry });
  return collectionId;
}

async function _generateThumbnailFor(assetId) {
  const container = _containers.get(assetId);
  if (!container) return;
  const meshes = container.meshes.filter(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0);
  if (!meshes.length) return;

  const totalVerts = meshes.reduce((s, m) => s + (m.getTotalVertices?.() ?? 0), 0);
  if (totalVerts > 500_000) return;   // BLUEPRINT §14.3 — skip thumbnail on very large meshes

  let dataUrl;
  try {
    dataUrl = await _renderThumbnail(meshes);
  } catch (err) {
    console.error('Thumbnail failed:', err);
    return;
  }

  setState(s => {
    const a = s.scene.assetLibrary[assetId];
    if (!a) return s;
    return {
      ...s,
      scene: {
        ...s.scene,
        assetLibrary: { ...s.scene.assetLibrary, [assetId]: { ...a, thumbnailDataUrl: dataUrl } },
      },
    };
  }, { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry: { ...getState().scene.assetLibrary[assetId] } });
}

async function _renderThumbnail(meshes) {
  const scene  = SceneManager.getScene();
  const engine = SceneManager.getEngine();

  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    const bi = m.getBoundingInfo();
    min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
    max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
  }
  const center = BABYLON.Vector3.Center(min, max);
  const diag   = max.subtract(min).length();
  const radius = Math.max(diag * 1.2, 0.4);

  const cam = new BABYLON.ArcRotateCamera('thumbCam', -Math.PI / 4, Math.PI / 3, radius, center, scene);
  cam.minZ = Math.max(diag * 0.001, 0.001);
  cam.maxZ = radius * 100;
  cam.layerMask = THUMB_LAYER;

  // Collect every node we want visible in the thumbnail (meshes + children).
  const visibleSet = new Set();
  for (const m of meshes) {
    visibleSet.add(m);
    m.getChildMeshes?.(false).forEach(c => visibleSet.add(c));
  }
  // OR the bit on so the meshes also stay visible to the main camera during the
  // screenshot. The thumb camera's layerMask is THUMB_LAYER alone, so it sees
  // only these meshes; the default main-camera mask still matches their other bits.
  const prevMasks = new Map();
  for (const m of visibleSet) { prevMasks.set(m, m.layerMask); m.layerMask = m.layerMask | THUMB_LAYER; }

  let dataUrl;
  try {
    dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
      engine, cam, { width: THUMB_SIZE, height: THUMB_SIZE }, 'image/png'
    );
  } finally {
    for (const [m, mask] of prevMasks) m.layerMask = mask;
    cam.dispose();
  }
  return dataUrl;
}

function _queueValidation(meshId) {
  const mesh = _meshRegistry.get(meshId);
  if (!mesh) return;
  const name = mesh.name || 'mesh';
  if (!MeshValidator.shouldAutoValidate(mesh)) {
    Toast.show(`${name}: skipped auto-validate (>100k verts)`, 'info', 4000);
    return;
  }
  const toastId = Toast.show(`Validating ${name}…`, 'loading');
  Promise.resolve().then(async () => {
    try {
      const results = await MeshValidator.validateMesh(mesh);
      Toast.dismiss(toastId);
      if (!results.length) {
        Toast.show(`✓ ${name}`, 'success', 3000);
        return;
      }
      const errs  = results.filter(r => r.severity === 'error').length;
      const warns = results.filter(r => r.severity === 'warning').length;
      // B5 click-through: clicking the persistent toast opens the Print
      // Panel's Validation tab (PrintPanel subscribes; event avoids a
      // core→ui→core import cycle).
      const onClick = () => dispatch(EVENTS.VALIDATION_FOCUS_REQUESTED, { meshId });
      if (errs > 0) {
        const w = warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
        Toast.show(`✗ ${name}: ${errs} error${errs === 1 ? '' : 's'}${w}`, 'error', 0, { onClick });
      } else {
        Toast.show(`⚠ ${name}: ${warns} warning${warns === 1 ? '' : 's'}`, 'warning', 0, { onClick });
      }
    } catch (err) {
      Toast.dismiss(toastId);
      console.error('Validation failed:', err);
    }
  });
}

// ── Project restore (Phase 6) ────────────────────────────

/**
 * Geometry-bearing meshes of a container, in stable load order. The same
 * filter `_registerInstantiatedMeshes` uses, so a saved `containerMeshIndex`
 * resolves back to the same mesh on reload.
 * @param {string} assetId
 * @returns {BABYLON.AbstractMesh[]}
 */
export function getContainerGeomMeshes(assetId) {
  const container = _containers.get(assetId);
  if (!container) return [];
  return container.meshes.filter(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0);
}

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
    siblings = await _collectObjSiblings(opts);
    if (siblings.size) _objSiblings.set(assetId, siblings);
  }
  const restoreUrls = _installSiblingUrls(siblings);
  let container;
  try {
    container = await _loadContainer(blobUrl, extension, scene, null, siblings);
  } finally {
    restoreUrls();
  }
  // Same split as the live import path — restored containers must match the
  // mesh-per-material shape the saved sceneObjects were minted under, so
  // containerMeshIndex lookups line up. Split is deterministic in subMesh order.
  splitMultiMaterialMeshesInContainer(container);
  _containers.set(assetId, container);
  container.addAllToScene();
  return container.meshes.filter(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0);
}

/**
 * Bind a restored container mesh to its persisted meshId so the rest of the
 * app (Selection, ShaderLibrary, HistoryManager) finds it by the same id it
 * had when saved.
 */
export function bindRestoredMesh(meshId, mesh, assetId, sourceUnit = DEFAULT_SOURCE_UNIT) {
  mesh.metadata = { ...(mesh.metadata ?? {}), meshId, assetId, sourceUnit };
  _meshRegistry.set(meshId, mesh);
}

/**
 * Register a persisted asset-library entry without loading geometry. Used for
 * ghost / static assets so the Outliner + relink flow have an entry to point
 * at.
 */
export function registerAssetEntry(entry) {
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [entry.id]: entry } },
  }), { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId: entry.id, entry });
}

/**
 * Tear down every loaded asset/texture/mesh. BLUEPRINT §14.2 "on new/load
 * project". Mounted directory handles are session-scoped and kept.
 */
export function resetAll() {
  for (const c of _containers.values()) {
    try { c.removeAllFromScene(); c.dispose(); } catch { /* */ }
  }
  resetTextures();
  revokeAllBlobUrls();
  for (const id of [..._objSiblings.keys()]) _revokeObjSiblings(id);
  _containers.clear();
  _meshRegistry.clear();
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
  registerImportedTexture,
  isMeshExt, isTextureExt,
  releaseAsset, removeAsset, instantiateAsset, getContainer, getBabylonMesh, getDirectoryHandle,
  cloneMeshAsNewObject, restoreCloneToScene,
  getContainerGeomMeshes, getAssetBytes, restoreContainer, bindRestoredMesh,
  bindRestoredTexture,
  restoreTexture, registerAssetEntry, resetAll,
  bakeImportTransform, importScaleFactor,
};
