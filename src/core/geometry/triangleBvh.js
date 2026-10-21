// Flat typed-array BVH over a mesh's triangles (heavy-mesh spec §4, §7.5).
// Pure: built in workers/TriangleBvh.worker.js, queried on the main thread by
// scene/HeavyPick.js. Binned SAH build that carries bin bounds down to the
// children (one binning + one partition pass per level, no per-node rescans),
// leaves of ≤ 8 triangles, and a two-sided nearest-hit raycast with Babylon's
// Ray.intersectsTriangle semantics (bu/bv/distance, ray.length, epsilon).
//
// Layout: node n → bounds[n*6 .. n*6+5] = min xyz, max xyz;
//   data[n*2]   = first child (inner; children are n0 and n0+1) or first slot in `tris` (leaf)
//   data[n*2+1] = 0 for inner nodes, triangle count for leaves.

const LEAF = 8;
const BINS = 16;
const TRAVERSAL_COST = 1;
const INTERSECT_COST = 1;

function growF32(a, n) { if (n <= a.length) return a; const b = new Float32Array(Math.max(n, a.length * 2)); b.set(a); return b; }
function growU32(a, n) { if (n <= a.length) return a; const b = new Uint32Array(Math.max(n, a.length * 2)); b.set(a); return b; }

/**
 * Build the BVH.
 * @param {ArrayLike<number>} positions  xyz per vertex
 * @param {ArrayLike<number>} indices    3 per triangle
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {{ bounds: Float32Array, data: Uint32Array, tris: Uint32Array, nodeCount: number }}
 */
