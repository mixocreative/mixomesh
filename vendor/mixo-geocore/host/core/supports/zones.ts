import type { Vector } from '../vec3';

/** One immutable brush dab. Consumers choose the semantic meaning of `kind`. */
export interface SurfaceStamp<K extends string> {
  center: Vector;
  radius: number;
  normal: Vector;
  kind: K;
}

/** One brush dab of a no-support zone, in unit-local space. */
/** Carries the surface normal under the brush, which keeps the far side of a thin wall out of the zone. */
export type ZoneStamp = SurfaceStamp<'paint' | 'erase'>;

/** A drag lays a new stamp once the brush has moved half a radius from the last one. */
export function nextStamp(last: Vector | undefined, point: Vector, radius: number): boolean {
  if (!last) return true;
  const dx = point[0] - last[0];
  const dy = point[1] - last[1];
  const dz = point[2] - last[2];
  return dx * dx + dy * dy + dz * dz >= (radius / 2) * (radius / 2);
}

/**
 * Extra stamp centers between two consecutive brush hits of a fast stroke, every half radius or
 * closer, so the stroke leaves no gaps. None when the hits are within one radius (they overlap
 * already) or more than six radii apart (a jump across a gap or off and back onto the model).
 */
export function stampsAlong(last: Vector, point: Vector, radius: number): Vector[] {
  const dx = point[0] - last[0];
  const dy = point[1] - last[1];
  const dz = point[2] - last[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance <= radius || distance > 6 * radius) return [];
  const steps = Math.ceil(distance / (radius / 2));
  const centers: Vector[] = [];
  for (let k = 1; k < steps; k++) centers.push([last[0] + (dx * k) / steps, last[1] + (dy * k) / steps, last[2] + (dz * k) / steps]);
  return centers;
}

/**
 * Uniform grid over a vertex list (xyz triples): the vertices of cell `c` are
 * `cellVertices[cellStart[c] .. cellStart[c + 1])`. Build it once per positions array.
 */
export interface VertexGrid {
  cellSize: number;
  min: Vector;
  /** Cells along x, y and z. */
  dims: [number, number, number];
  cellStart: Uint32Array;
  cellVertices: Uint32Array;
}

/**
 * Buckets the vertices into cubes of `cellSize` (about a brush size). When that would need more
 * than `maxCells` cells the cells grow until it does not, which keeps the memory bounded.
 * No grid (undefined) for a non-finite coordinate or a cell size that is not a positive number:
 * the cells could never be sized, so callers visit every vertex instead.
 */
