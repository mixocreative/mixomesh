// Topology validation in a worker (perf goal 2026-06-13: heavy print models —
// 80k+ tris, 4096² textures — must never block the UI on import). Pure math,
// no Babylon: receives transferable positions (Float32) + indices (Uint32),
// returns { badEdgeCount, inverted }. The main-thread MeshValidator does the
// cheap world-space bed-bounds check itself.
//
// Algorithms are the fast variants of the old main-thread code:
//  - Position weld uses a NUMERIC packed key (no per-vertex string alloc).
//  - Non-manifold edges use a NUMERIC packed key (no per-edge string alloc).
//  - Inverted-normals uses the signed mesh volume (one O(tris) pass, no ray
//    casts / octree) — V<0 ⇒ inward winding. Robust for closed meshes; a
//    cheap heuristic for open ones, same as the old ray vote.

const MERGE_DISTANCE = 1e-4;   // 0.1 mm (1 BU = 1 m) — matches MeshValidator

// Weld vertices by quantized position. Returns Int32Array remap[vertexIndex]
// → canonical vertex index. Packed integer key avoids 'x|y|z' string churn
// (the dominant cost on dense meshes).
function weldedIndexMap(positions) {
  const eps = MERGE_DISTANCE;
  const n = positions.length / 3;
  const remap = new Int32Array(n);
  const canonical = new Map();   // packedKey(number) → canonical index
  // Quantized coords land in a bounded integer range for real print models
  // (~±metres / 0.1 mm ⇒ ±~1e5). Bias to non-negative and pack base-2^21 so
  // three components stay < 2^53 (exact JS number). Out-of-range coords still
  // produce a unique-ish key (collisions only cost a missed weld, never
  // corruption).
  const BIAS = 1 << 20;          // 1,048,576 — covers ±~100 m at 0.1 mm
  const BASE = 1 << 21;          // 2,097,152
  for (let i = 0; i < n; i++) {
    const qx = (Math.round(positions[i * 3]     / eps) + BIAS) | 0;
    const qy = (Math.round(positions[i * 3 + 1] / eps) + BIAS) | 0;
    const qz = (Math.round(positions[i * 3 + 2] / eps) + BIAS) | 0;
    const key = (qx * BASE + qy) * BASE + qz;
    let c = canonical.get(key);
    if (c === undefined) { c = i; canonical.set(key, c); }
    remap[i] = c;
  }
  return remap;
}

function checkNonManifold(positions, indices) {
  const w = weldedIndexMap(positions);
  const vCount = positions.length / 3;
  const edges = new Map();   // packed numeric edge key → face count
  for (let i = 0; i < indices.length; i += 3) {
    const a = w[indices[i]], b = w[indices[i + 1]], c = w[indices[i + 2]];
    if (a === b || b === c || c === a) continue;   // degenerate after weld
    // Each undirected edge → min*vCount + max (unique < 2^53 for vCount ≤ ~94M).
    const e0 = a < b ? a * vCount + b : b * vCount + a;
    const e1 = b < c ? b * vCount + c : c * vCount + b;
    const e2 = c < a ? c * vCount + a : a * vCount + c;
    edges.set(e0, (edges.get(e0) ?? 0) + 1);
    edges.set(e1, (edges.get(e1) ?? 0) + 1);
    edges.set(e2, (edges.get(e2) ?? 0) + 1);
  }
  let bad = 0;
  for (const count of edges.values()) if (count !== 2) bad++;
  return bad;
}

// Signed volume of the triangle soup (local space — sign is transform-
// invariant for the winding test). Sum of tetrahedra (origin, v0, v1, v2).
function checkInvertedNormals(positions, indices) {
  let v6 = 0;   // 6× volume
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    // dot(a, cross(b, c))
    const crx = by * cz - bz * cy;
    const cry = bz * cx - bx * cz;
    const crz = bx * cy - by * cx;
    v6 += ax * crx + ay * cry + az * crz;
  }
  return v6 < 0;
}

self.onmessage = (e) => {
  const { id, positions, indices } = e.data;
  try {
    const badEdgeCount = checkNonManifold(positions, indices);
    const inverted = checkInvertedNormals(positions, indices);
    self.postMessage({ id, type: 'done', badEdgeCount, inverted });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
