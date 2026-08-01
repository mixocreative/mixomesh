// Mesh-asset façade — thin surface over ./assets/* (house pattern:
// PrintManager over ./print/*). Import paths live in assets/AssetImport.js,
// restore/clone paths in assets/AssetRestore.js, SceneObject minting in
// assets/AssetRegistration.js, registries in assets/MeshRegistry.js, texture
// assets in assets/TextureAssets.js, split-on-import in assets/MeshSplit.js.
// This module owns only the cross-cutting lifecycle (release / remove /
// reset-all) and re-exports the frozen public API.

import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { bakeImportTransform, importScaleFactor } from './ImportNormalizer.js';
import { isMeshExt, isTextureExt } from './assets/AssetTypes.js';
import { revokeBlobUrl, revokeAllBlobUrls } from './assets/BlobUrls.js';
import {
  getContainer, removeContainer, getBabylonMesh,
  getContainerGeomMeshes, bindRestoredMesh, resetRegistry,
} from './assets/MeshRegistry.js';
import { mountDirectory, restoreDirectory, getDirectoryHandle } from './assets/DirMounts.js';
import { revokeObjSiblings, revokeAllObjSiblings } from './assets/ObjSiblings.js';
import { registerAssetEntry } from './assets/AssetRegistration.js';
import { loadFromBlob, loadFromHandle, instantiateAsset } from './assets/AssetImport.js';
import {
  getAssetBytes, restoreContainer, cacheAssetBlob, registerBakedResult,
  cloneRestoredMesh, cloneMeshAsNewObject, restoreCloneToScene,
} from './assets/AssetRestore.js';
import {
  splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer,
} from './assets/MeshSplit.js';
import {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture,
  releaseTextureAsset, resetTextures, recapAllTextures,
} from './assets/TextureAssets.js';

// ── Re-exported surface (unchanged for callers/tests) ────────────────────

export { mountDirectory, restoreDirectory, getDirectoryHandle };
export { loadFromBlob, loadFromHandle, instantiateAsset };
export { getContainer, getBabylonMesh, getContainerGeomMeshes, bindRestoredMesh };
export {
  getAssetBytes, restoreContainer, cacheAssetBlob,
  cloneRestoredMesh, cloneMeshAsNewObject, restoreCloneToScene,
};
export { registerAssetEntry };
export { isMeshExt, isTextureExt };
export {
  loadTextureFromHandle, loadTextureFromBlob, getBabylonTexture,
  registerImportedTexture, bindRestoredTexture, restoreTexture, recapAllTextures,
};
export { splitMultiMaterialMeshes, splitMultiMaterialMeshesInContainer };

// ── Lifecycle ─────────────────────────────────────────────

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

export function removeAsset(assetId) {
  if (!getState().scene.assetLibrary[assetId]) return;
  setState(s => {
    const lib = { ...s.scene.assetLibrary };
    delete lib[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: lib } };
  });
  dispatch(EVENTS.ASSET_REMOVED, { assetId });
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

// NOT frozen — monkey-patching this object (`AssetLoader.getBabylonMesh = …`)
// is the established headless-test seam (bundle-1 plan 2026-06-11).
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
  restoreTexture, registerAssetEntry, cacheAssetBlob, registerBakedResult, resetAll,
  bakeImportTransform, importScaleFactor,
};
