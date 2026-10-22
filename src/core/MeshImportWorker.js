// Main-thread side of the STL / 3MF import worker (heavy-mesh spec §7.3).
// workers/MeshImport.worker.js reads the blob URL, parses and welds off the UI
// thread and transfers typed arrays back; this module turns them into an
// AssetContainer through the same builders the `.stl` / `.3mf` SceneLoader
// plugins use (import/StlLoader.js, ThreeMFLoader.js), so a worker import and
// the main-thread fallback give identical geometry. Not available under Node
// (no Worker) — callers fall back to the plugins.

import { WorkerTask } from './workers/WorkerTask.js';
import { buildThreeMFContainerFromParsed } from './ThreeMFLoader.js';
import { buildStlContainer } from './import/StlLoader.js';
import { caps } from './storage/capabilities.js';

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

export { buildStlContainer };
export const MeshImportWorker = { isMeshWorkerImport, loadMeshContainerViaWorker, buildStlContainer, MESH_IMPORT_TIMEOUT_MS };
