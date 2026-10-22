// Pure typed-array steps of the 3MF build (no Babylon, no DOM): placing a
// part's vertices, dropping slicer helper volumes, grouping triangles by
// material and compacting a group's (vertex, UV) pairs. ThreeMFLoader wires
// them to Babylon meshes; tests run them under Node.
//
// Geometry shape (from ThreeMFXml): `positions` Float64Array xyz per vertex,
// `triangles` Int32Array of 7 fields per triangle: v1 v2 v3 pid p1 p2 p3
// (-1 = attribute absent).

export const TRI_FIELDS = 7;

/**
 * Geometry minus the triangles inside `ranges` (inclusive triangle indices),
 * with the vertex pool compacted so dropped volumes leave no stray vertices.
 * An out-of-range index maps to -1 so the caller's range check still throws.
 */
export function withoutTriangleRanges(geometry, ranges) {
  const tri = geometry.triangles;
  const triangleCount = tri.length / TRI_FIELDS;
  const vertexCount = geometry.positions.length / 3;
  const drop = (i) => ranges.some(([first, last]) => i >= first && i <= last);
  const remap = new Int32Array(vertexCount).fill(-1);
  let kept = 0;
  let verts = 0;
  for (let i = 0; i < triangleCount; i++) {
    if (drop(i)) continue;
    kept++;
    for (let c = 0; c < 3; c++) {
      const v = tri[i * TRI_FIELDS + c];
      if (Number.isInteger(v) && v >= 0 && v < vertexCount && remap[v] < 0) remap[v] = verts++;
    }
  }
  const positions = new Float32Array(verts * 3);
  for (let v = 0; v < vertexCount; v++) {
    const o = remap[v];
    if (o >= 0) positions.set(geometry.positions.subarray(v * 3, v * 3 + 3), o * 3);
  }
  const triangles = new Int32Array(kept * TRI_FIELDS);
  for (let i = 0, k = 0; i < triangleCount; i++) {
    if (drop(i)) continue;
    for (let c = 0; c < TRI_FIELDS; c++) {
      const value = tri[i * TRI_FIELDS + c];
      triangles[k * TRI_FIELDS + c] = c >= 3 ? value
        : (Number.isInteger(value) && value >= 0 && value < vertexCount ? remap[value] : -1);
    }
    k++;
  }
  return { positions, triangles };
}

/**
 * Part vertices → scene positions: unit scale, then the 3MF-space placement
 * (`m` = a 16-float column-major matrix or null), then the 3×3 print-space
 * basis (`ps`, row-major). Same arithmetic as Vector3.TransformCoordinates +
 * fromPrintSpace without two allocations per vertex (10M-triangle parts have
 * ~5M vertices). A non-numeric coordinate throws, naming the vertex.
 * @returns {Float32Array}
 */
export function placeVertices(source, unitScale, m, ps, objectId) {
  const vertexCount = source.length / 3;
  const positions = new Float32Array(source.length);
  for (let i = 0; i < vertexCount; i++) {
    const vx = source[i * 3], vy = source[i * 3 + 1], vz = source[i * 3 + 2];
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
      throw new Error(`3MF: vertex ${i} of object ${objectId} has a non-numeric coordinate`);
    }
    let x = vx * unitScale, y = vy * unitScale, z = vz * unitScale;
    if (m) {
      const rx = x * m[0] + y * m[4] + z * m[8] + m[12];
      const ry = x * m[1] + y * m[5] + z * m[9] + m[13];
      const rz = x * m[2] + y * m[6] + z * m[10] + m[14];
      const rw = 1 / (x * m[3] + y * m[7] + z * m[11] + m[15]);
      x = rx * rw; y = ry * rw; z = rz * rw;
    }
    positions[i * 3]     = ps[0] * x + ps[1] * y + ps[2] * z;
    positions[i * 3 + 1] = ps[3] * x + ps[4] * y + ps[5] * z;
    positions[i * 3 + 2] = ps[6] * x + ps[7] * y + ps[8] * z;
  }
  return positions;
}

/**
 * Triangles grouped by material key, first-seen order, in two passes over
 * typed arrays (no per-triangle JS objects): pass 1 assigns each triangle a
 * group and counts, pass 2 packs `[a, b, c, p1, p2, p3]` per triangle. A
 * triangle without `pid` inherits the object's pid/pindex; `p2`/`p3` default
 * to `p1` (3MF Core §4.1). An index outside the vertex pool throws.
 * @param {Int32Array} tri  packed triangles
 * @param {number} vertexCount
 * @param {{ pid: string|null, pindex: number }} objectDefaults
 * @param {(pid: string|null, p1: number) => { str: string, tg: object|null }} keyOf
 * @param {string} objectId  for the error message
 * @returns {{ groups: { key: object, tris: Int32Array|null }[], singleSolid: boolean }}
 *   `singleSolid` = one group and no texture: `tris` is left null, use `soupIndices`.
 */
