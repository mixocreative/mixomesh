/**
 * Binary STL serializer (little-endian: 80-byte header, uint32 LE triangle
 * count, 50 bytes per facet — 12 LE float32 (normal, v1, v2, v3) + uint16
 * attribute byte count = 0).
 *
 * Replaces BABYLON.STLExport.CreateSTL, which (a) was being called with
 * isLittleEndian=false so every consumer read a garbage triangle count, and
 * (b) applies its own Y/Z swap instead of the shared PrintSpace map, so STL,
 * OBJ and 3MF disagreed on orientation. Geometry goes through PrintSpace like
 * every other writer; nothing here knows about handedness.
 */

import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { positionsToPrintSpace, printIndices } from './PrintSpace.js';
import { WorkerTask } from '../workers/WorkerTask.js';
import { encodeBinarySTLFromArrays } from './stlEncode.js';

export { encodeBinarySTLFromArrays };

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

/** Exports at or above this many triangles encode in a worker (UI stays live). */
export const STL_WORKER_TRIANGLES = 200_000;

/** Pure: should this STL encode run in the worker? */
export function shouldEncodeStlInWorker(triangles, workerAvailable) {
  return !!workerAvailable && triangles >= STL_WORKER_TRIANGLES;
}

/** Mesh entries → print-space parts (positions mapped, indices in print winding). */
function _partsOf(meshEntries) {
  const parts = [];
  for (const { mesh } of meshEntries) {
    const raw = mesh.getVerticesData?.('position');
    const idx = printIndices(mesh);
    if (!raw || !idx.length) continue;
    parts.push({ name: mesh.name ?? '?', positions: positionsToPrintSpace(raw), indices: idx });
  }
  return parts;
}

/**
 * Encode a list of meshes as one binary STL.
 * @param {Array<{mesh:object}>} meshEntries
 * @param {string} [solidName]  written into the 80-byte header (ASCII, truncated)
 * @returns {Uint8Array}
 */
export function encodeBinarySTL(meshEntries, solidName = 'mixomesh') {
  return encodeBinarySTLFromArrays(_partsOf(meshEntries), solidName);
}

/** Worker timeout for one STL job: 60 s plus 10 s per million triangles. */
export function stlWorkerTimeoutFor(triangles) {
  return 60_000 + Math.ceil(triangles / 100_000) * 1_000;
}

// Large exports: encode in a worker. Parts are transferred (they are fresh
// print-space copies), the encoded bytes come back transferred.
const _stlTask = new WorkerTask({
  name: 'STL encoder',
  label: 'job.exportStl',
  create: typeof Worker === 'function'
    ? () => new Worker(new URL('../workers/StlEncode.worker.js', import.meta.url), { type: 'module' })
    : null,
});

/** Encode, in the STL worker when the job is large (bytes identical to encodeBinarySTL). */
export async function encodeBinarySTLAsync(meshEntries, solidName = 'mixomesh') {
  const parts = _partsOf(meshEntries);   // fresh print-space copies (typed), safe to transfer
  const triangles = parts.reduce((n, p) => n + Math.floor(p.indices.length / 3), 0);
  if (!shouldEncodeStlInWorker(triangles, typeof Worker === 'function')) return encodeBinarySTLFromArrays(parts, solidName);
  try {
    return await _stlTask.run({ parts, solidName }, {
      transfer: parts.flatMap(p => [p.positions.buffer, p.indices.buffer]),
      timeoutMs: stlWorkerTimeoutFor(triangles),
    });
  } catch (err) {
    if (/index out of range/.test(err?.message ?? '')) throw err;
    return encodeBinarySTL(meshEntries, solidName);   // worker unavailable/crashed: same bytes inline
  }
}

/**
 * Pipeline serializer: combined STL blob, or one STL per logical unit in a zip.
 * @param {ExportContext} ctx
 */
export async function serializeSTL(ctx) {
  if (ctx.individually) {
    const entries = [];
    for (const unit of ctx.cloneGroups) {
      const base = perMeshBaseName(ctx, unit.name);
      entries.push({ path: `${base}.stl`, data: await encodeBinarySTLAsync(unit.meshes, base) });
    }
    return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
  }
  const base = exportBaseName(ctx);
  return { kind: 'blob', mime: 'model/stl', filename: `${base}.stl`, data: await encodeBinarySTLAsync(ctx.meshes, base) };
}
