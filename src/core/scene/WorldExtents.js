// True world-space extents: every vertex through the mesh's world matrix.
//
// Babylon's boundingBox.minimumWorld/maximumWorld is the world box of the
// rotated LOCAL box, which overstates any rotated object (L2-04: a scan at
// 30° read 176×132 mm, its vertices span 157×97 mm). Displayed sizes use this
// module instead.
//
// A full vertex pass is O(vertices), so the result is cached per mesh, keyed
// on the geometry, its revision and the matrix's linear (rotation/scale)
// part. Translation is added after, so moving an object never re-walks it.

import { revisionOf } from '../geometry/GeometryStore.js';

const _cache = new WeakMap();   // mesh → { key, lo, hi } in world axes, without translation

function _key(mesh, m) {
  const g = mesh.geometry;
  return `${g?.uniqueId}:${revisionOf(mesh)}:${mesh.getTotalVertices()}:${m[0]},${m[1]},${m[2]},${m[4]},${m[5]},${m[6]},${m[8]},${m[9]},${m[10]}`;
}

function _linearExtents(positions, m) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z;
    const wy = m[1] * x + m[5] * y + m[9] * z;
    const wz = m[2] * x + m[6] * y + m[10] * z;
    if (wx < lo[0]) lo[0] = wx; if (wx > hi[0]) hi[0] = wx;
    if (wy < lo[1]) lo[1] = wy; if (wy > hi[1]) hi[1] = wy;
    if (wz < lo[2]) lo[2] = wz; if (wz > hi[2]) hi[2] = wz;
  }
  return { lo, hi };
}

/**
 * World-space min/max of one mesh's vertices, or null when it has none.
 * @returns {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}|null}
 */
export function worldExtentsOf(mesh) {
  if (!(mesh?.getTotalVertices?.() > 0)) return null;
  const m = mesh.computeWorldMatrix(true).m;
  const key = _key(mesh, m);
  let hit = _cache.get(mesh);
  if (hit?.key !== key) {
    const positions = mesh.getVerticesData('position');
    if (!positions?.length) return null;
    hit = { key, ..._linearExtents(positions, m) };
    _cache.set(mesh, hit);
  }
  const { lo, hi } = hit;
  return {
    min: { x: lo[0] + m[12], y: lo[1] + m[13], z: lo[2] + m[14] },
    max: { x: hi[0] + m[12], y: hi[1] + m[13], z: hi[2] + m[14] },
  };
}

/**
 * Size (Babylon units, X/Y/Z = width/height/depth) of the union of the
 * meshes' true world extents, or null when none has vertices.
 * @param {Iterable<any>} meshes
 * @returns {{x:number, y:number, z:number}|null}
 */
export function worldSizeOf(meshes) {
  let min = null, max = null;
  for (const mesh of meshes) {
    const e = worldExtentsOf(mesh);
    if (!e) continue;
    if (!min) { min = { ...e.min }; max = { ...e.max }; continue; }
    for (const a of ['x', 'y', 'z']) {
      if (e.min[a] < min[a]) min[a] = e.min[a];
      if (e.max[a] > max[a]) max[a] = e.max[a];
    }
  }
  return min ? { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } : null;
}

/** A node and every mesh under it (a group node, or a multi-mesh glTF root). */
export function hierarchyMeshes(node) {
  if (!node) return [];
  return [node, ...(node.getChildMeshes?.(false) ?? [])];
}
