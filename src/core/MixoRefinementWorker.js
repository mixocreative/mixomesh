import { WorkerTask } from './workers/WorkerTask.js';

const DEFAULT_TIMEOUT_MS = 120_000;
let nextJobId = 0;

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

// A fresh worker per job, terminated when it settles (WorkerTask 'per-job'):
// refinement jobs are large and rare, so nothing is kept warm. The geometry
// revision rides along as the stale guard.
const _task = new WorkerTask({
  name: 'refinement worker',
  label: 'job.refine',
  mode: 'per-job',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  create: typeof Worker === 'function'
    ? () => new Worker(new URL('./workers/MixoRefine.worker.js', import.meta.url), { type: 'module' })
    : null,
});

/** Start one isolated worker job; never transfer or mutate source mesh arrays. */
async function runWorker(input, level, { signal, sourceRevision = 0, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, multiple = false) {
  if (typeof Worker !== 'function') throw new Error('Mixo refinement requires a Web Worker');
  if (signal?.aborted) throw new DOMException('Refinement aborted', 'AbortError');
  if (![0,1,2].includes(level) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new Error('invalid refinement request');
  const jobId = ++nextJobId;
  const geometry = multiple ? input.map(copiedGeometry) : copiedGeometry(input);
  const buffers = (multiple ? geometry : [geometry]).flatMap(part => Object.values(part).map(value => value.buffer));
  let result;
  try {
    result = await _task.run({ kind: multiple ? 'refine-parts' : 'refine', level, geometry }, {
      transfer: buffers, signal, timeoutMs, revision: sourceRevision,
      onProgress: ({ phase, completed, total }) => {
        if (typeof phase !== 'string' || !Number.isSafeInteger(completed) || !Number.isSafeInteger(total)
          || completed < 0 || total < 1 || completed > total) throw new Error('invalid refinement progress');
        onProgress?.({ phase, completed, total, jobId, sourceRevision });
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new DOMException('Refinement aborted', 'AbortError');
    if (error?.code === 'stale') throw new Error('stale refinement worker result');
    throw error;
  }
  if (multiple) {
    if (!Array.isArray(result?.geometries) || result.geometries.length !== input.length) throw new Error('invalid refinement material result count');
    return { jobId, sourceRevision, geometries: result.geometries.map((g, i) => validateRefinedGeometry(g, input[i], level)) };
  }
  return { jobId, sourceRevision, geometry: validateRefinedGeometry(result?.geometry, input, level) };
}

export function refineInWorker(input, level, options = {}) { return runWorker(input, level, options); }

/** Refine material siblings together so their common edges use one topology. */
export function refinePartsInWorker(inputs, level, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return Promise.reject(new Error('refinement material parts are empty'));
  return runWorker(inputs, level, options, true);
}
