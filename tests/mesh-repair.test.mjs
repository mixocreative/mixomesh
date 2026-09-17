import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const R = await import('../src/core/repair/MeshRepair.js');

let passed = 0, failed = 0; const out = [];
async function test(name, fn) { try { await fn(); out.push(`PASS  ${name}`); passed++; } catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; } }

function fakeMesh(positions, indices, uvs = null) {
  const data = { position: Float32Array.from(positions), uv: uvs ? Float32Array.from(uvs) : null };
  let idx = Array.from(indices);
  return {
    name: 'm', sideOrientation: 1, material: null,
    getVerticesData: (k) => data[k], getIndices: () => idx,
    setVerticesData: (k, v) => { data[k] = Float32Array.from(v); },
    setIndices: (v) => { idx = Array.from(v); },
    createNormals() {}, refreshBoundingInfo() {},
    getTotalVertices: () => data.position.length / 3,
  };
}
// Open tetra: three faces, one missing → 3 boundary edges.
const OPEN_POS = [0,0,0, 10,0,0, 0,20,0, 0,0,30];
const OPEN_IDX = [0,2,1, 0,1,3, 0,3,2];

await test('meshToArrays / arraysToMesh round-trip and UV re-attachment by nearest vertex', () => {
  const m = fakeMesh(OPEN_POS, OPEN_IDX, [0,0, 1,0, 0,1, 1,1]);
  const { V, T } = R.meshToArrays(m);
  assert.deepEqual(V[1], [10, 0, 0]); assert.deepEqual(T[0], [0, 2, 1]);
  // engine output: same vertices reordered + one new triangle closing the hole
  const V2 = [V[3], V[0], V[1], V[2]]; const T2 = [[1,3,2],[1,2,0],[1,0,3],[2,3,0]];
  R.arraysToMesh(m, V2, T2, Float32Array.from(OPEN_POS), Float32Array.from([0,0, 1,0, 0,1, 1,1]));
  assert.equal(m.getTotalVertices(), 4);
  assert.deepEqual(Array.from(m.getVerticesData('uv')).slice(0, 2), [1, 1], 'first new vertex (was #3) got vertex #3 UVs');
  assert.equal(m.getIndices().length, 12);
});

await test('repairMesh uses the engine, reports holesFilled and watertight, refuses over the cap', async () => {
  R.__test.setEngine({
    diagnose: (V, T) => ({ v: V.length, t: T.length, boundary: 3, nonManifold: 0, windingInconsistencies: 0, oppositeWindingPairs: 0, components: 1, isWatertight: false }),
    repairObject: async (V, T) => ({ V, T: [...T, [1, 2, 3]], report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 } }),
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  const d = await R.diagnoseMesh(m);
  assert.equal(d.boundaryEdges, 3); assert.equal(d.isWatertight, false);
  const r = await R.repairMesh(m);
  assert.equal(r.holesFilled, 1); assert.equal(r.changed, true); assert.equal(m.getIndices().length, 12);
  const big = fakeMesh(OPEN_POS, new Array(R.REPAIR_TRIANGLE_CAP * 3 + 3).fill(0));
  await assert.rejects(R.repairMesh(big), /too large to repair in the browser/);
});

console.log('\n' + out.join('\n')); console.log(`\n${passed} passed, ${failed} failed\n`); process.exit(failed ? 1 : 0);
