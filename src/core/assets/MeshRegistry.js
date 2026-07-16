// Mesh/container registry — the module-local maps every asset concern shares:
// assetId → AssetContainer, meshId → AbstractMesh, plus orphan meshes that
// live OUTSIDE any container (duplicate clones, restore de-dupe clones) —
// container disposal can't reach those, so resetRegistry disposes them
// explicitly to avoid leaks. Never persisted in state.

import { DEFAULT_SOURCE_UNIT } from '../ImportNormalizer.js';

const _containers   = new Map();    // assetId → BABYLON.AssetContainer
const _meshRegistry = new Map();    // meshId  → BABYLON.AbstractMesh
const _orphanMeshes = new Set();

let _idCounter = 0;

/** Mint a unique runtime id (`asset_…`, `mesh_…`, `col_…`). */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${++_idCounter}`;
}

/** @param {string} assetId */
export function getContainer(assetId) {
  return _containers.get(assetId) ?? null;
}

/** Register a loaded AssetContainer under its assetId. */
export function registerContainer(assetId, container) {
  _containers.set(assetId, container);
}

/** Drop the container reference WITHOUT disposing (caller owns disposal). */
export function removeContainer(assetId) {
  _containers.delete(assetId);
}

/** @param {string} meshId */
export function getBabylonMesh(meshId) {
  return _meshRegistry.get(meshId) ?? null;
}

/** Register a Babylon mesh under its SceneObject meshId. */
export function registerMesh(meshId, mesh) {
  _meshRegistry.set(meshId, mesh);
}

/** @param {string} meshId */
export function hasMesh(meshId) {
  return _meshRegistry.has(meshId);
}

/**
 * Track a mesh that lives outside any asset container (duplicate clone,
 * restore de-dupe clone) so resetRegistry can dispose it.
 */
export function trackOrphan(mesh) {
  _orphanMeshes.add(mesh);
}

/**
 * Geometry-bearing meshes of a container, in stable load order. The same
 * filter AssetRegistration's mesh minting uses, so a saved
 * `containerMeshIndex` resolves back to the same mesh on reload.
 * @param {string} assetId
 * @returns {BABYLON.AbstractMesh[]}
 */
export function getContainerGeomMeshes(assetId) {
  const container = _containers.get(assetId);
  if (!container) return [];
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

/** Dispose every container + orphan mesh and clear all maps (project reset). */
export function resetRegistry() {
  for (const c of _containers.values()) {
    try { c.removeAllFromScene(); c.dispose(); } catch { /* */ }
  }
  for (const m of _orphanMeshes) { try { m.dispose(); } catch { /* */ } }
  _orphanMeshes.clear();
  _containers.clear();
  _meshRegistry.clear();
}
