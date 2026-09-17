// The shared vertex weld (review I6). Run:
//   node --import ./tests/register-hooks.mjs tests/weld.test.mjs
//
// Babylon 9.6.2 has NEITHER `Mesh.mergeVerticesByDistance` NOR
// `VertexData.MergeByDistance`, so both previous weld call sites
// (MeshValidator's offline `nonManifold` fix and the OBJ/STL/3MF `weld` prep
// step) were dead code that silently did nothing. These tests pin the real
// implementation — including the rule that makes it safe to run
// unconditionally on the export path: a UV seam is never merged (review C1).

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { weldMesh, WELD_DISTANCE } = await import('../src/core/repair/Weld.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

/** Duck-typed mesh holding real buffers, per attribute kind. */
function fakeMesh(kinds, indices) {
  const data = {};
  for (const [k, v] of Object.entries(kinds)) data[k] = Float32Array.from(v);
  let idx = Array.from(indices);
  return {
    name: 'w',
    getVerticesData: (k) => data[k],
    getIndices: () => idx,
    setVerticesData: (k, v) => { data[k] = Float32Array.from(v); },
    setIndices: (v) => { idx = Array.from(v); },
    refreshBoundingInfo() {},
  };
}

/** Undirected edge → how many triangles use it, over RAW indices. */
function edgeMap(mesh) {
  const idx = mesh.getIndices();
  const m = new Map();
  for (let i = 0; i + 2 < idx.length; i += 3) {
    for (const [a, b] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  return m;
}

// Two triangles sharing the (0,0,0)-(1,1,0) edge, each with its OWN copies of
// the shared vertices — the shape every glTF/STL import arrives in.
const UNWELDED_POS = [0,0,0, 1,0,0, 1,1,0,   0,0,0, 1,1,0, 0,1,0];
const UNWELDED_IDX = [0,1,2, 3,4,5];

await test('I6: two unwelded copies of a shared edge become ONE edge used by two faces', () => {
  const m = fakeMesh({ position: UNWELDED_POS }, UNWELDED_IDX);
  assert.equal([...edgeMap(m).values()].filter(n => n === 2).length, 0,
    'before the weld no edge is shared — the two copies are separate vertices');

  assert.equal(weldMesh(m), true, 'the weld reports that it changed the geometry');
  assert.equal(m.getVerticesData('position').length / 3, 4, '6 vertices → 4');
  assert.equal(m.getIndices().length, 6, 'both triangles survive');
  const shared = [...edgeMap(m).entries()].filter(([, n]) => n === 2);
  assert.equal(shared.length, 1, `exactly one shared edge, got ${JSON.stringify(shared)}`);
});

// C1 lock: the export prep runs this step unconditionally on OBJ/STL, so a
// weld that merged seam duplicates would tear every textured part's UVs.
await test('C1: vertices that share a position but NOT a UV are never merged', () => {
  const uvs = [0,0, 1,0, 1,1,   0.5,0, 0.5,1, 0,1];   // seam: two UVs per shared position
  const m = fakeMesh({ position: UNWELDED_POS, uv: uvs }, UNWELDED_IDX);
  assert.equal(weldMesh(m), false, 'nothing to merge — the duplicates are a real UV seam');
  assert.deepEqual(Array.from(m.getVerticesData('position')), UNWELDED_POS, 'positions untouched');
  assert.deepEqual(Array.from(m.getVerticesData('uv')), uvs, 'UVs byte-identical');
  assert.deepEqual(m.getIndices(), UNWELDED_IDX, 'indices untouched');
});

await test('vertices sharing BOTH position and UV are merged, and the UV buffer stays in step', () => {
  const uvs = [0,0, 1,0, 1,1,   0,0, 1,1, 0,1];   // same UVs on the shared edge
  const m = fakeMesh({ position: UNWELDED_POS, uv: uvs }, UNWELDED_IDX);
  assert.equal(weldMesh(m), true);
  const pos = m.getVerticesData('position');
  const uv = m.getVerticesData('uv');
  assert.equal(pos.length / 3, 4);
  assert.equal(uv.length / 2, 4, 'the UV buffer is remapped to the new vertex count, never left stale');
  // Every (position, uv) pair that existed still exists.
  const pairs = new Set();
  for (let i = 0; i < 4; i++) pairs.add(`${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}|${uv[i * 2]},${uv[i * 2 + 1]}`);
  assert.deepEqual([...pairs].sort(), [
    '0,0,0|0,0', '0,1,0|0,1', '1,0,0|1,0', '1,1,0|1,1',
  ]);
});

await test('every present attribute is remapped alongside position (no stale buffer lengths)', () => {
  const normals = [0,0,1, 0,0,1, 0,0,1,  0,0,1, 0,0,1, 0,0,1];
  const m = fakeMesh({ position: UNWELDED_POS, normal: normals }, UNWELDED_IDX);
  assert.equal(weldMesh(m), true);
  assert.equal(m.getVerticesData('normal').length / 3, 4, 'normals follow the compacted vertex list');
  assert.equal(m.getVerticesData('uv'), undefined, 'an absent attribute is not invented');
});

await test('triangles that collapse under the weld are dropped', () => {
  // Third "triangle" is two copies of one position plus a third point → it
  // becomes degenerate (two identical corners) once welded.
  const pos = [...UNWELDED_POS, 0,0,0, 0,0,0, 1,0,0];
  const idx = [...UNWELDED_IDX, 6, 7, 8];
  const m = fakeMesh({ position: pos }, idx);
  assert.equal(weldMesh(m), true);
  assert.equal(m.getIndices().length, 6, 'the degenerate triangle is gone, the two real ones remain');
});

await test('an already-welded mesh is left completely alone (returns false, no write)', () => {
  const pos = [0,0,0, 1,0,0, 1,1,0, 0,1,0];
  const idx = [0,1,2, 0,2,3];
  const m = fakeMesh({ position: pos }, idx);
  const before = m.getVerticesData('position');
  assert.equal(weldMesh(m), false);
  assert.equal(m.getVerticesData('position'), before, 'the very same buffer instance — nothing was rewritten');
  assert.deepEqual(m.getIndices(), idx);
});

await test('the merge distance is honoured: sub-tolerance neighbours merge, larger gaps do not', () => {
  const eps = WELD_DISTANCE / 10;
  const near = fakeMesh({ position: [0,0,0, 1,0,0, 1,1,0,  eps,0,0, 1,1,0, 0,1,0] }, UNWELDED_IDX);
  assert.equal(weldMesh(near), true);
  assert.equal(near.getVerticesData('position').length / 3, 4, 'a 0.01 mm gap welds');

  const far = fakeMesh({ position: [0,0,0, 1,0,0, 1,1,0,  0.01,0,0, 1,1,0, 0,1,0] }, UNWELDED_IDX);
  weldMesh(far);
  assert.equal(far.getVerticesData('position').length / 3, 5,
    'a 10 mm gap is a real gap — only the (1,1,0) pair welds');
});

await test('a mesh with no geometry is a no-op, never a throw', () => {
  assert.equal(weldMesh(fakeMesh({ position: [] }, [])), false);
  assert.equal(weldMesh({}), false);
  assert.equal(weldMesh(null), false);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
