// Pre-parse triangle estimate (heavy-mesh spec §3). Reads at most a small head
// slice (plus, for 3MF, the zip central directory; for GLB, the JSON chunk) so
// an import can be refused or warned about BEFORE the file is parsed, hashed
// or copied. Pure helpers take bytes; `estimateFileTriangles` slices a Blob.
//
// Result: { triangles, exact } or null when the format gives no cheap answer.
// `exact` = the count is the real number (binary STL, GLB/glTF accessors);
// otherwise it is a sampled estimate and callers must allow a margin.

export const HEAD_BYTES = 1024 * 1024;
const STL_HEADER = 84;
const STL_FACET = 50;
/** Typical 3MF bytes per triangle in the uncompressed model XML: V ≈ T/2 vertex
 *  elements (~48 B) plus one triangle element (~42 B). Measured on the pillow
 *  fixture (10M tris → 66 B/tri) and on exported Mimaki parts (60–70 B/tri). */
export const THREEMF_BYTES_PER_TRIANGLE = 66;
const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;
const GL_TRIANGLES = 4;

const _ascii = new TextDecoder('latin1');

/**
 * Binary or ASCII STL, Babylon's detection rule: binary when the size matches
 * the header count, ASCII when it starts with "solid", binary otherwise.
 * ASCII density is sampled on the head and, when given, the tail slice too
 * (files are rarely uniform end to end).
 * @param {Uint8Array} head  first bytes of the file
 * @param {number} size  full file size
 * @param {Uint8Array} [tail]  last bytes of the file
 */
export function estimateStl(head, size, tail) {
  if (size > STL_HEADER && head.length >= STL_HEADER) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const count = view.getUint32(80, true);
    if (STL_HEADER + count * STL_FACET === size) return { triangles: count, exact: true };
  }
  const start = _ascii.decode(head.subarray(0, 5));
  if (start !== 'solid') {
    return size > STL_HEADER ? { triangles: Math.floor((size - STL_HEADER) / STL_FACET), exact: false } : null;
  }
  const count = (bytes) => (_ascii.decode(bytes).match(/endfacet/g) ?? []).length;
  const facets = count(head);
  if (head.length >= size) return facets ? { triangles: facets, exact: true } : null;
  const tailFacets = tail?.length ? count(tail) : 0;
  const sampled = head.length + (tail?.length ?? 0);
  if (!facets && !tailFacets) return null;
  return { triangles: Math.round((facets + tailFacets) * (size / sampled)), exact: false };
}

/** OBJ: face lines in the head (an n-gon is n−2 triangles), scaled to the file size. */
export function estimateObj(head, size) {
  const text = _ascii.decode(head);
  let tris = 0;
  for (const line of text.split('\n')) {
    if (line.charCodeAt(0) !== 102 || (line.charCodeAt(1) !== 32 && line.charCodeAt(1) !== 9)) continue;
    const corners = line.trim().split(/\s+/).length - 1;
    if (corners >= 3) tris += corners - 2;
  }
  if (head.length >= size) return { triangles: tris, exact: true };
  if (!tris) return null;   // head is all vertices: no basis for a sample
  return { triangles: Math.round(tris * (size / head.length)), exact: false };
}

/**
 * Find the uncompressed size of the 3MF model part from the zip central
 * directory. `tail` = the last bytes of the file (must contain the EOCD
 * record); `readAt(offset, length)` returns bytes of the central directory.
 * @returns {Promise<number|null>}
 */
export async function threeMFModelBytes(tail, size, readAt) {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let cdSize = v.getUint32(eocd + 12, true);
  let cdOffset = v.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64: locator sits 20 bytes before the EOCD.
    const loc = eocd - 20;
    if (loc < 0 || v.getUint32(loc, true) !== 0x07064b50) return null;
    const rec = Number(v.getBigUint64(loc + 8, true));
    const recBytes = await readAt(rec, 56);
    const rv = new DataView(recBytes.buffer, recBytes.byteOffset, recBytes.byteLength);
    cdSize = Number(rv.getBigUint64(40, true));
    cdOffset = Number(rv.getBigUint64(48, true));
  }
  if (cdOffset + cdSize > size) return null;
  const cd = await readAt(cdOffset, cdSize);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  let total = 0;
  for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50;) {
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    const name = _ascii.decode(cd.subarray(p + 46, p + 46 + nameLen));
    let uncompressed = cv.getUint32(p + 24, true);
    if (uncompressed === 0xffffffff) {
      for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
        const id = cv.getUint16(e, true);
        const len = cv.getUint16(e + 2, true);
        if (id === 0x0001) { uncompressed = Number(cv.getBigUint64(e + 4, true)); break; }
        e += 4 + len;
      }
    }
    if (/\.model$/i.test(name)) total += uncompressed;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return total || null;
}

