import { refineTopology, refineTopologyParts } from '../refinement/Topology.js';

self.onmessage = event => {
  const { type, jobId, sourceRevision, level, geometry } = event.data ?? {};
  if (!['refine', 'refine-parts'].includes(type) || !Number.isSafeInteger(jobId) || !Number.isSafeInteger(sourceRevision)) return;
  try {
    const options = {
      onProgress: ({ phase, completed, total }) => self.postMessage({ type: 'progress', jobId, sourceRevision, phase, completed, total }),
    };
    const result = type === 'refine-parts' ? refineTopologyParts(geometry, level, options) : refineTopology(geometry, level, options);
    self.postMessage({ type: 'progress', jobId, sourceRevision, phase: 'Validating', completed: 1, total: 1 });
    const parts = Array.isArray(result) ? result : [result];
    const buffers = parts.flatMap(part => [part.positions.buffer, part.indices.buffer, ...(part.normals ? [part.normals.buffer] : []), ...(part.uvs ? [part.uvs.buffer] : [])]);
    self.postMessage({ type: 'done', jobId, sourceRevision, ...(Array.isArray(result) ? { geometries: result } : { geometry: result }) }, buffers);
  } catch (error) {
    self.postMessage({ type: 'error', jobId, sourceRevision, message: error?.message ?? String(error) });
  }
};
