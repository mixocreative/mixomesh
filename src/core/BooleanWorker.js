// Main-thread client for workers/Boolean.worker.js. One persistent worker
// (Manifold's WASM stays warm between Booleans); a crash or timeout respawns
// it on the next call (WorkerTask).

import { WorkerTask } from './workers/WorkerTask.js';
import { vendorUrl, MANIFOLD_VENDOR_DIR } from './vendorUrl.js';

export const BOOLEAN_WORKER_TIMEOUT_MS = 300_000;

const _task = new WorkerTask({
  name: 'Boolean worker',
  timeoutMs: BOOLEAN_WORKER_TIMEOUT_MS,
  create: typeof Worker === 'function'
    ? () => new Worker(new URL('./workers/Boolean.worker.js', import.meta.url), { type: 'module' })
    : null,
});

export function isBooleanWorkerSupported() {
  return typeof Worker === 'function';
}

/**
 * @param {'union'|'subtract'|'intersect'} op
 * @param {Array<{positions: Float32Array, indices: Uint32Array, normals?: Float32Array|null, matrix: number[]}>} operands
 *   mesh-local arrays the caller OWNS (they are transferred) + world matrix
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ positions: Float32Array, normals: Float32Array|null, indices: Uint32Array }>}
 */
export function runBooleanInWorker(op, operands, { signal } = {}) {
  const transfer = operands.flatMap(o => [o.positions.buffer, o.indices.buffer, ...(o.normals ? [o.normals.buffer] : [])]);
  return _task.run(
    { op, operands, manifoldUrl: vendorUrl(`${MANIFOLD_VENDOR_DIR}/manifold.js`) },
    { transfer, signal },
  );
}
