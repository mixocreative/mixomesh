const DEFAULT_TIMEOUT_MS = 120_000;
let nextJobId = 0;
const pending = new Map();

function copiedGeometry(input) {
  return {
    positions: input.positions.slice(), indices: input.indices.slice(),
    ...(input.normals ? { normals: input.normals.slice() } : {}),
    ...(input.uvs ? { uvs: input.uvs.slice() } : {}),
    ...(input.creaseByVertex ? { creaseByVertex: input.creaseByVertex.slice() } : {}),
    ...(input.sharpEdges ? { sharpEdges: input.sharpEdges.slice() } : {}),
  };
}

/** Reject malformed worker geometry before any Babylon mesh is constructed. */
export function validateRefinedGeometry(geometry, input, level) {
  const { positions, indices, normals, uvs } = geometry ?? {};
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3
    || !(indices instanceof Uint32Array) || indices.length !== input.indices.length * 4 ** level
    || !(normals instanceof Float32Array) || normals.length !== positions.length
    || (!!input.uvs !== !!uvs) || (uvs && (!(uvs instanceof Float32Array) || uvs.length !== positions.length / 3 * 2))) {
    throw new Error('invalid refinement geometry arrays');
  }
  for (const array of [positions, normals, uvs]) if (array) for (const value of array) if (!Number.isFinite(value)) throw new Error('invalid refinement geometry: nonfinite attribute');
  for (const index of indices) if (index >= positions.length / 3) throw new Error('invalid refinement geometry index');
  return geometry;
}

/** Start one isolated worker job; never transfer or mutate source mesh arrays. */
function runWorker(input, level, { signal, sourceRevision = 0, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, multiple = false) {
  if (typeof Worker !== 'function') return Promise.reject(new Error('Mixo refinement requires a Web Worker'));
  if (signal?.aborted) return Promise.reject(new DOMException('Refinement aborted', 'AbortError'));
  if (![0,1,2].includes(level) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) return Promise.reject(new Error('invalid refinement request'));
  const jobId = ++nextJobId;
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./workers/MixoRefine.worker.js', import.meta.url), { type: 'module' }); }
    catch (error) { reject(error); return; }
    const cleanup = () => {
      const job = pending.get(jobId);
      if (!job) return false;
      pending.delete(jobId);
      clearTimeout(job.timer);
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null;
      worker.terminate();
      return true;
    };
    const fail = error => { if (cleanup()) reject(error); };
    const abort = () => fail(new DOMException('Refinement aborted', 'AbortError'));
    const timer = setTimeout(() => fail(new Error(`refinement worker timed out after ${timeoutMs} ms`)), timeoutMs);
    pending.set(jobId, { timer });
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => fail(new Error(event?.message ?? 'refinement worker error'));
    worker.onmessage = event => {
      const message = event.data;
      if (!pending.has(jobId) || !message || message.jobId !== jobId) return;
      if (message.sourceRevision !== sourceRevision) { fail(new Error('stale refinement worker result')); return; }
      if (message.type === 'progress') {
        if (typeof message.phase !== 'string' || !Number.isSafeInteger(message.completed) || !Number.isSafeInteger(message.total)
          || message.completed < 0 || message.total < 1 || message.completed > message.total) { fail(new Error('invalid refinement progress')); return; }
        try { onProgress?.({ phase: message.phase, completed: message.completed, total: message.total, jobId, sourceRevision }); }
        catch (error) { fail(error); }
      } else if (message.type === 'done') {
        try {
          if (multiple) {
            if (!Array.isArray(message.geometries) || message.geometries.length !== input.length) throw new Error('invalid refinement material result count');
            const geometries = message.geometries.map((geometry, i) => validateRefinedGeometry(geometry, input[i], level));
            if (cleanup()) resolve({ jobId, sourceRevision, geometries });
          } else {
            const geometry = validateRefinedGeometry(message.geometry, input, level);
            if (cleanup()) resolve({ jobId, sourceRevision, geometry });
          }
        } catch (error) { fail(error); }
      } else if (message.type === 'error') fail(new Error(message.message || 'refinement worker failed'));
      else fail(new Error('invalid refinement worker message'));
    };
    try {
      const geometry = multiple ? input.map(copiedGeometry) : copiedGeometry(input);
      const buffers = (multiple ? geometry : [geometry]).flatMap(part => Object.values(part).map(value => value.buffer));
      worker.postMessage({ type: multiple ? 'refine-parts' : 'refine', jobId, sourceRevision, level, geometry }, buffers);
    } catch (error) { fail(error); }
  });
}

export function refineInWorker(input, level, options = {}) { return runWorker(input, level, options); }

/** Refine material siblings together so their common edges use one topology. */
export function refinePartsInWorker(inputs, level, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return Promise.reject(new Error('refinement material parts are empty'));
  return runWorker(inputs, level, options, true);
}
