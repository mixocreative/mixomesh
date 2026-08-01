// Project-restore and duplicate paths: rebuild containers from saved bytes
// without minting new state, clone meshes with independent geometry, and
// serve raw asset bytes back to PersistenceManager for embedding.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import {
  bakeImportTransform, importScaleFactor, DEFAULT_SOURCE_UNIT,
} from '../ImportNormalizer.js';
import { setBlobUrl, getBlobUrl, revokeBlobUrl } from './BlobUrls.js';
import {
  newId, registerContainer, registerMesh, hasMesh, trackOrphan,
  getBabylonMesh, bindRestoredMesh,
} from './MeshRegistry.js';
import {
  collectObjSiblings, rememberObjSiblings, installSiblingUrls, revokeObjSiblings,
} from './ObjSiblings.js';
import { splitMultiMaterialMeshesInContainer } from './MeshSplit.js';
import { nextDupName, registerAssetEntry } from './AssetRegistration.js';
import { loadContainer, filterContainerToLibraryItem } from './AssetImport.js';
import { encodeGeometry, decodeGeometry } from '../GeometryCodec.js';
import { sha256Hex } from '../hash.js';

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

  // Synthetic baked geometry (Boolean result, ADR 0002): decode raw VertexData and
  // build the mesh directly — it is ALREADY world-space, so NO import normalization
  // (unit/flip/scale). The per-object ratio delta (a no-op at ratio=1) is applied by
  // PersistenceManager like any other restored mesh.
  if (extension === '.mxvd') return _restoreMxvd(assetId, blob);

  let siblings = null;
  if (extension === '.obj') {
    siblings = await collectObjSiblings(opts);
    if (siblings.size) rememberObjSiblings(assetId, siblings);
  }
  const restoreUrls = installSiblingUrls(siblings);
  let container;
  try {
    container = await loadContainer(blobUrl, extension, scene, null, siblings);
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
  if (opts.libraryItem) filterContainerToLibraryItem(container, opts.libraryItem);
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
 * Cache mesh asset bytes without loading geometry into the scene. Library GLB
 * assets use this on project restore when they have no SceneObjects yet.
 */
export function cacheAssetBlob(assetId, blob) {
  setBlobUrl(assetId, URL.createObjectURL(blob));
}

// Rebuild a Boolean result from its `.mxvd` bytes — verbatim world-space geometry,
// no import normalization. Colour is restored by ShaderLibrary via the SceneObject's
// shaderId (the `.mxvd` stores geometry only); the placeholder material is replaced.
async function _restoreMxvd(assetId, blob) {
  const B = window.BABYLON;
  const scene = SceneManager.getScene();
  const { positions, indices, normals } = decodeGeometry(await blob.arrayBuffer());
  const mesh = new B.Mesh(`${assetId}_geom`, scene);
  const vd = new B.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  if (normals) vd.normals = normals;
  vd.applyToMesh(mesh);
  mesh.material = scene.defaultMaterial;
  const container = new B.AssetContainer(scene);
  container.meshes.push(mesh);
  registerContainer(assetId, container);
  return [mesh];
}

/**
 * Register a live baked mesh (a Boolean result — ADR 0002) as a synthetic EMBEDDED
 * `.mxvd` asset that round-trips through `.mixo`. Geometry is world-space, so restore
 * skips import normalization; neutral fields (`sourceUnit:'meters'`, `modelRatio:1`)
 * keep the per-object ratio delta at 1. Returns the minted `{ assetId, meshId }`; the
 * caller creates the SceneObject (`ratio:1`) + assigns a shader for colour.
 * @param {BABYLON.Mesh} mesh  live world-space result mesh
 * @param {string} name
 * @returns {Promise<{assetId:string, meshId:string}>}
 */
export async function registerBakedResult(mesh, name = 'Boolean Result') {
  const B = window.BABYLON;
  const assetId = newId('asset');
  const meshId = newId('mesh');

  const vd = B.VertexData.ExtractFromMesh(mesh);
  const buffer = encodeGeometry({ positions: vd.positions, indices: vd.indices, normals: vd.normals });
  const contentHash = await sha256Hex(buffer);
  cacheAssetBlob(assetId, new Blob([buffer]));

  bindRestoredMesh(meshId, mesh, assetId, 'meters');
  const container = new B.AssetContainer(SceneManager.getScene());
  container.meshes.push(mesh);
  registerContainer(assetId, container);

  registerAssetEntry({
    id: assetId, name, filename: `${name}.mxvd`, displayName: name,
    originalPath: null, extension: '.mxvd', kind: 'mesh',
    sourceUnit: 'meters', unitConfirmed: true, modelRatio: 1,
    directoryHandleKey: null, fileHandleKey: null,
    contentHash, isImported: false,
    sourceFileHash: null, sourceAssetId: null, babylonTextureName: null,
    libraryItem: null, thumbnailDataUrl: null,
  });
  return { assetId, meshId };
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

  const cloneId = newId('mesh');
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
  clone.metadata   = { ...(sourceMesh.metadata ?? {}), meshId: cloneId };
  clone.isVisible  = sourceMesh.isVisible !== false;
  // Duplicating while the wireframe-edges overlay is ON also clones the
  // overlay child — dispose it; SceneManager re-ensures a tracked one via
  // the ASSET_INSTANTIATED hook.
  for (const child of clone.getChildMeshes?.(true) ?? []) {
    if (child.metadata?.edgeOverlay) { try { child.dispose(); } catch { /* */ } }
  }
  registerMesh(cloneId, clone);

  const newObj = {
    ...sourceObj,
    id: cloneId,
    name: nextDupName(sourceObj.name),
    parentId: sourceObj.parentId ?? null,
  };
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { ...s.scene.objects, [cloneId]: newObj },
      groups: newObj.parentId && s.scene.groups[newObj.parentId]
        ? {
            ...s.scene.groups,
            [newObj.parentId]: {
              ...s.scene.groups[newObj.parentId],
              childIds: [...new Set([...(s.scene.groups[newObj.parentId].childIds ?? []), cloneId])],
            },
          }
        : s.scene.groups,
    },
  }), { silent: true });

  if (sourceObj.shaderId) ShaderLibrary.linkMesh(sourceObj.shaderId, cloneId);

  dispatch(EVENTS.ASSET_INSTANTIATED, { assetId: sourceObj.assetId, meshId: cloneId, meshName: clone.name });
  return cloneId;
}

/** Internal — used by DuplicateCommand's undo/redo to restore a saved clone. */
export function restoreCloneToScene(meshId, savedObj, mesh) {
  if (!hasMesh(meshId)) registerMesh(meshId, mesh);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: savedObj } },
  }), { silent: true });
}
