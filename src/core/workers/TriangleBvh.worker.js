// Pick-index builder (heavy-mesh spec §7.5): a flat BVH over a heavy mesh's
// triangles, built off the UI thread from a transferred local-space copy and
// transferred back. The copy is dropped when the job settles.
import { buildTriangleBvh } from '../geometry/triangleBvh.js';
import { serveTask, transferable } from './serveTask.js';

serveTask(({ positions, indices }, { progress }) => {
  progress({ stage: 'build', fraction: 0 });
  const bvh = buildTriangleBvh(positions, indices, { onProgress: (fraction) => progress({ stage: 'build', fraction }) });
  return transferable(bvh, [bvh.bounds.buffer, bvh.data.buffer, bvh.tris.buffer]);
});
