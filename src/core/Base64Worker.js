// Main-thread side of off-thread base64 encoding (audit #3). Moves the
// synchronous btoa of large asset bytes off the main thread on manual save /
// explicit .mixo embed, so a heavy single asset no longer freezes the UI
// (~400 ms for 100 MB measured). Strictly an enhancement: when Worker is
// unavailable (headless tests) or the worker errors, it falls back to the SAME
// shared sync codec, so the encoded bytes are byte-identical either way.
//
// The worker path is exercised end-to-end by the browser smoke (its
// `_buildDocument` → `_loadProject` round-trips embed + decode asset bytes in
// real Chrome); headless tests always take the sync fallback (no Worker).

import { encodeBase64 } from './workers/base64Codec.js';

let _worker = null;
let _seq = 0;
const _pending = new Map();   // id → { resolve, reject }

export function isBase64WorkerSupported() {
  return typeof Worker === 'function';
}

function _ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./workers/Base64.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const { id, b64, error } = e.data ?? {};
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(b64);
  };
  _worker.onerror = (err) => {
    // Wholesale failure (bundle failed to load/execute). Reject all in-flight
    // requests and drop the worker — each caller then falls back to sync, and
    // the next encode retries a fresh spawn.
    const reason = new Error(err?.message ?? 'base64 worker error');
    for (const p of _pending.values()) p.reject(reason);
    _pending.clear();
    try { _worker.terminate(); } catch { /* already dead */ }
    _worker = null;
  };
  return _worker;
}

/**
 * Base64-encode an asset's bytes, off the main thread when possible.
 * COPIES the bytes and transfers the copy, so the caller's (possibly live)
 * buffer is never detached. Any worker problem falls back to the sync codec —
 * the result is byte-identical to the sync path by construction.
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {Promise<string>} standard base64
 */
export async function encodeBase64Async(buf) {
  if (!isBase64WorkerSupported()) return encodeBase64(buf);
  try {
    // Own, transferable copy — never detach the source bytes.
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const copy = u8.slice().buffer;
    return await new Promise((resolve, reject) => {
      const id = ++_seq;
      _pending.set(id, { resolve, reject });
      _ensureWorker().postMessage({ id, buffer: copy }, [copy]);
    });
  } catch {
    return encodeBase64(buf);   // worker spawn/post/exec failure → safe sync path
  }
}

export const Base64Worker = { isBase64WorkerSupported, encodeBase64Async };
