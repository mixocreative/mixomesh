// Main-thread side of the STL / 3MF import worker (heavy-mesh spec §7.3).
// workers/MeshImport.worker.js reads the blob URL, parses and welds off the UI
// thread and transfers typed arrays back; this module turns them into an
// AssetContainer exactly like Babylon's own STL loader / the 3MF plugin would
// (same names, axes, materials), so the normal import flow continues
// unchanged. Not available under Node (no Worker) — callers fall back to the
// SceneLoader plugins.

import { WorkerTask } from './workers/WorkerTask.js';
import { buildThreeMFContainerFromParsed } from './ThreeMFLoader.js';
import { caps } from './storage/capabilities.js';
import { markFlat } from './scene/FlatShading.js';

const BABYLON = window.BABYLON;

/** Generous wall clock for a 1 GB file on a slow disk; the UI stays live meanwhile. */
export const MESH_IMPORT_TIMEOUT_MS = 600_000;
const KINDS = { '.stl': 'stl', '.3mf': '3mf' };

const _task = new WorkerTask({
  name: 'Model import',
  label: 'job.importModel',
  mode: 'per-job',
  timeoutMs: MESH_IMPORT_TIMEOUT_MS,
  create: () => new Worker(new URL('./workers/MeshImport.worker.js', import.meta.url), { type: 'module' }),
});

/** True when `ext` imports through the worker in this runtime. */
export function isMeshWorkerImport(ext) {
  return typeof Worker === 'function' && !!KINDS[ext];
}

/** Welded STL meshes → container, mirroring STLFileLoader.loadAssetContainer. */
export function buildStlContainer(scene, meshes) {
  const container = new BABYLON.AssetContainer(scene);
  scene._blockEntityCollection = true;
  try {
    for (const m of meshes) {
      const mesh = new BABYLON.Mesh(m.name || 'stlmesh', scene);
      const vd = new BABYLON.VertexData();
      vd.positions = m.positions;
      vd.normals = m.normals;
      vd.indices = m.indices;
      vd.applyToMesh(mesh);
      // Welded geometry, faceted look: STL always rendered flat (review I1).
      markFlat(mesh);
      mesh.computeWorldMatrix(true);
      container.meshes.push(mesh);
    }
  } finally {
    scene._blockEntityCollection = false;
  }
  return container;
}

/**
 * Parse an STL or 3MF in the worker and build its AssetContainer (NOT yet
 * added to the scene — the caller does addAllToScene).
 * @param {BABYLON.Scene} scene
 * @param {string} blobUrl
 * @param {string} ext  '.stl' | '.3mf'
 * @param {{ onProgress?: (e: import('./workers/serveTask.js').ProgressFields) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<BABYLON.AssetContainer>}
 */
export async function loadMeshContainerViaWorker(scene, blobUrl, ext, { onProgress, signal } = {}) {
  const kind = KINDS[ext];
  if (!kind) throw new Error(`No worker import for ${ext}`);
  const result = await _task.run(
    { kind, blobUrl, triangleLimit: caps.triangleLimit },
    { onProgress, signal, label: kind === 'stl' ? 'job.importStl' : 'job.import3mf', cancellable: true },
  );
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  if (kind === 'stl') {
    if (!result?.meshes?.length) throw new Error('STL: no geometry found in file');
    return buildStlContainer(scene, result.meshes);
  }
  return buildThreeMFContainerFromParsed(scene, result);
}

export const MeshImportWorker = { isMeshWorkerImport, loadMeshContainerViaWorker, buildStlContainer, MESH_IMPORT_TIMEOUT_MS };
