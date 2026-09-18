/**
 * Weld.js — the ONE vertex weld in the app (review I6).
 *
 * Babylon 9.6.2 ships NEITHER `Mesh.mergeVerticesByDistance` nor
 * `VertexData.MergeByDistance`, so both previous call sites
 * (`MeshValidator._weldLocally`, `PrintPipeline._weld`) were dead code that
 * silently did nothing — the validator's offline `nonManifold` "fix" and the
 * OBJ/STL/3MF `weld` prep step alike. This module implements the weld for
 * real, with the same position grid the validator's topology check already
 * uses (`MeshValidator._weldedIndexMap`), so "same position" means the same
 * thing in the check and in the fix.
 *
 * TEXTURE FIDELITY IS PART OF THE CONTRACT: vertices are merged only when
 * they share a position cell AND (when the mesh carries UVs) the exact same
 * UV. A UV seam is by construction two vertices at one position with
 * different UVs; merging those is what tore textured exports apart in review
 * C1, and the export prep runs this step on OBJ/STL unconditionally. Seam
 * duplicates therefore survive the weld untouched. This costs nothing in
 * topology terms — the validator counts non-manifold edges on a
 * POSITION-welded index map, so a seam duplicate was never counted as a
 * defect in the first place.
 *
 * Everything else is rebuilt: indices are remapped onto the canonical
 * vertices, triangles that became degenerate are dropped, the vertex buffers
 * are compacted to the vertices still referenced, and every vertex attribute
 * present on the mesh is remapped alongside `position` so no buffer is left
 * at a stale length.
 */

/** 0.1 mm at 1 BU = 1 m. Matches MeshValidator.MERGE_DISTANCE. */
export const WELD_DISTANCE = 1e-4;

// Vertex attributes remapped alongside `position`. A kind the mesh does not
// carry is skipped; anything not listed here (morph targets, matrices
// weights) is not used by the print/repair paths.
const ATTRIBUTES = [
  ['position', 3], ['normal', 3], ['uv', 2], ['uv2', 2], ['color', 4], ['tangent', 4],
];

/**
 * Weld `mesh` in place.
 * @param {object} mesh Babylon mesh (or duck-typed: get/setVerticesData, get/setIndices)
 * @param {number} [distance] merge distance in Babylon units
 * @returns {boolean} true when the geometry actually changed
 */
export function weldMesh(mesh, distance = WELD_DISTANCE) {
  const positions = mesh?.getVerticesData?.('position');
  const indices = mesh?.getIndices?.();
  if (!positions?.length || !indices?.length) return false;

  const cell = distance > 0 ? distance : WELD_DISTANCE;
  const vertexCount = Math.floor(positions.length / 3);
  // A SHORT uv buffer is treated as no UVs at all. Reading past its end would
  // put `undefined` in the merge key, which stringifies to the same "undefined"
  // for every such vertex — i.e. it would MERGE unrelated vertices. Babylon
  // keeps the buffers in step, so this is a guard, not an expected path.
  const rawUvs = mesh.getVerticesData?.('uv');
  const uvs = rawUvs?.length >= vertexCount * 2 ? rawUvs : null;
  const keyOf = (i) => {
    const k = `${Math.round(positions[i * 3] / cell)}|`
            + `${Math.round(positions[i * 3 + 1] / cell)}|`
            + `${Math.round(positions[i * 3 + 2] / cell)}`;
    return uvs ? `${k}#${uvs[i * 2]},${uvs[i * 2 + 1]}` : k;
  };

  const canonical = new Map();
  const remap = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const k = keyOf(i);
    let c = canonical.get(k);
    if (c === undefined) { c = i; canonical.set(k, c); }
    remap[i] = c;
  }

  const kept = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a === b || b === c || c === a) continue;   // degenerate after weld
    kept.push(a, b, c);
  }

  const merged = vertexCount - canonical.size;
  const dropped = Math.floor(indices.length / 3) - kept.length / 3;
  if (merged === 0 && dropped === 0) return false;   // nothing to do — never touch the buffers

  // Compact to the canonical vertices still referenced, in first-use order.
  const compacted = new Map();
  const order = [];
  const outIndices = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    let ni = compacted.get(kept[i]);
    if (ni === undefined) { ni = order.length; compacted.set(kept[i], ni); order.push(kept[i]); }
    outIndices[i] = ni;
  }

  // Snapshot every source buffer BEFORE writing any of them back.
  const sources = [];
  for (const [kind, stride] of ATTRIBUTES) {
    const src = mesh.getVerticesData?.(kind);
    if (src?.length >= vertexCount * stride) sources.push([kind, stride, src]);
  }
  for (const [kind, stride, src] of sources) {
    const dst = new Float32Array(order.length * stride);
    for (let n = 0; n < order.length; n++) {
      const s = order[n] * stride;
      for (let c = 0; c < stride; c++) dst[n * stride + c] = src[s + c] ?? 0;
    }
    mesh.setVerticesData(kind, dst, true);
  }
  mesh.setIndices(outIndices, null, true);
  mesh.refreshBoundingInfo?.();
  return true;
}

/**
 * Position-only weld of bare arrays (no UVs, no mesh) — the topology view a
 * multi-part object's welded UNION needs (MeshValidator.validateGroup,
 * GroupRepair). Two vertices in the same position cell become one; triangles
 * degenerate after the merge are dropped. Returns compacted arrays plus the
 * per-input-vertex remap so callers can trace a welded vertex back.
 * @param {ArrayLike<number>} positions flat xyz
 * @param {ArrayLike<number>} indices
 * @param {number} [cell]
 * @returns {{positions: Float32Array, indices: Uint32Array, remap: Int32Array}}
 *   `remap[i]` = welded index of input vertex i (or -1 when no kept
 *   triangle references it).
 */
export function weldArrays(positions, indices, cell = WELD_DISTANCE) {
  const vertexCount = Math.floor(positions.length / 3);
  const canonical = new Map();
  const remap = new Int32Array(vertexCount);
  const outPos = [];
  for (let i = 0; i < vertexCount; i++) {
    const k = `${Math.round(positions[i * 3] / cell)}|${Math.round(positions[i * 3 + 1] / cell)}|${Math.round(positions[i * 3 + 2] / cell)}`;
    let c = canonical.get(k);
    if (c === undefined) {
      c = outPos.length / 3;
      canonical.set(k, c);
      outPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = c;
  }
  const kept = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a === b || b === c || c === a) continue;
    kept.push(a, b, c);
  }
  return { positions: Float32Array.from(outPos), indices: Uint32Array.from(kept), remap };
}
