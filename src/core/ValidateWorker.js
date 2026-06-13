// Main-thread client for workers/MeshValidate.worker.js (perf goal
// 2026-06-13). Posts a copy of a mesh's positions/indices to the worker and
// resolves { badEdgeCount, inverted } — keeping the ~hundreds-of-ms topology
// pass off the UI thread for heavy print models.
//
// Strictly an enhancement: if Worker is unavailable (Node tests) the caller
// runs the inline fallback in MeshValidator. A worker crash rejects all
// in-flight requests and drops the worker; the next call respawns.

let _worker = null;
let _seq = 0;
const _pending = new Map();   // id → { resolve, reject }

export function isValidateWorkerSupported() {
  return typeof Worker === 'function';
}

function _ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./workers/MeshValidate.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const msg = e.data;
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    if (msg.type === 'done') p.resolve({ badEdgeCount: msg.badEdgeCount, inverted: msg.inverted });
    else p.reject(new Error(msg.message ?? 'validation worker failed'));
  };
  _worker.onerror = (err) => {
    const reason = new Error(err?.message ?? 'validation worker error');
    for (const p of _pending.values()) p.reject(reason);
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
 * @returns {Promise<{ badEdgeCount: number, inverted: boolean }>}
 */
export function validateTopologyInWorker(positions, indices) {
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject });
    // COPY into fresh buffers before transferring — getVerticesData/getIndices
    // may hand back the mesh's live arrays, and transferring those would
    // detach the geometry from the GPU/CPU mirror. Copies are cheap (~3 MB
    // for an 80k-tri mesh) next to the topology pass they unblock.
    const pos = positions instanceof Float32Array ? positions.slice() : Float32Array.from(positions);
    const idx = indices instanceof Uint32Array ? indices.slice() : Uint32Array.from(indices);
    _ensureWorker().postMessage(
      { id, positions: pos, indices: idx },
      [pos.buffer, idx.buffer],
    );
  });
}
