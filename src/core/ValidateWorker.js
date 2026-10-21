// Main-thread client for workers/MeshValidate.worker.js (perf goal
// 2026-06-13). Posts a copy of a mesh's positions/indices to the worker and
// resolves { badEdgeCount, inverted } — keeping the ~hundreds-of-ms topology
// pass off the UI thread for heavy print models.
//
// Strictly an enhancement: if Worker is unavailable (Node tests) the caller
// runs the inline fallback in MeshValidator. A worker crash rejects all
// in-flight requests and drops the worker; the next call respawns.

import { WorkerTask } from './workers/WorkerTask.js';

export const DEFAULT_VALIDATE_TIMEOUT_MS = 120_000;   // Decision 19 / task 6.4

let _timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS;

/** Test seam: override the per-request timeout (ms). Returns the previous value. */
export function setValidateWorkerTimeout(ms) {
  const prev = _timeoutMs;
  _timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_VALIDATE_TIMEOUT_MS;
  return prev;
}

export function isValidateWorkerSupported() {
  return typeof Worker === 'function';
}

// One persistent worker; a hung or crashed worker is terminated and the next
// request respawns it (WorkerTask). Callers fall back inline on rejection.
const _task = new WorkerTask({
  name: 'validation worker',
  create: () => new Worker(new URL('./workers/MeshValidate.worker.js', import.meta.url), { type: 'module' }),
});

/**
 * Run topology checks in the worker.
 * @param {Float32Array} positions  vertex positions (xyz triples)
 * @param {Uint32Array|Int32Array|number[]} indices
 * @param {boolean} [clockwise=false]  effective front-face winding of the mesh
 *   (PrintSpace.frontFaceIsClockwise) — decides which signed-volume sign is
 *   "inverted". Computed on the main thread; the worker stays Babylon-free.
 * @returns {Promise<{ badEdgeCount: number, inverted: boolean }>}
 */
export async function validateTopologyInWorker(positions, indices, clockwise = false) {
  // COPY into fresh buffers before transferring — getVerticesData/getIndices
  // may hand back the mesh's live arrays, and transferring those would
  // detach the geometry from the GPU/CPU mirror.
  const pos = positions instanceof Float32Array ? positions.slice() : Float32Array.from(positions);
  const idx = indices instanceof Uint32Array ? indices.slice() : Uint32Array.from(indices);
  try {
    return await _task.run(
      { positions: pos, indices: idx, clockwise: !!clockwise },
      { transfer: [pos.buffer, idx.buffer], timeoutMs: _timeoutMs },
    );
  } catch (err) {
    if (err?.code === 'timeout') {
      console.warn(`[validate] worker did not answer within ${_timeoutMs} ms — terminating it; validating inline`);
    }
    throw err;
  }
}