export function buildTriangleBvh(positions, indices, { onProgress } = {}) {
  const triCount = Math.floor(indices.length / 3);
  const tris = new Uint32Array(triCount);
  const cent = new Float32Array(triCount * 3);
  const tb = new Float32Array(triCount * 6);    // per-triangle bounds
  const root = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const rootC = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triCount; t++) {
    tris[t] = t;
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const va = positions[a + k], vb = positions[b + k], vc = positions[c + k];
      const lo = Math.min(va, vb, vc), hi = Math.max(va, vb, vc);
      tb[t * 6 + k] = lo; tb[t * 6 + 3 + k] = hi;
      const ce = (lo + hi) * 0.5;
      cent[t * 3 + k] = ce;
      if (lo < root[k]) root[k] = lo;
      if (hi > root[3 + k]) root[3 + k] = hi;
      if (ce < rootC[k]) rootC[k] = ce;
      if (ce > rootC[3 + k]) rootC[3 + k] = ce;
    }
  }
  let bounds = new Float32Array(Math.max(6, Math.ceil(triCount / LEAF) * 2 * 6));
  let data = new Uint32Array(Math.max(2, Math.ceil(triCount / LEAF) * 2 * 2));
  let nodeCount = 1;
  bounds.set(root, 0);
  if (triCount === 0) { data[1] = 0; return { bounds, data, tris, nodeCount }; }

  // Work stack entries: node, start, end, centroid bounds (6).
  const stack = [[0, 0, triCount, rootC]];
  const binCount = new Uint32Array(BINS);
  const binB = new Float64Array(BINS * 6);
  const binC = new Float64Array(BINS * 6);
  const leftArea = new Float64Array(BINS);
  const leftCount = new Uint32Array(BINS);
  const leftB = new Float64Array(BINS * 6);
  const leftCB = new Float64Array(BINS * 6);
  let placed = 0;
  const area = (b, o) => {
    const dx = b[o + 3] - b[o], dy = b[o + 4] - b[o + 1], dz = b[o + 5] - b[o + 2];
    return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
  };

  while (stack.length) {
    const [node, start, end, cb] = stack.pop();
    const count = end - start;
    const makeLeaf = () => {
      data[node * 2] = start; data[node * 2 + 1] = count;
      placed += count;
      if (onProgress && (placed & 0x3ffff) < count) onProgress(placed / triCount);
    };
    if (count <= LEAF) { makeLeaf(); continue; }
    // Longest centroid axis.
    const ex = cb[3] - cb[0], ey = cb[4] - cb[1], ez = cb[5] - cb[2];
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const lo = cb[axis], extent = cb[3 + axis] - lo;
    if (!(extent > 0)) {
      // All centroids coincide: split the range in half (still a valid BVH).
      const mid = start + (count >> 1);
      const child = nodeCount; nodeCount += 2;
      bounds = growF32(bounds, nodeCount * 6); data = growU32(data, nodeCount * 2);
      data[node * 2] = child; data[node * 2 + 1] = 0;
      for (const [cn, s, e] of [[child, start, mid], [child + 1, mid, end]]) {
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = s; i < e; i++) { const t = tris[i]; for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], tb[t * 6 + k]); b[3 + k] = Math.max(b[3 + k], tb[t * 6 + 3 + k]); } }
        bounds.set(b, cn * 6);
        stack.push([cn, s, e, cb]);
      }
      continue;
    }
    const scale = BINS / extent;
    binCount.fill(0);
    for (let i = 0; i < BINS * 6; i += 6) {
      binB[i] = binB[i + 1] = binB[i + 2] = Infinity; binB[i + 3] = binB[i + 4] = binB[i + 5] = -Infinity;
      binC[i] = binC[i + 1] = binC[i + 2] = Infinity; binC[i + 3] = binC[i + 4] = binC[i + 5] = -Infinity;
    }
    for (let i = start; i < end; i++) {
      const t = tris[i];
      let bin = ((cent[t * 3 + axis] - lo) * scale) | 0;
      if (bin >= BINS) bin = BINS - 1;
      binCount[bin]++;
      const o = bin * 6;
      for (let k = 0; k < 3; k++) {
        const l = tb[t * 6 + k], h = tb[t * 6 + 3 + k], c = cent[t * 3 + k];
        if (l < binB[o + k]) binB[o + k] = l;
        if (h > binB[o + 3 + k]) binB[o + 3 + k] = h;
        if (c < binC[o + k]) binC[o + k] = c;
        if (c > binC[o + 3 + k]) binC[o + 3 + k] = c;
      }
    }
    // Prefix (left) sweeps; right side accumulated on the fly below.
    const acc = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const accC = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let n = 0;
    for (let b = 0; b < BINS; b++) {
      n += binCount[b];
      for (let k = 0; k < 3; k++) {
        acc[k] = Math.min(acc[k], binB[b * 6 + k]); acc[3 + k] = Math.max(acc[3 + k], binB[b * 6 + 3 + k]);
        accC[k] = Math.min(accC[k], binC[b * 6 + k]); accC[3 + k] = Math.max(accC[3 + k], binC[b * 6 + 3 + k]);
      }
      leftCount[b] = n;
      leftArea[b] = area(acc, 0);
      leftB.set(acc, b * 6);
      leftCB.set(accC, b * 6);
    }
    const parentArea = area(bounds, node * 6) || 1;
    let best = -1, bestCost = Infinity;
    const racc = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const raccs = [];
    let rn = 0;
    for (let b = BINS - 1; b > 0; b--) {
      rn += binCount[b];
      for (let k = 0; k < 3; k++) { racc[k] = Math.min(racc[k], binB[b * 6 + k]); racc[3 + k] = Math.max(racc[3 + k], binB[b * 6 + 3 + k]); }
      raccs[b] = racc.slice();
      const ln = leftCount[b - 1];
      if (!ln || !rn) continue;
      const cost = TRAVERSAL_COST + INTERSECT_COST * (leftArea[b - 1] * ln + area(racc, 0) * rn) / parentArea;
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    if (best < 0 || (bestCost >= INTERSECT_COST * count && count <= 2 * LEAF)) { makeLeaf(); continue; }
    // Partition [start, end) by bin < best.
    let i = start, j = end - 1;
    while (i <= j) {
      let bin = ((cent[tris[i] * 3 + axis] - lo) * scale) | 0;
      if (bin >= BINS) bin = BINS - 1;
      if (bin < best) i++;
      else { const tmp = tris[i]; tris[i] = tris[j]; tris[j] = tmp; j--; }
    }
    const mid = i;
    // Right centroid bounds = union of bins ≥ best.
    const rcb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let b = best; b < BINS; b++) for (let k = 0; k < 3; k++) { rcb[k] = Math.min(rcb[k], binC[b * 6 + k]); rcb[3 + k] = Math.max(rcb[3 + k], binC[b * 6 + 3 + k]); }
    const child = nodeCount; nodeCount += 2;
    bounds = growF32(bounds, nodeCount * 6); data = growU32(data, nodeCount * 2);
    data[node * 2] = child; data[node * 2 + 1] = 0;
    for (let k = 0; k < 6; k++) bounds[child * 6 + k] = leftB[(best - 1) * 6 + k];
    for (let k = 0; k < 6; k++) bounds[(child + 1) * 6 + k] = raccs[best][k];
    stack.push([child + 1, mid, end, rcb]);
    stack.push([child, start, mid, Array.from(leftCB.subarray((best - 1) * 6, best * 6))]);
  }
  onProgress?.(1);
  return { bounds: bounds.slice(0, nodeCount * 6), data: data.slice(0, nodeCount * 2), tris, nodeCount };
}

