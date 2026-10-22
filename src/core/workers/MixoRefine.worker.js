import { refineTopology, refineTopologyParts } from '../refinement/Topology.js';
import { serveTask, transferable } from './serveTask.js';

// Topology reports its phases by display name; the wire carries stage keys.
const STAGE_OF_PHASE = { 'Reading topology': 'reading', Refining: 'refining' };

serveTask(({ kind, level, geometry }, { progress }) => {
  if (!['refine', 'refine-parts'].includes(kind)) throw new Error('invalid refinement job');
  const options = {
    onProgress: ({ phase, completed, total }) => progress({ stage: STAGE_OF_PHASE[phase] ?? phase, fraction: total > 0 ? completed / total : 0 }),
  };
  const result = kind === 'refine-parts' ? refineTopologyParts(geometry, level, options) : refineTopology(geometry, level, options);
  progress({ stage: 'validating', fraction: 1 });
  const parts = Array.isArray(result) ? result : [result];
  const buffers = parts.flatMap(part => [part.positions.buffer, part.indices.buffer, ...(part.normals ? [part.normals.buffer] : []), ...(part.uvs ? [part.uvs.buffer] : [])]);
  return transferable(Array.isArray(result) ? { geometries: result } : { geometry: result }, buffers);
});
