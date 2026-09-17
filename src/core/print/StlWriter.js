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

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

/**
 * Encode a list of meshes as one binary STL.
 * @param {Array<{mesh:object}>} meshEntries
 * @param {string} [solidName]  written into the 80-byte header (ASCII, truncated)
 * @returns {Uint8Array}
 */
export function encodeBinarySTL(meshEntries, solidName = 'mixomesh') {
  const facets = [];
  for (const { mesh } of meshEntries) {
    const raw = mesh.getVerticesData?.('position');
    const idx = printIndices(mesh);
    if (!raw || !idx.length) continue;
    const pos = positionsToPrintSpace(raw);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      if (a + 2 >= pos.length || b + 2 >= pos.length || c + 2 >= pos.length) {
        throw new Error(`StlWriter: triangle index out of range in "${mesh.name ?? '?'}"`);
      }
      facets.push([
        pos[a], pos[a + 1], pos[a + 2],
        pos[b], pos[b + 1], pos[b + 2],
        pos[c], pos[c + 1], pos[c + 2],
      ]);
    }
  }
  const bytes = new Uint8Array(84 + facets.length * 50);
  const view = new DataView(bytes.buffer);
  const header = `mixomesh binary STL ${solidName}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, facets.length, true);
  let o = 84;
  for (const f of facets) {
    const n = _facetNormal(f);
    view.setFloat32(o, n[0], true); view.setFloat32(o + 4, n[1], true); view.setFloat32(o + 8, n[2], true);
    for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, f[k], true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return bytes;
}

function _facetNormal(f) {
  const ux = f[3] - f[0], uy = f[4] - f[1], uz = f[5] - f[2];
  const vx = f[6] - f[0], vy = f[7] - f[1], vz = f[8] - f[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
}

/**
 * Pipeline serializer: combined STL blob, or one STL per logical unit in a zip.
 * @param {ExportContext} ctx
 */
export function serializeSTL(ctx) {
  if (ctx.individually) {
    const entries = [];
    for (const unit of ctx.cloneGroups) {
      const base = perMeshBaseName(ctx, unit.name);
      entries.push({ path: `${base}.stl`, data: encodeBinarySTL(unit.meshes, base) });
    }
    return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
  }
  const base = exportBaseName(ctx);
  return { kind: 'blob', mime: 'model/stl', filename: `${base}.stl`, data: encodeBinarySTL(ctx.meshes, base) };
}
