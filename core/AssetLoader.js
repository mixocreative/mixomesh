import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { MeshValidator } from './MeshValidator.js';
import { Toast } from '../ui/Toast.js';
import { putHandle, getHandle } from './idb.js';
import {
  bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT,
} from './ImportNormalizer.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl'];
const SUPPORTED_TEXTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const THUMB_SIZE  = 128;
const THUMB_LAYER = 0x40000000;     // unique camera mask bit for thumbnail isolation

// Source-unit factors + DEFAULT_SOURCE_UNIT now live in ImportNormalizer.js
// (the import-normalization seam); imported above.

// Module-local — never persisted in state.
const _containers   = new Map();    // assetId → BABYLON.AssetContainer
const _textures     = new Map();    // assetId → BABYLON.Texture (texture-kind assets)
const _blobUrls     = new Map();    // assetId → object URL
const _meshRegistry = new Map();    // meshId  → BABYLON.AbstractMesh
const _dirHandles   = new Map();    // key     → FileSystemDirectoryHandle (session)

let _idCounter = 0;
const _newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++_idCounter}`;

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
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
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
  _blobUrls.set(assetId, blobUrl);

  const loadToastId = Toast.show(`Loading ${filename}…`, 'loading');

  try {
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
      blobUrl, '', scene, null, ext
    );
    _containers.set(assetId, container);

    const { byMaterial } = await ShaderLibrary.registerFromContainer(container);

    container.addAllToScene();

    // Apply unit + working-ratio scaling. modelRatio comes from a glTF "ratio"
    // custom property if present (Blender custom prop), else 1:1. The result is
    // that 1 BU in the scene == 1 m at the scene's working ratio (its print size).
    // Export-time rescaling from working → target ratio happens in PrintManager.
    const sourceUnit  = DEFAULT_SOURCE_UNIT;
    const modelRatio  = _extractModelRatio(container) ?? 1;
    bakeImportTransform(container, importScaleFactor(sourceUnit, modelRatio), position);

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
      thumbnailDataUrl: null,
    };
    setState(s => ({
      ...s,
      scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
    }), { silent: true });
    dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry });

    const collectionId = _createCollectionFromFilename(filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId);

    Toast.dismiss(loadToastId);

    _scheduleIdle(() => _generateThumbnailFor(assetId));
    for (const meshId of meshIds) _queueValidation(meshId);

    return meshIds;
  } catch (err) {
    Toast.dismiss(loadToastId);
    URL.revokeObjectURL(blobUrl);
    _blobUrls.delete(assetId);
    _containers.delete(assetId);
    throw err;
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

  const blobUrl = _blobUrls.get(assetId);
  if (!blobUrl) throw new Error(`No cached data for ${asset.filename} — cannot re-instantiate`);

  const scene = SceneManager.getScene();
  const loadToastId = Toast.show(`Loading ${asset.filename}…`, 'loading');
  try {
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
      blobUrl, '', scene, null, asset.extension
    );
    const { byMaterial } = await ShaderLibrary.registerFromContainer(container);
    container.addAllToScene();

    const sourceUnit = asset.sourceUnit ?? DEFAULT_SOURCE_UNIT;
    bakeImportTransform(container, importScaleFactor(sourceUnit, asset.modelRatio), position);

    const collectionId = _createCollectionFromFilename(asset.filename, assetId);
    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId);
    Toast.dismiss(loadToastId);
    for (const meshId of meshIds) _queueValidation(meshId);
    return meshIds;
  } catch (err) {
    Toast.dismiss(loadToastId);
    throw err;
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
    // Refuse while any shader still points at this texture.
    const shaders = getState().scene.shaders;
    const refd = Object.values(shaders).some(s => s.diffuseTextureAssetId === assetId);
    if (refd) return;
    const tex = _textures.get(assetId);
    if (tex && !entry.isImported) tex.dispose();
    _textures.delete(assetId);
  } else {
    const stillLinked = Object.values(getState().scene.objects).some(o => o.assetId === assetId && !o.isGhost);
    if (stillLinked) return;
    const container = _containers.get(assetId);
    if (container) {
      container.removeAllFromScene();
      container.dispose();
      _containers.delete(assetId);
    }
  }

  const url = _blobUrls.get(assetId);
  if (url) { URL.revokeObjectURL(url); _blobUrls.delete(assetId); }

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

function _nextDupName(baseName) {
  const objects = getState().scene.objects;
  const taken = new Set(Object.values(objects).map(o => o.name));
  // If name ends with .NNN, increment; else add .001
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
export function isMeshExt(ext) { return SUPPORTED_EXTENSIONS.includes(ext.toLowerCase()); }

/** True if the extension is a recognised image we can load as a Babylon texture. */
export function isTextureExt(ext) { return SUPPORTED_TEXTURE_EXTENSIONS.includes(ext.toLowerCase()); }

/**
 * Load a texture from a FileSystemFileHandle and register it as a texture
 * asset. If a texture with the same `originalPath` + `directoryHandleKey` is
 * already loaded, returns the existing assetId (dedup).
 * @param {FileSystemFileHandle} fileHandle
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string>} assetId
 */
export async function loadTextureFromHandle(fileHandle, opts = {}) {
  const file = await fileHandle.getFile();
  return loadTextureFromBlob(file, file.name, opts);
}

/**
 * Load a texture from a Blob/File and register it as a texture asset.
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string>} assetId
 */
export async function loadTextureFromBlob(blob, filename, opts = {}) {
  const ext = _extOf(filename);
  if (!isTextureExt(ext)) throw new Error(`Unsupported texture type: ${ext}`);

  // Dedup by mounted path so dragging the same image twice doesn't double-load.
  if (opts.originalPath && opts.directoryHandleKey) {
    const lib = getState().scene.assetLibrary;
    for (const a of Object.values(lib)) {
      if (a.kind === 'texture'
          && a.originalPath === opts.originalPath
          && a.directoryHandleKey === opts.directoryHandleKey) {
        return a.id;
      }
    }
  }

  const scene = SceneManager.getScene();
  const assetId = _newId('tex');
  const blobUrl = URL.createObjectURL(blob);
  _blobUrls.set(assetId, blobUrl);

  const texture = await new Promise((resolve, reject) => {
    const t = new BABYLON.Texture(
      blobUrl, scene, /*noMipmap*/ false, /*invertY*/ false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(t),
      (msg, err) => reject(err ?? new Error(String(msg))),
    );
  });
  _textures.set(assetId, texture);

  const entry = {
    id: assetId,
    name: filename.replace(/\.[^.]+$/, ''),
    filename,
    originalPath: opts.originalPath ?? filename,
    extension: ext,
    kind: 'texture',
    directoryHandleKey: opts.directoryHandleKey ?? null,
    thumbnailDataUrl: blobUrl,   // the image itself doubles as the panel thumbnail
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
  }), { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry });

  return assetId;
}

/** @param {string} assetId */
export function getBabylonTexture(assetId) {
  return _textures.get(assetId) ?? null;
}

/**
 * Register a BABYLON.BaseTexture that came from an imported AssetContainer
 * (e.g. the diffuse/albedo texture on a glTF material). The texture's lifetime
 * stays owned by its container — we just expose it as a texture asset so the
 * UI can swap, preview, and refer to it.
 *
 * Returns the existing asset id if the same texture instance was already
 * registered, otherwise mints a new one.
 *
 * @param {BABYLON.BaseTexture} texture
 * @returns {string|null}
 */
export function registerImportedTexture(texture) {
  if (!texture) return null;
  for (const [id, t] of _textures.entries()) {
    if (t === texture) return id;
  }
  // Content-dedupe by signature (texture name + dimensions + class). Two
  // imports of the same glTF file produce different Babylon instances but
  // identical metadata — reuse the canonical assetId so downstream shader
  // entries share a textureAssetId, which in turn lets shader-content dedupe
  // collapse the matching materials silently.
  const dupId = _findImportedTextureBySignature(texture);
  if (dupId) return dupId;

  const assetId = _newId('tex');
  _textures.set(assetId, texture);

  // texture.url is unreliable for glTF-embedded images — the loader sets it to
  // a bookkeeping name like "data:tex_1", not a real URL, and the actual bytes
  // live only on the GPU after upload. Schedule a real thumbnail via
  // readPixels → canvas → data: URL once the texture is ready.
  const fallbackName = (typeof texture.name === 'string' && texture.name)
    ? texture.name
    : `Texture ${assetId.slice(-4)}`;
  const filename = _filenameFromUrl(texture.url) || fallbackName;
  const baseName = filename.replace(/\.[^.]+$/, '') || 'Texture';

  const entry = {
    id: assetId,
    name: baseName,
    filename,
    originalPath: null,
    extension: _extOf(filename) || '.imported',
    kind: 'texture',
    directoryHandleKey: null,
    isImported: true,
    thumbnailDataUrl: null,   // populated async below
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
  }), { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry });

  _scheduleIdle(() => _generateImportedTextureThumbnail(assetId, texture));
  return assetId;
}

function _importedTextureSignature(texture) {
  const size = typeof texture.getSize === 'function' ? texture.getSize() : null;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  const cls = texture.constructor?.name ?? 'Texture';
  return `${texture.name ?? ''}|${w}|${h}|${cls}`;
}

function _findImportedTextureBySignature(texture) {
  const target = _importedTextureSignature(texture);
  for (const [id, t] of _textures.entries()) {
    const entry = getState().scene.assetLibrary[id];
    if (!entry?.isImported) continue;
    if (_importedTextureSignature(t) === target) return id;
  }
  return null;
}

function _filenameFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('data:')) return null;
  const last = url.split(/[\\/]/).pop();
  if (!last || last.startsWith('blob:')) return null;
  return last;
}

const TEX_THUMB_SIZE = 128;

async function _generateImportedTextureThumbnail(assetId, texture) {
  try {
    await _awaitTextureReady(texture);
    const dataUrl = await _readTextureToDataUrl(texture, TEX_THUMB_SIZE);
    if (!dataUrl) return;
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
    dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry: getState().scene.assetLibrary[assetId] });
  } catch (err) {
    console.error(`Imported texture thumbnail failed for ${assetId}:`, err);
  }
}

function _awaitTextureReady(texture) {
  if (typeof texture.isReady !== 'function' || texture.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      if (texture.isReady()) return resolve();
      if (performance.now() - start > 5000) return reject(new Error('texture not ready (timeout)'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

/**
 * Read a Babylon texture back into a canvas and return a data URL. Handles
 * Uint8 and Float32 pixel buffers, RGB and RGBA, and Y-flips the result so
 * the thumbnail reads right-side up (glTF textures upload with invertY=false,
 * so readPixels returns GL bottom-up data).
 */
async function _readTextureToDataUrl(texture, targetSize) {
  const size = texture.getSize?.();
  const w = size?.width  | 0;
  const h = size?.height | 0;
  if (!w || !h) return null;

  const pixels = await texture.readPixels();
  if (!pixels) return null;

  // Normalise to a single Uint8ClampedArray of RGBA bytes.
  let rgba;
  if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
    const u8 = pixels instanceof Uint8ClampedArray
      ? pixels
      : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (u8.length === w * h * 4) {
      rgba = u8;
    } else if (u8.length === w * h * 3) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < u8.length; i += 3, j += 4) {
        rgba[j]   = u8[i];
        rgba[j+1] = u8[i+1];
        rgba[j+2] = u8[i+2];
        rgba[j+3] = 255;
      }
    } else {
      return null;
    }
  } else if (pixels instanceof Float32Array) {
    const stride = pixels.length === w * h * 4 ? 4 : pixels.length === w * h * 3 ? 3 : 0;
    if (!stride) return null;
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < pixels.length; i += stride, j += 4) {
      rgba[j]   = Math.max(0, Math.min(255, pixels[i]   * 255));
      rgba[j+1] = Math.max(0, Math.min(255, pixels[i+1] * 255));
      rgba[j+2] = Math.max(0, Math.min(255, pixels[i+2] * 255));
      rgba[j+3] = stride === 4 ? Math.max(0, Math.min(255, pixels[i+3] * 255)) : 255;
    }
  } else {
    return null;
  }

  const source = document.createElement('canvas');
  source.width  = w;
  source.height = h;
  source.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);

  const thumb = document.createElement('canvas');
  thumb.width  = targetSize;
  thumb.height = targetSize;
  const ctx = thumb.getContext('2d');
  ctx.save();
  ctx.translate(0, targetSize);
  ctx.scale(1, -1);
  ctx.drawImage(source, 0, 0, targetSize, targetSize);
  ctx.restore();

  return thumb.toDataURL('image/png');
}

// ── Helpers ──────────────────────────────────────────────

function _extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function _scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
}

/**
 * Look for a Blender custom property called "ratio" inside the glTF "extras"
 * bag on any node in the container. Accepts '1/72', '1:72', or '72'. Returns
 * the denominator as a positive integer, or null when absent / malformed.
 */
function _extractModelRatio(container) {
  const nodes = [...container.meshes, ...container.transformNodes];
  for (const node of nodes) {
    const extras = node.metadata?.gltf?.extras;
    if (!extras) continue;
    const raw = extras.ratio ?? extras.Ratio;
    if (raw == null) continue;
    const parsed = _parseRatio(raw);
    if (parsed) return parsed;
  }
  return null;
}

function _parseRatio(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // '1/72' or '1:72'  →  denominator
  let m = s.match(/^\s*1\s*[/:]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? Math.round(n) : null;
  }
  // bare number '72'  →  denominator
  m = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? Math.round(n) : null;
  }
  return null;
}

// importScaleFactor + bakeImportTransform — THE import-normalization seam —
// now live in ImportNormalizer.js (imported above and re-exported below).

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
      name: mesh.name || 'mesh',
      assetId,
      collectionId: collectionId ?? null,
      parentId: null,
      shaderId: shaderId ?? null,
      visible: mesh.isVisible !== false,
      locked: false,
      isGhost: false,
      isPrintPart: true,
      partLabel: '',
      partTolerance: 0,
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
      if (errs > 0) {
        const w = warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
        Toast.show(`✗ ${name}: ${errs} error${errs === 1 ? '' : 's'}${w}`, 'error', 0);
      } else {
        Toast.show(`⚠ ${name}: ${warns} warning${warns === 1 ? '' : 's'}`, 'warning', 0);
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
  const url = _blobUrls.get(assetId);
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
 * @returns {Promise<BABYLON.AbstractMesh[]>} ordered geometry meshes
 */
export async function restoreContainer(assetId, blob, extension) {
  const scene = SceneManager.getScene();
  const blobUrl = URL.createObjectURL(blob);
  _blobUrls.set(assetId, blobUrl);
  const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
    blobUrl, '', scene, null, extension
  );
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
 * Recreate a user-loaded texture asset from embedded bytes, keeping its
 * persisted assetId so shader.diffuseTextureAssetId stays valid.
 * @param {object} entry  persisted AssetEntry (kind 'texture', !isImported)
 * @param {Blob}   blob
 * @returns {Promise<string>} assetId
 */
export async function restoreTexture(entry, blob) {
  const scene = SceneManager.getScene();
  const blobUrl = URL.createObjectURL(blob);
  _blobUrls.set(entry.id, blobUrl);
  const texture = await new Promise((resolve, reject) => {
    const t = new BABYLON.Texture(
      blobUrl, scene, false, false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(t),
      (msg, err) => reject(err ?? new Error(String(msg))),
    );
  });
  _textures.set(entry.id, texture);
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [entry.id]: { ...entry, thumbnailDataUrl: blobUrl } } },
  }), { silent: true });
  return entry.id;
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
  for (const [id, t] of _textures.entries()) {
    const e = getState().scene.assetLibrary[id];
    if (t && !e?.isImported) { try { t.dispose(); } catch { /* */ } }
  }
  for (const url of _blobUrls.values()) URL.revokeObjectURL(url);
  _containers.clear();
  _textures.clear();
  _blobUrls.clear();
  _meshRegistry.clear();
}

export function removeAsset(assetId) {
  if (!getState().scene.assetLibrary[assetId]) return;
  setState(s => {
    const lib = { ...s.scene.assetLibrary };
    delete lib[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: lib } };
  });
  dispatch(EVENTS.ASSET_REGISTERED, { type: 'removed', assetId });
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
  restoreTexture, registerAssetEntry, resetAll,
  bakeImportTransform, importScaleFactor,
};
