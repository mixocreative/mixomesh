// Export-side texture collection (split from PrintManager.js — review L29).
// Shared by the OBJ serializer (textures/ zip entries) and the 3MF Materials
// Extension writer (OPC texture parts).

import { getState } from '../StateManager.js';
import { textureToPngBlob } from '../assets/TextureReadback.js';
import { getTextureSource } from '../assets/TextureSource.js';
import { getTextureImage } from '../assets/TextureImageStore.js';
import { hasCaptureFailed, currentCapPx } from '../assets/TextureCap.js';

/**
 * Pixel size of the texture an export would ship for `assetId` (1.4 readiness).
 * Reads the frozen full-res source / image store — never the GPU copy, which
 * the viewport cap may have shrunk.
 * @returns {{width:number,height:number}|null} null when unknown
 */
export function getTextureDimensions(assetId, state = getState()) {
  const src = getTextureSource(assetId);
  if (src?.width > 0 && src?.height > 0) return { width: src.width, height: src.height };
  const hash = state.scene?.assetLibrary?.[assetId]?.imageContentHash;
  const img = hash ? getTextureImage(hash) : null;
  return img?.width > 0 && img?.height > 0 ? { width: img.width, height: img.height } : null;
}

export function clamp255(c) { return Math.max(0, Math.min(255, Math.round((c ?? 0) * 255))); }
export function hex2(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }

/**
 * Convert a Babylon texture to a PNG blob for export.
 *
 * Prefers the FULL-RES SOURCE captured at import (TextureSource.js) over a
 * GPU readback: the viewport texture cap may have downscaled the GPU copy, but
 * the source is frozen at full resolution — this is what keeps Mimaki exports
 * bit-for-bit full-res regardless of the viewport cap. The source PNG is the
 * same single-flip readback the GPU path produces (captured via
 * textureToPngBlob before any cap), so it is orientation-identical. Falls back
 * to a live GPU readback when no source was captured (no cap in play).
 * @param {BABYLON.BaseTexture} texture
 * @param {string|null} [assetId]  asset id to look up the captured source
 */
export async function textureToBlob(texture, assetId = null) {
  if (assetId) {
    const src = getTextureSource(assetId);
    if (src?.blob) return src.blob;
    // Source capture failed at import: a GPU readback is only full-res if the
    // viewport cap is Off. With the cap On it may be downscaled — never ship it.
    if (hasCaptureFailed(assetId) && currentCapPx() > 0) {
      throw new Error(`Texture "${texture?.name ?? assetId}" has no full-resolution source (capture failed) and the viewport texture cap is On — export aborted so a downscaled texture is not printed. Turn the texture cap Off and retry.`);
    }
  }
  const blob = await textureToPngBlob(texture, { toSrgb: true });   // 1.9: linear → sRGB on readback only
  if (!blob) throw new Error(`Texture readback failed for ${texture?.name ?? 'texture'}`);
  return blob;
}

async function _readTextureOrThrow(tex, assetId) {
  try {
    return await textureToBlob(tex, assetId);
  } catch (err) {
    const e = new Error(`Texture "${tex?.name ?? assetId ?? 'texture'}" could not be read — export aborted so the print would not lose it (${err?.message ?? err})`);
    e.textureExportFailure = true;
    throw e;
  }
}

/**
 * Find the asset ID for a texture by checking the asset library, falling back
 * to the texture's own name for container-owned instances.
 */
export function getAssetIdForTexture(texture, state = getState()) {
  const taggedId = texture?.metadata?.mixoAssetId;
  if (typeof taggedId === 'string' && taggedId) return taggedId;

  for (const [assetId, asset] of Object.entries(state.scene.assetLibrary)) {
    if (asset.kind === 'texture' && asset.babylonTextureName
        && asset.babylonTextureName === texture.name) {
      return assetId;
    }
  }
  return texture.name || texture.uniqueId?.toString();
}

// `state` = the export batch's snapshot (M8); getState() only when no ctx reaches here.
function _textureAssetEntry(assetId, state = getState()) {
  if (!assetId) return null;
  return state.scene.assetLibrary?.[assetId] ?? null;
}

function _stripImageExtension(value) {
  return String(value || 'texture').replace(/\.[^./\\]+$/, '') || 'texture';
}

/**
 * The material slot an export texture fills. Only the base-colour image ships
 * (diffuse / albedo / base — the colour a full-colour printer paints), so the
 * slot is always `baseColor` (§4.4 rule 5 / Decision 17).
 */
