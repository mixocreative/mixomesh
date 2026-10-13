// Main-thread client for workers/MeshValidate.worker.js (perf goal
// 2026-06-13). Posts a copy of a mesh's positions/indices to the worker and
// resolves { badEdgeCount, inverted } — keeping the ~hundreds-of-ms topology
// pass off the UI thread for heavy print models.
//
// Strictly an enhancement: if Worker is unavailable (Node tests) the caller
// runs the inline fallback in MeshValidator. A worker crash rejects all
// in-flight requests and drops the worker; the next call respawns.

export const DEFAULT_VALIDATE_TIMEOUT_MS = 120_000;   // Decision 19 / task 6.4

let _worker = null;
let _seq = 0;
let _timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS;
const _pending = new Map();   // id → { resolve, reject, timer }

/** Test seam: override the per-request timeout (ms). Returns the previous value. */
export function setValidateWorkerTimeout(ms) {
  const prev = _timeoutMs;
  _timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_VALIDATE_TIMEOUT_MS;
  return prev;
}

function _settle(id) {
  const p = _pending.get(id);
  if (p) { clearTimeout(p.timer); _pending.delete(id); }
  return p;
}

/** Hung worker: kill it and reject every in-flight request so callers fall back inline. */
function _onTimeout(id) {
  if (!_pending.has(id)) return;
  console.warn(`[validate] worker did not answer within ${_timeoutMs} ms — terminating it; validating inline`);
  const reason = new Error(`validation worker timed out after ${_timeoutMs} ms`);
  for (const p of _pending.values()) { clearTimeout(p.timer); p.reject(reason); }
  _pending.clear();
  try { _worker?.terminate(); } catch { /* already dead */ }
  _worker = null;
}

export function isValidateWorkerSupported() {
  return typeof Worker === 'function';
}

function _ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./workers/MeshValidate.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const msg = e.data;
    const p = _settle(msg.id);
    if (!p) return;
    if (msg.type === 'done') p.resolve({ badEdgeCount: msg.badEdgeCount, inverted: msg.inverted });
    else p.reject(new Error(msg.message ?? 'validation worker failed'));
  };
  _worker.onerror = (err) => {
    const reason = new Error(err?.message ?? 'validation worker error');
    for (const p of _pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    _pending.clear();
    try { _worker.terminate(); } catch { /* already dead */ }
    _worker = null;
  };
  return _worker;
}

/**
 * Run topology checks in the worker.
 * @param {Float32Array} positions  vertex positions (xyz triples)
 * @param {Uint32Array|Int32Array|number[]} indices
 * @param {boolean} [clockwise=false]  effective front-face winding of the mesh
 *   (PrintSpace.frontFaceIsClockwise) — decides which signed-volume sign is
 *   "inverted". Computed on the main thread; the worker stays Babylon-free.
 * @returns {Promise<{ badEdgeCount: number, inverted: boolean }>}
 */
export function validateTopologyInWorker(positions, indices, clockwise = false) {
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    const timer = setTimeout(() => _onTimeout(id), _timeoutMs);
    _pending.set(id, { resolve, reject, timer });
    // COPY into fresh buffers before transferring — getVerticesData/getIndices
    // may hand back the mesh's live arrays, and transferring those would
    // detach the geometry from the GPU/CPU mirror. Copies are cheap (~3 MB
    // for an 80k-tri mesh) next to the topology pass they unblock.
    const pos = positions instanceof Float32Array ? positions.slice() : Float32Array.from(positions);
    const idx = indices instanceof Uint32Array ? indices.slice() : Uint32Array.from(indices);
    try {
      _ensureWorker().postMessage(
        { id, positions: pos, indices: idx, clockwise: !!clockwise },
        [pos.buffer, idx.buffer],
      );
    } catch (err) { _settle(id); reject(err); }
  });
}
