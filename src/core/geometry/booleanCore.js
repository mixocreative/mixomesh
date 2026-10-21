// Pure Boolean core run by workers/Boolean.worker.js (and testable under Node
// against the real vendored manifold-3d). It mirrors Babylon's CSG2 exactly,
// so worker results match the main-thread path:
//  - positions go through the world matrix (TransformCoordinates), normals
//    through its 3x3 (TransformNormal: no inverse-transpose, no normalise);
//  - triangle winding is reversed on the way into Manifold and back out
//    (Babylon's left-handed winding vs Manifold's CCW-outward);
//  - normals ride along as vertex properties (numProp 6) when EVERY operand
//    has them, so creases stay sharp; Mesh.merge() welds by position first.
// Operands are { positions, indices, normals?, matrix } in mesh-local space;
// `matrix` is the Babylon world matrix's 16 numbers (row-vector layout).

const OPS = { union: 'add', subtract: 'subtract', intersect: 'intersect' };

/** Bake one operand to world space (fresh arrays). */
export function worldOperand({ positions, normals = null, indices, matrix }) {
  const m = matrix;
  const p = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const w = x * m[3] + y * m[7] + z * m[11] + m[15] || 1;
    p[i]     = (x * m[0] + y * m[4] + z * m[8]  + m[12]) / w;
    p[i + 1] = (x * m[1] + y * m[5] + z * m[9]  + m[13]) / w;
    p[i + 2] = (x * m[2] + y * m[6] + z * m[10] + m[14]) / w;
  }
  let n = null;
  if (normals) {
    n = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2];
      n[i]     = x * m[0] + y * m[4] + z * m[8];
      n[i + 1] = x * m[1] + y * m[5] + z * m[9];
      n[i + 2] = x * m[2] + y * m[6] + z * m[10];
    }
  }
  return { positions: p, normals: n, indices };
}

function toManifold(wasm, { positions, normals, indices }, numProp) {
  const vertexCount = positions.length / 3;
  const vertProperties = new Float32Array(vertexCount * numProp);
  for (let v = 0; v < vertexCount; v++) {
    vertProperties[v * numProp]     = positions[v * 3];
    vertProperties[v * numProp + 1] = positions[v * 3 + 1];
    vertProperties[v * numProp + 2] = positions[v * 3 + 2];
    if (numProp === 6) {
      vertProperties[v * numProp + 3] = normals[v * 3];
      vertProperties[v * numProp + 4] = normals[v * 3 + 1];
      vertProperties[v * numProp + 5] = normals[v * 3 + 2];
    }
  }
  const triVerts = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    triVerts[i] = indices[i + 2];
    triVerts[i + 1] = indices[i + 1];
    triVerts[i + 2] = indices[i];
  }
  const mesh = new wasm.Mesh({ numProp, vertProperties, triVerts });
  mesh.merge();
  try {
    return new wasm.Manifold(mesh);
  } catch (e) {
    throw new Error(`Boolean: operand is not a closed solid (manifold) — ${e?.message ?? e}`);
  }
}

/**
 * Run a Boolean on raw arrays.
 * @param {any} wasm  initialised manifold-3d module (Manifold, Mesh)
 * @param {'union'|'subtract'|'intersect'} op  subtract/intersect base = operands[0]
 * @param {Array<{positions: Float32Array, indices: Uint32Array, normals?: Float32Array|null, matrix: ArrayLike<number>}>} operands
 * @returns {{ positions: Float32Array, normals: Float32Array|null, indices: Uint32Array }}  world space, Babylon winding
 */
export function booleanArrays(wasm, op, operands) {
  const method = OPS[op];
  if (!method) throw new Error(`Boolean: bad op ${op}`);
  if (!Array.isArray(operands) || operands.length < 2) throw new Error('Boolean: need at least two operands');
  const world = operands.map(worldOperand);
  const numProp = world.every(o => o.normals && o.normals.length === o.positions.length) ? 6 : 3;
  const made = [];
  try {
    let acc = toManifold(wasm, world[0], numProp);
    made.push(acc);
    for (let i = 1; i < world.length; i++) {
      const next = toManifold(wasm, world[i], numProp);
      made.push(next);
      acc = acc[method](next);
      made.push(acc);
    }
    const out = acc.getMesh();
    const stride = out.numProp;
    const vertexCount = out.vertProperties.length / stride;
    if (!vertexCount) throw new Error('Boolean: the result is empty');
    const positions = new Float32Array(vertexCount * 3);
    const normals = numProp === 6 ? new Float32Array(vertexCount * 3) : null;
    for (let v = 0; v < vertexCount; v++) {
      positions[v * 3]     = out.vertProperties[v * stride];
      positions[v * 3 + 1] = out.vertProperties[v * stride + 1];
      positions[v * 3 + 2] = out.vertProperties[v * stride + 2];
      if (normals) {
        normals[v * 3]     = out.vertProperties[v * stride + 3];
        normals[v * 3 + 1] = out.vertProperties[v * stride + 4];
        normals[v * 3 + 2] = out.vertProperties[v * stride + 5];
      }
    }
    const tri = out.triVerts;
    const indices = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i += 3) {
      indices[i] = tri[i + 2];
      indices[i + 1] = tri[i + 1];
      indices[i + 2] = tri[i];
    }
    return { positions, normals, indices };
  } finally {
    for (const m of made) { try { m.delete(); } catch { /* already freed */ } }
  }
}