export const EXPORT_TEXTURE_SLOT = 'baseColor';

/**
 * Sanitised package-name base, or null when nothing meaningful survives (a
 * name of only non-ASCII characters would collapse to `___`).
 */
function _meaningfulBase(value) {
  if (value == null || value === '') return null;
  // No extension strip: object/material names like `part.001` are names, not
  // files — `part.001` and `part.002` must not both collapse to `part`.
  const base = sanitizeTextureName(String(value));
  return /[A-Za-z0-9]/.test(base) ? base : null;
}

/**
 * Package file name for one exported texture. `preferredBase` is the
 * Decision 17 name (`<object>_<slot>` or a shared texture's material name);
 * without one (or when it sanitises to nothing) the texture asset's own name
 * is used. Uniqueness is decided case-insensitively against `usedNames`.
 * @param {object} texture
 * @param {string|null} assetId
 * @param {Set<string>} [usedNames]  lower-cased names already taken (mutated)
 * @param {object} [state]
 * @param {string|null} [preferredBase]
 * @returns {string}
 */
export function textureExportFilename(texture, assetId, usedNames = new Set(), state = undefined, preferredBase = null) {
  const asset = _textureAssetEntry(assetId, state);
  const sourceName = asset?.filename || asset?.name || texture?.name || assetId || 'texture';
  const base = _meaningfulBase(preferredBase)
    ?? (sanitizeTextureName(_stripImageExtension(sourceName)) || 'texture');
  let filename = `${base}.png`;
  let counter = 0;
  // Uniqueness is decided on the LOWER-CASED name (Windows/macOS file systems
  // and many zip tools are case-insensitive: `A.png` and `a.png` would
  // collide). The set stores lower-cased keys; the first name keeps its casing.
  while (usedNames.has(filename.toLowerCase())) {
    counter++;
    filename = `${base}_${counter}.png`;
  }
  usedNames.add(filename.toLowerCase());
  return filename;
}

function _baseColorTexture(mat) {
  return mat ? (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture || null) : null;
}

/** Accept bare meshes or export entries (`{mesh, logicalId, logicalName, …}`). */
function _asEntry(item) {
  return item && typeof item === 'object' && 'mesh' in item ? item : { mesh: item };
}

/** Owning logical object of an export entry: stable key + display name. */
function _objectOf(entry, state) {
  const id = entry.logicalId ?? entry.meshId ?? null;
  const objects = state?.scene?.objects ?? {};
  const name = entry.objectName ?? entry.logicalName ?? (id != null ? objects[id]?.name : null) ?? null;
  return { key: id ?? name ?? null, name };
}

function _materialName(mat) {
  const n = mat?.name || mat?.id;
  return n == null || n === '' ? null : String(n);
}

/**
 * Decision 17 naming pass. `uses` lists every (texture, entry) pair in export
 * order. A texture used by exactly ONE object is named `<object>_<slot>`; one
 * shared by several objects is named after its (first) material; a texture
 * whose owner is unknown (bare-mesh callers) keeps its asset name. Every name
 * is unique case-insensitively, and the writers read references (MTL
 * `map_Kd`, 3MF `<m:texture2d path>`, PLY/WRL texture files) from the maps
 * built on this result, so a reference always equals its packaged entry.
 * @returns {Map<string, string>} assetId → file name
 */
function _planTextureNames(uses, state, usedNames) {
  const byAsset = new Map();
  for (const { assetId, texture, entry } of uses) {
    let rec = byAsset.get(assetId);
    if (!rec) {
      rec = { texture, objects: new Map(), unknownOwner: false, materials: [] };
      byAsset.set(assetId, rec);
    }
    const { key, name } = _objectOf(entry, state);
    if (key == null) rec.unknownOwner = true;
    else if (!rec.objects.has(key)) rec.objects.set(key, name);
    const matName = _materialName(entry.mesh?.material);
    if (matName && !rec.materials.includes(matName)) rec.materials.push(matName);
  }
  const out = new Map();
  for (const [assetId, rec] of byAsset) {
    let preferred = null;
    if (!rec.unknownOwner && rec.objects.size === 1) {
      const [name] = rec.objects.values();
      const base = _meaningfulBase(name);
      if (base) preferred = `${base}_${EXPORT_TEXTURE_SLOT}`;
    } else if (rec.objects.size > 1) {
      preferred = rec.materials[0] ?? null;
    }
    out.set(assetId, textureExportFilename(rec.texture, assetId, usedNames, state, preferred));
  }
  return out;
}

