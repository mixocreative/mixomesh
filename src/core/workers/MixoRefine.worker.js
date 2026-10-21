import { refineTopology, refineTopologyParts } from '../refinement/Topology.js';
import { serveTask, transferable } from './serveTask.js';

serveTask(({ kind, level, geometry }, { progress }) => {
  if (!['refine', 'refine-parts'].includes(kind)) throw new Error('invalid refinement job');
  const options = { onProgress: ({ phase, completed, total }) => progress({ phase, completed, total }) };
  const result = kind === 'refine-parts' ? refineTopologyParts(geometry, level, options) : refineTopology(geometry, level, options);
  progress({ phase: 'Validating', completed: 1, total: 1 });
  const parts = Array.isArray(result) ? result : [result];
  const buffers = parts.flatMap(part => [part.positions.buffer, part.indices.buffer, ...(part.normals ? [part.normals.buffer] : []), ...(part.uvs ? [part.uvs.buffer] : [])]);
  return transferable(Array.isArray(result) ? { geometries: result } : { geometry: result }, buffers);
});
