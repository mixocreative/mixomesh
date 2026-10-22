// Blob URL → AssetContainer, worker first. STL and 3MF parse + weld in
// workers/MeshImport.worker.js and OBJ in workers/ObjParse.worker.js when
// Worker exists; a worker failure on a small file falls back to the
// main-thread SceneLoader path, where the `.stl` / `.3mf` plugins run the
// same parse cores (and the installed PreprocessUrl sibling swap still covers
// OBJ); a big file, a timeout or Cancel never does.

import { OVER_BUDGET } from '../import/ImportLimits.js';
import { isWorkerImportSupported, loadObjContainerViaWorker } from '../WorkerImport.js';
import { isMeshWorkerImport, loadMeshContainerViaWorker } from '../MeshImportWorker.js';
// Side-effects: register the `.3mf` and `.stl` SceneLoader plugins so the
// LoadAssetContainer fallback (and project restore) runs the worker's cores.
import '../ThreeMFLoader.js';
import '../import/StlLoader.js';
import '../import/MixoPrimitiveExtras.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

/** Above this size a failed worker parse is NOT retried on the main thread:
 *  the files that time out or crash a worker are exactly the ones that would
 *  freeze or kill the tab there (audit area 2c). */
export const MAIN_THREAD_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;

/** Worker failures the main thread must not retry: it would freeze or refuse too. */
const NO_RETRY_CODES = new Set(['timeout', OVER_BUDGET]);

/** Worker failure → may the main-thread SceneLoader retry it? */
export function mayFallBackToMainThread(err, size) {
  if (err?.name === 'AbortError') return false;
  if (NO_RETRY_CODES.has(err?.code)) return false;
  return !(size > MAIN_THREAD_FALLBACK_MAX_BYTES);
}

/**
 * Load an AssetContainer from a blob URL (NOT yet added to the scene).
 * @param {string} blobUrl
 * @param {string} ext
 * @param {BABYLON.Scene} scene
 * @param {Function|null} onProgress  receives `{ stage, fraction? }`
 * @param {Map<string,string>|null} siblings
 * @param {{ signal?: AbortSignal, size?: number }} [opts]
 *   `signal`: the import's own signal, which also files the worker job under
 *   the import's blocking job (one progress surface).
 */
export async function loadContainer(blobUrl, ext, scene, onProgress, siblings, opts = {}) {
  const { signal, size } = opts;
  if (isMeshWorkerImport(ext)) {
    try {
      return await loadMeshContainerViaWorker(scene, blobUrl, ext, { onProgress: onProgress ?? undefined, signal });
    } catch (err) {
      if (!mayFallBackToMainThread(err, size)) throw err;
      console.warn(`${ext} worker parse failed — main-thread fallback:`, err);
    }
  } else if (ext === '.obj' && isWorkerImportSupported()) {
    try {
      return await loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress ?? undefined, { signal });
    } catch (err) {
      if (!mayFallBackToMainThread(err, size)) throw err;
      console.warn('OBJ worker parse failed — main-thread fallback:', err);
    }
  }
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  // Babylon reports { loaded, total }; every other producer speaks { stage, fraction }.
  const babylonProgress = onProgress && ((evt) => onProgress(evt?.lengthComputable && evt.total > 0
    ? { stage: 'read', fraction: evt.loaded / evt.total }
    : { stage: 'read' }));
  return BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, babylonProgress ?? null, ext);
}
