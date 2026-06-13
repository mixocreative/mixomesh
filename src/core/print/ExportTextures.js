// Export-side texture collection (split from PrintManager.js — review L29).
// Shared by the OBJ serializer (textures/ zip entries) and the 3MF Materials
// Extension writer (OPC texture parts).

import { getState } from '../StateManager.js';
import { textureToPngBlob } from '../assets/TextureReadback.js';
import { getTextureSource } from '../assets/TextureSource.js';

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
  }
  const blob = await textureToPngBlob(texture);
  if (!blob) throw new Error(`Texture readback failed for ${texture?.name ?? 'texture'}`);
  return blob;
}

/**
 * Find the asset ID for a texture by checking the asset library, falling back
 * to the texture's own name for container-owned instances.
 */
export function getAssetIdForTexture(texture) {
  const state = getState();
  for (const [assetId, asset] of Object.entries(state.scene.assetLibrary)) {
    if (asset.kind === 'texture' && asset.babylonTextureName
        && asset.babylonTextureName === texture.name) {
      return assetId;
    }
  }
  return texture.name || texture.uniqueId?.toString();
}

/**
 * Extract all unique diffuse/albedo/base textures from a list of meshes and
 * convert to PNG blobs. Returns Map<filename, blob> for `textures/` entries.
 */
export async function collectTextureBlobs(meshes) {
  const textureMap = new Map(); // assetId → { name, blob }

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!mat) continue;

    const textures = [];
    if (mat.diffuseTexture) textures.push(mat.diffuseTexture);
    else if (mat.albedoTexture) textures.push(mat.albedoTexture);
    else if (mat.baseTexture) textures.push(mat.baseTexture);

    for (const tex of textures) {
      if (!tex) continue;
      const assetId = getAssetIdForTexture(tex);
      if (!assetId || textureMap.has(assetId)) continue;
      try {
        const blob = await textureToBlob(tex, assetId);
        textureMap.set(assetId, { name: tex.name || assetId, blob });
      } catch (err) {
        console.error(`Failed to export texture ${tex.name}:`, err);
      }
    }
  }

  // Build result map with deduped filenames.
  const result = new Map();
  const usedNames = new Set();
  for (const [, { name, blob }] of textureMap) {
    let filename = `${name}.png`;
    let counter = 0;
    while (usedNames.has(filename)) {
      counter++;
      filename = `${name}_${counter}.png`;
    }
    usedNames.add(filename);
    result.set(filename, blob);
  }
  return result;
}

export function sanitizeTextureName(name) {
  return String(name || 'texture').replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Walk export clones, extract every unique diffuse/albedo/base texture as a
 * PNG blob, and assign each a stable OPC package path. Returns:
 *   blobByPath  – Map<packagePath, Blob>   (zip entries)
 *   pathByMesh  – Map<mesh, packagePath>   (XML attrs)
 * Meshes without a texture (or with no UVs) are absent from pathByMesh and
 * the 3MF writer falls them through to the colorgroup path.
 */
export async function collectMimakiTextures(meshList, BABYLON) {
  const blobByPath = new Map();
  const pathByMesh = new Map();
  const pathByAssetId = new Map();
  const usedNames = new Set();

  for (const { mesh } of meshList) {
    const mat = mesh.material;
    if (!mat) continue;
    const tex = mat.diffuseTexture || mat.albedoTexture || mat.baseTexture;
    if (!tex) continue;
    // Need UVs to map this texture to geometry. Without them, fall through
    // to colorgroup with the material's diffuse colour.
    const uvs = mesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
    if (!uvs || uvs.length === 0) continue;

    const assetId = getAssetIdForTexture(tex);
    let path = pathByAssetId.get(assetId);
    if (!path) {
      const base = sanitizeTextureName(tex.name || assetId);
      let filename = `${base}.png`;
      let counter = 0;
      while (usedNames.has(filename)) { counter++; filename = `${base}_${counter}.png`; }
      usedNames.add(filename);
      path = `3D/Textures/${filename}`;
      try {
        const blob = await textureToBlob(tex, assetId);
        blobByPath.set(path, blob);
        pathByAssetId.set(assetId, path);
      } catch (err) {
        console.error(`Texture encode failed for ${tex.name}:`, err);
        continue;
      }
    }
    pathByMesh.set(mesh, path);
  }
  return { blobByPath, pathByMesh };
}
