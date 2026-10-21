// Typed-array welding + crease-aware normals for heavy imports (heavy-mesh
// spec §4). No strings, no per-vertex objects: an open-addressing hash over
// the float bit patterns, and CSR vertex→face adjacency. Pure; runs in
// workers/MeshImport.worker.js and under Node tests.

const PROGRESS_EVERY = 1 << 20;

/** Smallest power of two ≥ n (≥ 1024). */
function pow2(n) {
  let p = 1024;
  while (p < n) p *= 2;
  return p;
}

/**
 * Weld exactly-equal corner positions (−0 and +0 are equal).
 * The input soup is COMPACTED IN PLACE (vertex u is written at slot u ≤ the
 * corner being read, so nothing unread is overwritten); the returned
 * `positions` is a trimmed copy and the input must not be reused.
 * @param {Float32Array} soup  3 floats per corner
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {{ positions: Float32Array, indices: Uint32Array }}
 */
export function weldPositions(soup, { onProgress } = {}) {
  const corners = soup.length / 3;
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length);
  const indices = new Uint32Array(corners);
  let size = pow2(Math.max(16, Math.ceil(corners / 3)));
  let mask = size - 1;
  let table = new Int32Array(size).fill(-1);
  let unique = 0;
  const hashAt = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  const grow = () => {
    size *= 2;
    mask = size - 1;
    table = new Int32Array(size).fill(-1);
    for (let u = 0; u < unique; u++) {
      let h = hashAt(bits[u * 3], bits[u * 3 + 1], bits[u * 3 + 2]) & mask;
      while (table[h] !== -1) h = (h + 1) & mask;
      table[h] = u;
    }
  };
  for (let c = 0; c < corners; c++) {
    let x = bits[c * 3], y = bits[c * 3 + 1], z = bits[c * 3 + 2];
    if (x === 0x80000000) x = 0;
    if (y === 0x80000000) y = 0;
    if (z === 0x80000000) z = 0;
    let h = hashAt(x, y, z) & mask;
    let found = -1;
    for (;;) {
      const u = table[h];
      if (u === -1) break;
      if (bits[u * 3] === x && bits[u * 3 + 1] === y && bits[u * 3 + 2] === z) { found = u; break; }
      h = (h + 1) & mask;
    }
    if (found === -1) {
      found = unique++;
      bits[found * 3] = x; bits[found * 3 + 1] = y; bits[found * 3 + 2] = z;
      table[h] = found;
      if (unique * 2 > size) grow();
    }
    indices[c] = found;
    if (onProgress && (c & (PROGRESS_EVERY - 1)) === 0) onProgress(c / corners);
  }
  table = null;
  return { positions: soup.slice(0, unique * 3), indices };
}

/**
 * Per-vertex normals that stay smooth across gentle curvature but split the
 * vertex where incident faces differ by more than `creaseDeg`, so CAD edges
 * keep flat shading while a smooth scan keeps ~T/2 vertices. Area-weighted.
 * Degenerate (zero-area) faces join the vertex's first group.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {{ creaseDeg?: number, onProgress?: (fraction: number) => void }} [opts]
 * @returns {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array }}
 *   `indices` is the input array, rewritten in place where corners moved to split vertices.
 */
export function creaseNormals(positions, indices, { creaseDeg = 40, onProgress } = {}) {
  const vCount = positions.length / 3;
  const fCount = indices.length / 3;
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  // Area-weighted face normals (length = 2 × area) with Babylon's
  // VertexData.ComputeNormals winding: n = (a − b) × (c − b).
  const fn = new Float32Array(fCount * 3);
  for (let f = 0; f < fCount; f++) {
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    const ux = positions[a] - positions[b], uy = positions[a + 1] - positions[b + 1], uz = positions[a + 2] - positions[b + 2];
    const vx = positions[c] - positions[b], vy = positions[c + 1] - positions[b + 1], vz = positions[c + 2] - positions[b + 2];
    fn[f * 3] = uy * vz - uz * vy;
    fn[f * 3 + 1] = uz * vx - ux * vz;
    fn[f * 3 + 2] = ux * vy - uy * vx;
  }
  onProgress?.(0.2);
  // CSR vertex → incident corners (corner id = 3f + k).
  const start = new Uint32Array(vCount + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < vCount; v++) start[v + 1] += start[v];
  const cornersOf = new Uint32Array(indices.length);
  const fill = start.slice(0, vCount);
  for (let i = 0; i < indices.length; i++) cornersOf[fill[indices[i]]++] = i;
  onProgress?.(0.35);

  // Group ids per corner, relative to the vertex (0 = keeps the original vertex).
  const group = new Uint8Array(indices.length);
  let extra = 0;
  const seeds = [];
  for (let v = 0; v < vCount; v++) {
    seeds.length = 0;
    for (let k = start[v]; k < start[v + 1]; k++) {
      const corner = cornersOf[k];
      const f = (corner / 3) | 0;
      const nx = fn[f * 3], ny = fn[f * 3 + 1], nz = fn[f * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      let g = 0;
      if (len > 0 && seeds.length) {
        g = -1;
        for (let s = 0; s < seeds.length; s++) {
          const sf = seeds[s];
          const sx = fn[sf * 3], sy = fn[sf * 3 + 1], sz = fn[sf * 3 + 2];
          const slen = Math.hypot(sx, sy, sz);
          if (slen === 0 || (nx * sx + ny * sy + nz * sz) >= cos * len * slen) { g = s; break; }
        }
        if (g === -1) {
          if (seeds.length >= 255) g = seeds.length - 1;
          else { g = seeds.length; seeds.push(f); extra++; }
        }
      } else if (!seeds.length) {
        seeds.push(f);
      }
      group[corner] = g;
    }
    if (onProgress && (v & (PROGRESS_EVERY - 1)) === 0) onProgress(0.35 + 0.4 * (v / vCount));
  }

  const outCount = vCount + extra;
  const outPos = extra ? new Float32Array(outCount * 3) : positions;
  if (extra) outPos.set(positions);
  const normals = new Float32Array(outCount * 3);
  let next = vCount;
  const groupVertex = [];
  for (let v = 0; v < vCount; v++) {
    groupVertex.length = 0;
    groupVertex.push(v);
    for (let k = start[v]; k < start[v + 1]; k++) {
      const corner = cornersOf[k];
      const g = group[corner];
      while (groupVertex.length <= g) {
        const nv = next++;
        outPos[nv * 3] = positions[v * 3]; outPos[nv * 3 + 1] = positions[v * 3 + 1]; outPos[nv * 3 + 2] = positions[v * 3 + 2];
        groupVertex.push(nv);
      }
      const target = groupVertex[g];
      indices[corner] = target;
      const f = (corner / 3) | 0;
      normals[target * 3] += fn[f * 3];
      normals[target * 3 + 1] += fn[f * 3 + 1];
      normals[target * 3 + 2] += fn[f * 3 + 2];
    }
    if (onProgress && (v & (PROGRESS_EVERY - 1)) === 0) onProgress(0.75 + 0.2 * (v / vCount));
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 0) { normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len; }
    else normals[i + 1] = 1;
  }
  onProgress?.(1);
  return { positions: outPos, normals, indices };
}