/**
 * Extract all unique diffuse/albedo/base textures from a list of meshes (or
 * export entries) and convert to PNG blobs. Returns:
 *   blobByFilename                – Map<filename, Blob> for `textures/` entries
 *   filenameByMesh                – Map<mesh, filename> (writers key references by this)
 *   textureFilenameByMaterialName – Map<material id|name, filename>
 */
export async function collectTextureExportData(items, state = getState()) {
  const entries = (items ?? []).map(_asEntry);
  const textureMap = new Map(); // assetId → { texture, blob }
  const uses = [];

  for (const entry of entries) {
    const tex = _baseColorTexture(entry.mesh?.material);
    if (!tex) continue;
    const assetId = getAssetIdForTexture(tex, state);
    if (!assetId) continue;
    uses.push({ assetId, texture: tex, entry });
    if (textureMap.has(assetId)) continue;
    // Fail CLOSED. A texture that cannot be read must abort the export —
    // silently shipping a flat-colour OBJ with a success toast is a wrong
    // print (fidelity lock; audit 2026-09-17 C2).
    const blob = await _readTextureOrThrow(tex, assetId);
    textureMap.set(assetId, { texture: tex, blob });
  }

  const filenameByAssetId = _planTextureNames(uses, state, new Set());
  const blobByFilename = new Map();
  for (const [assetId, { blob }] of textureMap) blobByFilename.set(filenameByAssetId.get(assetId), blob);

  const filenameByMesh = new Map();
  const textureFilenameByMaterialName = new Map();
  for (const { assetId, entry } of uses) {
    const filename = filenameByAssetId.get(assetId);
    if (!filename) continue;
    if (entry.mesh) filenameByMesh.set(entry.mesh, filename);
    const mat = entry.mesh?.material;
    const matName = mat?.id || mat?.name || entry.mesh?.name;
    if (matName) textureFilenameByMaterialName.set(String(matName), filename);
  }
  return { blobByFilename, filenameByMesh, textureFilenameByMaterialName };
}

export async function collectTextureBlobs(meshes) {
  const { blobByFilename } = await collectTextureExportData(meshes);
  return blobByFilename;
}

export function sanitizeTextureName(name) {
  return String(name || 'texture').replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Walk export clones (bare meshes or `{mesh, logicalId, logicalName,
 * objectName}` entries), extract every unique diffuse/albedo/base texture as a
 * PNG blob, and assign each a Decision 17 OPC package path. Returns:
 *   blobByPath  – Map<packagePath, Blob>   (zip entries)
 *   pathByMesh  – Map<mesh, packagePath>   (XML attrs)
 * Meshes without a texture (or with no UVs) are absent from pathByMesh and
 * the 3MF writer falls them through to the colorgroup path.
 */
export async function collectMimakiTextures(meshList, BABYLON, state = getState()) {
  const blobByPath = new Map();
  const pathByMesh = new Map();
  const uses = [];

  for (const item of meshList ?? []) {
    const entry = _asEntry(item);
    const mesh = entry.mesh;
    const tex = _baseColorTexture(mesh?.material);
    if (!tex) continue;
    // Need UVs to map this texture to geometry. Without them, fall through
    // to colorgroup with the material's diffuse colour.
    const uvs = mesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
    if (!uvs || uvs.length === 0) continue;
    uses.push({ assetId: getAssetIdForTexture(tex, state), texture: tex, entry });
  }

  // Decision 17 names need every use first; then each texture is read once.
  const filenameByAssetId = _planTextureNames(uses, state, new Set());
  const pathByAssetId = new Map();
  for (const { assetId, texture, entry } of uses) {
    let path = pathByAssetId.get(assetId);
    if (!path) {
      path = `3D/Textures/${filenameByAssetId.get(assetId)}`;
      // Fail CLOSED (see collectTextureExportData): a dropped texture would
      // silently fall through to a solid colorgroup part.
      const blob = await _readTextureOrThrow(texture, assetId);
      blobByPath.set(path, blob);
      pathByAssetId.set(assetId, path);
    }
    pathByMesh.set(entry.mesh, path);
  }
  return { blobByPath, pathByMesh };
}