export function groupTriangles(tri, vertexCount, objectDefaults, keyOf, objectId) {
  const triangleCount = tri.length / TRI_FIELDS;
  const keyCache = new Map();                    // pid → Map(p1 → group index)
  const groups = [];                             // [{ key, count, tris }]
  const triGroup = new Uint32Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) {
    const offset = i * TRI_FIELDS;
    const a = tri[offset], b = tri[offset + 1], c = tri[offset + 2];
    if (!(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c))
        || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new Error(`3MF: triangle ${i} of object ${objectId} references a vertex outside 0..${vertexCount - 1}`);
    }
    const triPid = tri[offset + 3];
    const pid = triPid >= 0 ? String(triPid) : objectDefaults.pid;
    const rawP1 = tri[offset + 4];
    const p1 = rawP1 >= 0 ? rawP1 : objectDefaults.pindex;
    let byP1 = keyCache.get(pid);
    if (!byP1) { byP1 = new Map(); keyCache.set(pid, byP1); }
    let g = byP1.get(p1);
    if (g === undefined) {
      const key = keyOf(pid, p1);
      g = groups.findIndex(e => e.key.str === key.str);
      if (g < 0) { g = groups.length; groups.push({ key, count: 0, tris: null }); }
      byP1.set(p1, g);
    }
    triGroup[i] = g;
    groups[g].count++;
  }
  const singleSolid = groups.length === 1 && !groups[0].key.tg;
  if (!singleSolid) {
    const fillAt = new Uint32Array(groups.length);
    for (const e of groups) e.tris = new Int32Array(e.count * 6);
    for (let i = 0; i < triangleCount; i++) {
      const offset = i * TRI_FIELDS;
      const g = triGroup[i];
      const rawP1 = tri[offset + 4];
      const p1 = rawP1 >= 0 ? rawP1 : objectDefaults.pindex;
      const p2 = tri[offset + 5];
      const p3 = tri[offset + 6];
      const t = groups[g].tris;
      const o = fillAt[g]; fillAt[g] += 6;
      t[o] = tri[offset]; t[o + 1] = tri[offset + 1]; t[o + 2] = tri[offset + 2];
      t[o + 3] = p1; t[o + 4] = p2 >= 0 ? p2 : p1; t[o + 5] = p3 >= 0 ? p3 : p1;
    }
  }
  return { groups: groups.map(({ key, tris }) => ({ key, tris })), singleSolid };
}

/** The file's index order over the whole vertex pool (one solid material). */
export function soupIndices(tri) {
  const triangleCount = tri.length / TRI_FIELDS;
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0, t = 0; i < triangleCount; i++, t += 3) {
    indices[t] = tri[i * TRI_FIELDS]; indices[t + 1] = tri[i * TRI_FIELDS + 1]; indices[t + 2] = tri[i * TRI_FIELDS + 2];
  }
  return indices;
}

/**
 * One material group → its own vertex buffer. Source vertex (+ tex2coord for
 * a textured group) → compact index, in typed arrays: a per-vertex head plus
 * a chain of (coord, out index) entries, so a 10M-triangle textured part
 * makes no per-corner strings or Maps. Textured groups key on (vertex, coord)
 * so a UV seam at a shared vertex splits exactly as the file describes it;
 * solid groups key on the vertex.
 * @param {Int32Array} tris  `[a, b, c, p1, p2, p3]` per triangle
 * @param {Float32Array} positions  placed vertices of the whole part
 * @param {{ u: number, v: number }[] | null} coords  tex2coords, or null for a solid group
 * @returns {{ positions: Float32Array, uvs: Float32Array|null, indices: Uint32Array }}
 */
export function compactGroup(tris, positions, coords) {
  const vertexCount = positions.length / 3;
  const textured = !!coords;
  const corners = tris.length / 2;
  const head = new Int32Array(vertexCount).fill(-1);
  const entCoord = textured ? new Int32Array(corners) : null;
  const entNext = textured ? new Int32Array(corners) : null;
  const entOut = textured ? new Int32Array(corners) : null;
  let entries = 0;
  let outCount = 0;
  const outVertex = new Int32Array(corners);   // compact index → source vertex
  const outCoordIdx = textured ? new Int32Array(corners) : null;
  const indices = new Uint32Array(corners);
  const compact = (v, p) => {
    if (!textured) {
      let idx = head[v];
      if (idx < 0) { idx = outCount++; head[v] = idx; outVertex[idx] = v; }
      return idx;
    }
    for (let e = head[v]; e >= 0; e = entNext[e]) if (entCoord[e] === p) return entOut[e];
    const idx = outCount++;
    outVertex[idx] = v;
    outCoordIdx[idx] = p;
    entCoord[entries] = p; entOut[entries] = idx; entNext[entries] = head[v]; head[v] = entries++;
    return idx;
  };
  for (let i = 0, t = 0; i < tris.length; i += 6, t += 3) {
    indices[t]     = compact(tris[i],     tris[i + 3]);
    indices[t + 1] = compact(tris[i + 1], tris[i + 4]);
    indices[t + 2] = compact(tris[i + 2], tris[i + 5]);
  }
  const subPositions = new Float32Array(outCount * 3);
  const uvs = textured ? new Float32Array(outCount * 2) : null;
  for (let o = 0; o < outCount; o++) {
    const v = outVertex[o];
    subPositions[o * 3] = positions[v * 3]; subPositions[o * 3 + 1] = positions[v * 3 + 1]; subPositions[o * 3 + 2] = positions[v * 3 + 2];
    if (uvs) { const uv = coords[outCoordIdx[o]]; uvs[o * 2] = uv ? uv.u : 0; uvs[o * 2 + 1] = uv ? uv.v : 0; }
  }
  return { positions: subPositions, uvs, indices };
}
