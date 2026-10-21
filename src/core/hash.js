import { WorkerTask } from './workers/WorkerTask.js';
import { hexOfDigest } from './hashHex.js';

/** Blobs at least this big are hashed in a worker (heavy-mesh spec §4). */
export const WORKER_HASH_MIN_BYTES = 8 * 1024 * 1024;

const _task = new WorkerTask({
  name: 'file hash',
  label: 'job.hashFile',
  mode: 'per-job',
  timeoutMs: 300_000,
  create: typeof Worker === 'function'
    ? () => new Worker(new URL('./workers/Hash.worker.js', import.meta.url), { type: 'module' })
    : null,
});

/**
 * sha256 hex of an ArrayBuffer — the §10b texture/asset identity scope.
 * Shared by AssetLoader (import-time contentHash) and PersistenceManager
 * (embed hashing + directory hash-scan resolve).
 */
export async function sha256Hex(buf) {
  return hexOfDigest(await crypto.subtle.digest('SHA-256', buf));
}

/**
 * sha256 hex of a Blob/File. Big blobs are read and hashed in a worker, so the
 * UI thread never copies the bytes; small ones (and runtimes without Worker)
 * hash inline. Same digest either way.
 * @param {Blob} blob
 */
export async function sha256HexOfBlob(blob) {
  if (blob?.size >= WORKER_HASH_MIN_BYTES && typeof Worker === 'function') {
    try { return await _task.run({ blob }); }
    catch (err) { if (err?.name === 'AbortError') throw err; /* inline below */ }
  }
  return sha256Hex(await blob.arrayBuffer());
}
