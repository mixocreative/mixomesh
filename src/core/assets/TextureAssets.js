// Texture-asset registry (split from AssetLoader.js — review L29): user-
// loaded image assets, glTF/3MF-embedded ("imported") textures, §10b
// identity-scoped dedupe, reload rebind, and GPU-readback thumbnails.
// Live BABYLON.BaseTexture instances live in the module-local `_textures`
// map — state holds only JSON AssetEntries.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { extOf as _extOf, isTextureExt } from './AssetTypes.js';
import { textureToDataUrl } from './TextureReadback.js';
import { setBlobUrl, revokeBlobUrl } from './BlobUrls.js';

const BABYLON = window.BABYLON;

const TEX_THUMB_SIZE = 128;

const _textures = new Map();    // assetId → BABYLON.BaseTexture

let _idCounter = 0;
const _newId = () => `tex_${Date.now().toString(36)}_${++_idCounter}`;

function _scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
}

/** @param {string} assetId */
export function getBabylonTexture(assetId) {
  return _textures.get(assetId) ?? null;
}

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
  const assetId = _newId();
  const blobUrl = URL.createObjectURL(blob);
  setBlobUrl(assetId, blobUrl);

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
 * @param {{ sourceFileHash?: string|null, sourceAssetId?: string|null }} [ctx]
 *   §10b identity scope — sourceFileHash is the sha256 of the source file the
 *   texture arrived in; sourceAssetId is the owning mesh AssetEntry.
 * @returns {string|null}
 */
export function registerImportedTexture(texture, ctx = {}) {
  if (!texture) return null;
  for (const [id, t] of _textures.entries()) {
    if (t === texture) return id;
  }
  // Content-dedupe scoped by source file (§10b): same bytes re-imported reuse
  // the canonical assetId; two DIFFERENT files never merge, even when loaders
  // mint identical generic names ("Image_0") at equal dimensions (review H6).
  const dupId = _findImportedTextureBySignature(texture, ctx);
  if (dupId) return dupId;

  const assetId = _newId();
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
    sourceFileHash: ctx.sourceFileHash ?? null,
    sourceAssetId: ctx.sourceAssetId ?? null,
    babylonTextureName: typeof texture.name === 'string' ? texture.name : null,
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

function _importedTextureSignature(texture, sourceFileHash) {
  const size = typeof texture.getSize === 'function' ? texture.getSize() : null;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  const cls = texture.constructor?.name ?? 'Texture';
  return `${sourceFileHash ?? ''}|${texture.name ?? ''}|${w}|${h}|${cls}`;
}

function _findImportedTextureBySignature(texture, ctx = {}) {
  // No file-hash scope → no content dedupe. Unscoped matching is exactly the
  // cross-file aliasing bug (H6); instance identity was already checked.
  if (!ctx.sourceFileHash) return null;
  const target = _importedTextureSignature(texture, ctx.sourceFileHash);
  for (const [id, t] of _textures.entries()) {
    const entry = getState().scene.assetLibrary[id];
    if (!entry?.isImported) continue;
    if (_importedTextureSignature(t, entry.sourceFileHash) === target) return id;
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

async function _generateImportedTextureThumbnail(assetId, texture) {
  try {
    await _awaitTextureReady(texture);
    const dataUrl = await textureToDataUrl(texture, TEX_THUMB_SIZE);
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
 * Bind a restored container-owned texture instance under its persisted
 * assetId (§10b reload rebind). PersistenceManager matches the instance by
 * `babylonTextureName` inside the freshly restored container; this just
 * registers it so `getBabylonTexture` / shader restore resolve it live.
 * @param {string} assetId   persisted imported-texture asset id
 * @param {BABYLON.BaseTexture} texture
 */
export function bindRestoredTexture(assetId, texture) {
  if (!assetId || !texture) return;
  _textures.set(assetId, texture);
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
  setBlobUrl(entry.id, blobUrl);
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
 * Release a texture asset if no shader still references it. Imported
 * (container-owned) instances are never disposed here.
 * @returns {boolean} true when the caller may drop the AssetEntry
 */
export function releaseTextureAsset(assetId, entry) {
  const shaders = getState().scene.shaders;
  const refd = Object.values(shaders).some(s => s.diffuseTextureAssetId === assetId);
  if (refd) return false;
  const tex = _textures.get(assetId);
  if (tex && !entry.isImported) tex.dispose();
  _textures.delete(assetId);
  revokeBlobUrl(assetId);
  return true;
}

/** Dispose every owned texture + clear the registry (new/load project). */
export function resetTextures() {
  for (const [id, t] of _textures.entries()) {
    const e = getState().scene.assetLibrary[id];
    if (t && !e?.isImported) { try { t.dispose(); } catch { /* */ } }
  }
  _textures.clear();
}