/**
 * Nearest two-sided hit along a ray in the BVH's (mesh-local) space.
 * Mirrors Babylon's Ray.intersectsTriangle: IntersectionInfo(bu = 1 − v − w, bv = v, distance),
 * rejects distance < 0 or > length, `epsilon` slack on the barycentrics.
 * @param {{ bounds: Float32Array, data: Uint32Array, tris: Uint32Array }} bvh
 * @param {ArrayLike<number>} positions
 * @param {ArrayLike<number>} indices
 * @param {{ x: number, y: number, z: number }} origin
 * @param {{ x: number, y: number, z: number }} direction
 * @param {{ length?: number, epsilon?: number, fastCheck?: boolean }} [opts]
 * @returns {{ faceId: number, distance: number, bu: number, bv: number } | null}
 */
export function raycastBvh(bvh, positions, indices, origin, direction, { length = Infinity, epsilon = 0, fastCheck = false } = {}) {
  const { bounds, data, tris } = bvh;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = direction.x, dy = direction.y, dz = direction.z;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let bestT = length, best = null;
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    const o = n * 6;
    // Slab test.
    let t1 = (bounds[o] - ox) * ix, t2 = (bounds[o + 3] - ox) * ix;
    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
    t1 = (bounds[o + 1] - oy) * iy; t2 = (bounds[o + 4] - oy) * iy;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    t1 = (bounds[o + 2] - oz) * iz; t2 = (bounds[o + 5] - oz) * iz;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    if (Number.isNaN(tmin) || Number.isNaN(tmax)) { tmin = -Infinity; tmax = Infinity; }   // ray parallel to and inside a slab
    if (tmax < 0 || tmin > tmax || tmin > bestT) continue;
    const count = data[n * 2 + 1];
    if (count === 0) {
      const c = data[n * 2];
      stack.push(c + 1, c);
      continue;
    }
    const first = data[n * 2];
    for (let s = first; s < first + count; s++) {
      const f = tris[s];
      const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
      const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det === 0) continue;
      const inv = 1 / det;
      const tx = ox - positions[a], ty = oy - positions[a + 1], tz = oz - positions[a + 2];
      const v = (tx * px + ty * py + tz * pz) * inv;
      if (v < -epsilon || v > 1 + epsilon) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * inv;
      if (w < -epsilon || v + w > 1 + epsilon) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist < 0 || dist > length) continue;
      if (best === null || dist < bestT) {
        bestT = dist;
        best = { faceId: f, distance: dist, bu: 1 - v - w, bv: v };
        if (fastCheck) return best;
      }
    }
  }
  return best;
}

/**
 * Same hit rules as raycastBvh over ALL triangles, without an index and
 * without allocating — the stop-gap while a heavy mesh's BVH is building
 * (Babylon's default would first build a Vector3 per vertex).
 */
export function raycastAll(positions, indices, origin, direction, { length = Infinity, epsilon = 0, fastCheck = false } = {}) {
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = direction.x, dy = direction.y, dz = direction.z;
  let best = null, bestT = length;
  const triCount = Math.floor(indices.length / 3);
  for (let f = 0; f < triCount; f++) {
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det === 0) continue;
    const inv = 1 / det;
    const tx = ox - positions[a], ty = oy - positions[a + 1], tz = oz - positions[a + 2];
    const v = (tx * px + ty * py + tz * pz) * inv;
    if (v < -epsilon || v > 1 + epsilon) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (dx * qx + dy * qy + dz * qz) * inv;
    if (w < -epsilon || v + w > 1 + epsilon) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist < 0 || dist > length) continue;
    if (best === null || dist < bestT) {
      bestT = dist;
      best = { faceId: f, distance: dist, bu: 1 - v - w, bv: v };
      if (fastCheck) return best;
    }
  }
  return best;
}