function _meshTriangles(json, mesh) {
  const accessors = json?.accessors ?? [];
  let tris = 0;
  for (const prim of mesh?.primitives ?? []) {
    if ((prim?.mode ?? GL_TRIANGLES) !== GL_TRIANGLES) continue;
    const acc = prim.indices != null ? accessors[prim.indices] : accessors[prim?.attributes?.POSITION];
    if (acc?.count > 0) tris += Math.floor(acc.count / 3);
  }
  return tris;
}

/**
 * Triangles the scene will hold: every node that references a mesh counts it
 * (instancing), unreferenced meshes count nothing (review M9). Without nodes,
 * every mesh once.
 */
export function countGltfJsonTriangles(json) {
  const meshes = json?.meshes ?? [];
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  const referenced = nodes.filter(n => Number.isInteger(n?.mesh) && meshes[n.mesh]);
  if (!referenced.length) return meshes.reduce((n, m) => n + _meshTriangles(json, m), 0);
  return referenced.reduce((n, node) => n + _meshTriangles(json, meshes[node.mesh]), 0);
}

/** Exact unless GPU instancing multiplies nodes at load (then a lower bound, warn-only). */
export function gltfEstimate(json) {
  const instanced = (json?.extensionsUsed ?? []).includes('EXT_mesh_gpu_instancing');
  return instanced
    ? { triangles: countGltfJsonTriangles(json), exact: false, warnOnly: true }
    : { triangles: countGltfJsonTriangles(json), exact: true };
}

/** GLB header → byte length of its JSON chunk (or null when not a GLB). */
export function glbJsonChunkLength(head) {
  if (head.length < 20) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getUint32(0, true) !== 0x46546c67) return null;          // 'glTF'
  if (v.getUint32(16, true) !== 0x4e4f534a) return null;         // 'JSON'
  return v.getUint32(12, true);
}

const _slice = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

/**
 * Estimate a file's triangle count from a few small slices.
 * @param {Blob} blob
 * @param {string} ext  lower-case with dot ('.stl', '.obj', '.3mf', '.glb', '.gltf')
 * @returns {Promise<{ triangles: number, exact: boolean } | null>}
 */
export async function estimateFileTriangles(blob, ext) {
  const size = blob?.size ?? 0;
  if (!(size > 0) || typeof blob.slice !== 'function') return null;
  try {
    if (ext === '.stl') {
      const head = await _slice(blob, 0, Math.min(size, HEAD_BYTES));
      const tail = size > 2 * HEAD_BYTES ? await _slice(blob, size - HEAD_BYTES, size) : null;
      return estimateStl(head, size, tail);
    }
    if (ext === '.obj') return estimateObj(await _slice(blob, 0, Math.min(size, HEAD_BYTES)), size);
    if (ext === '.3mf') {
      const tailLen = Math.min(size, 66 * 1024);
      const tail = await _slice(blob, size - tailLen, size);
      const modelBytes = await threeMFModelBytes(tail, size, (off, len) => _slice(blob, off, off + len));
      // Warn-only: paint / segmentation attributes make bytes per triangle vary widely.
      return modelBytes ? { triangles: Math.round(modelBytes / THREEMF_BYTES_PER_TRIANGLE), exact: false, warnOnly: true } : null;
    }
    if (ext === '.glb') {
      const len = glbJsonChunkLength(await _slice(blob, 0, 20));
      if (!len || len > MAX_GLTF_JSON_BYTES) return null;
      const json = JSON.parse(new TextDecoder().decode(await _slice(blob, 20, 20 + len)));
      return gltfEstimate(json);
    }
    if (ext === '.gltf') {
      if (size > MAX_GLTF_JSON_BYTES) return null;
      return gltfEstimate(JSON.parse(await blob.text()));
    }
  } catch {
    return null;   // unreadable header: no pre-parse decision, the post-parse check decides
  }
  return null;
}