export function buildVertexGrid(positions: Float32Array, cellSize = 2, maxCells = Math.max(1 << 16, Math.min(positions.length, 1 << 22))): VertexGrid | undefined {
  const count = positions.length / 3;
  const min: Vector = [Infinity, Infinity, Infinity];
  const max: Vector = [-Infinity, -Infinity, -Infinity];
  let finite = true;
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!;
      if (!Number.isFinite(value)) finite = false;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  if (!finite || !(cellSize > 0) || !Number.isFinite(cellSize)) return undefined;
  if (count === 0) return { cellSize, min: [0, 0, 0], dims: [1, 1, 1], cellStart: new Uint32Array(2), cellVertices: new Uint32Array(0) };
  const dimsFor = (size: number): [number, number, number] => [0, 1, 2].map((axis) => Math.max(1, Math.floor((max[axis]! - min[axis]!) / size) + 1)) as [number, number, number];
  let dims = dimsFor(cellSize);
  while (dims[0] * dims[1] * dims[2] > maxCells) dims = dimsFor((cellSize *= 1.5));
  const cells = dims[0] * dims[1] * dims[2];
  const cellOf = new Uint32Array(count);
  const cellStart = new Uint32Array(cells + 1);
  for (let v = 0, i = 0; v < count; v++, i += 3) {
    const x = Math.min(dims[0] - 1, Math.floor((positions[i]! - min[0]) / cellSize));
    const y = Math.min(dims[1] - 1, Math.floor((positions[i + 1]! - min[1]) / cellSize));
    const z = Math.min(dims[2] - 1, Math.floor((positions[i + 2]! - min[2]) / cellSize));
    const cell = (z * dims[1] + y) * dims[0] + x;
    cellOf[v] = cell;
    cellStart[cell + 1]!++;
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
  const fill = cellStart.slice(0, cells);
  const cellVertices = new Uint32Array(count);
  for (let v = 0; v < count; v++) cellVertices[fill[cellOf[v]!]!++] = v;
  return { cellSize, min, dims, cellStart, cellVertices };
}

/**
 * Lays one stamp on a vertex list (xyz triples): `out[v]` becomes 1 (paint) or 0 (erase) for every
 * vertex the stamp covers on its side of the surface, as the stamp rule decides (Rust `AreaStamp::resolve`; this is the display copy kept for the brush's per-vertex paint); others keep their value.
 * With a grid of the same positions only the vertices in cells the stamp overlaps are visited.
 */
export function stampVertices(stamp: ZoneStamp, positions: Float32Array, normals: Float32Array, out: Uint8Array, grid?: VertexGrid): Uint8Array {
  const [cx, cy, cz] = stamp.center;
  const [nx, ny, nz] = stamp.normal;
  const value = stamp.kind === 'paint' ? 1 : 0;
  const r2 = stamp.radius * stamp.radius;
  const lay = (v: number) => {
    const i = v * 3;
    const dx = positions[i]! - cx;
    const dy = positions[i + 1]! - cy;
    const dz = positions[i + 2]! - cz;
    if (dx * dx + dy * dy + dz * dz > r2) return;
    if (normals[i]! * nx + normals[i + 1]! * ny + normals[i + 2]! * nz <= 0) return;
    out[v] = value;
  };
  if (!grid) {
    for (let v = 0; v < out.length; v++) lay(v);
    return out;
  }
  const { cellSize, min, dims, cellStart, cellVertices } = grid;
  // Cell range of the stamp's bounding box, clamped to the grid (every vertex lies inside it).
  const range = (axis: number) => {
    const low = Math.floor((stamp.center[axis]! - stamp.radius - min[axis]!) / cellSize);
    const high = Math.floor((stamp.center[axis]! + stamp.radius - min[axis]!) / cellSize);
    return [Math.max(0, low), Math.min(dims[axis]! - 1, high)] as const;
  };
  const [x0, x1] = range(0);
  const [y0, y1] = range(1);
  const [z0, z1] = range(2);
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      const row = (z * dims[1] + y) * dims[0];
      for (let x = x0; x <= x1; x++) {
        for (let k = cellStart[row + x]!, end = cellStart[row + x + 1]!; k < end; k++) lay(cellVertices[k]!);
      }
    }
  }
  return out;
}

/** Per vertex 1 where the stamp rule (see `zonedAt` in supports/zoneCheck) holds for the vertex and its normal, else 0 (`out` is cleared first). */
export function zonedVertices(zones: readonly ZoneStamp[], positions: Float32Array, normals: Float32Array, out: Uint8Array = new Uint8Array(positions.length / 3), grid?: VertexGrid): Uint8Array {
  out.fill(0);
  for (const stamp of zones) stampVertices(stamp, positions, normals, out, grid);
  return out;
}

/** Whether two stamps are the same dab by value (a saved copy of a stamp matches the original). */
export function sameStamp(a: ZoneStamp, b: ZoneStamp): boolean {
  return a === b || (a.kind === b.kind && a.radius === b.radius
    && a.center[0] === b.center[0] && a.center[1] === b.center[1] && a.center[2] === b.center[2]
    && a.normal[0] === b.normal[0] && a.normal[1] === b.normal[1] && a.normal[2] === b.normal[2]);
}
