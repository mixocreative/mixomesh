// An import's lifetime: its blocking job in JobActivity, its cancel scope,
// and the batch a multi-file drop runs in.
//
// An import changes the scene the user is editing, so it is a BLOCKING job
// (heavy-mesh spec §5.4): the overlay (ui/ProgressOverlay.js) renders it with
// Cancel, which aborts every running import (nothing half-added) AND the rest
// of a multi-file drop (beginImportBatch). The import's worker steps (hash,
// parse, weld) run on the import's own signal, so the registry files them
// under the import instead of the activity panel: one progress surface, by
// construction.

import { beginJob, isRunning } from '../workers/JobActivity.js';

const IMPORT_JOB = 'job.importModel';
const _importAborts = new Set();

function _cancelImports() {
  for (const a of [..._importAborts]) a.abort();
}

/**
 * A multi-file import (drop, pick, open) is one batch with one cancel: the
 * overlay's Cancel, the caller's `signal`, or any file's AbortError (e.g. its
 * hash cancelled in the activity panel) ends the running file and every file
 * after it.
 * @param {{ signal?: AbortSignal }} [opts]  the caller's cancel (API request)
 * @returns {{ signal: AbortSignal, run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>, end(): void }}
 *   pass `signal` to each file's import inside `run`; call `end()` in finally
 */
export function beginImportBatch({ signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  _importAborts.add(controller);
  return {
    signal: controller.signal,
    async run(fn) {
      try { return await fn(controller.signal); }
      catch (err) { if (err?.name === 'AbortError') abort(); throw err; }
    },
    end() {
      _importAborts.delete(controller);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/** An AbortController that also fires when the caller's `signal` does. */
export function linkedAbort(signal) {
  const abort = new AbortController();
  const relay = () => abort.abort();
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) abort.abort();
  abort.unlink = () => signal?.removeEventListener('abort', relay);
  return abort;
}

/**
 * Start one import's blocking job; Cancel in the overlay aborts every import.
 * Call it BEFORE the import's first await (F20): Open/New started in that
 * window must see the import in flight.
 * @param {string} filename  shown by the overlay
 * @param {AbortController} abort  from `linkedAbort`
 */
export function beginImport(filename, abort) {
  _importAborts.add(abort);
  const job = beginJob({ label: IMPORT_JOB, detail: filename, blocking: true, signal: abort.signal, cancel: _cancelImports });
  job.progress({ stage: 'read', fraction: 0.02 });
  return job;
}

/** Parse progress (`{ stage, fraction? }`) fills the first three quarters of the overlay bar. */
export function importProgress(job) {
  return (evt) => job.progress({
    stage: evt?.stage ?? 'read',
    fraction: Number.isFinite(evt?.fraction) ? 0.02 + 0.73 * Math.min(1, evt.fraction) : 0.4,
  });
}

export function endImport(job, abort) {
  _importAborts.delete(abort);
  abort.unlink();
  job.end();
}

/** Dispose a loaded container and throw AbortError when the import was cancelled meanwhile. */
export function throwIfAborted(signal, container) {
  if (!signal?.aborted) return;
  try { container?.dispose?.(); } catch { /* not scene-owned */ }
  throw new DOMException('Import cancelled', 'AbortError');
}

/** True while any import (dedupe hash, loadFromBlob, instantiateAsset) is in flight (F20 / M2). */
export function isImporting() {
  return isRunning(IMPORT_JOB);
}
