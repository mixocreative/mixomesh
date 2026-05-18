// Split-on-import unit tests. Run:
//   node --import ./tests/register-hooks.mjs tests/split-on-import.test.mjs
//
// Verifies the pure split planner exported by AssetLoader. The planner walks
// a container's meshes, detects MultiMaterial sources, and asks the caller's
// factory to mint N siblings — one per subMesh — all stamped with the same
// sourceGroupId. The post-split container is the contract every downstream
// stage (ShaderLibrary, validator, export) expects.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { splitMultiMaterialMeshes } = await import('../core/AssetLoader.js');

// Test fixtures ────────────────────────────────────────────────────────────
const makeMat   = (id) => ({ __mat: id, subMaterials: undefined });
const makeMulti = (subs) => ({ __mat: 'multi', subMaterials: subs });
const makeMesh  = ({ name, material, subMeshes = null }) => ({
  name, material, subMeshes,
  getScene: () => ({}),
  metadata: {},
});
const makeSub = (materialIndex, indexStart, indexCount, vStart = 0, vCount = 0) =>
  ({ materialIndex, indexStart, indexCount, verticesStart: vStart, verticesCount: vCount });

let gid = 0;
const genGroupId = () => `grp_test_${++gid}`;

function makeFactory() {
  const created = [];
  const factory = (spec) => {
    const child = { name: spec.name, material: spec.subMaterial, metadata: { sourceGroupId: spec.groupId }, __spec: spec };
    created.push(child);
    return child;
  };
  return { factory, created };
}

// Tests ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  gid = 0;
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('single-material mesh → passes through unchanged', () => {
  const matA = makeMat('A');
  const mesh = makeMesh({ name: 'plainCube', material: matA });
  const { factory, created } = makeFactory();
  const r = splitMultiMaterialMeshes([mesh], factory, genGroupId);
  assert.deepEqual(r.meshes, [mesh], 'mesh passed through');
  assert.equal(r.disposed.length, 0);
  assert.equal(r.orphanMultiMaterials.length, 0);
  assert.equal(created.length, 0, 'no child factory calls');
});

await test('multi-material mesh with 3 subMeshes → 3 siblings, shared groupId', () => {
  const mA = makeMat('A'), mB = makeMat('B'), mC = makeMat('C');
  const multi = makeMulti([mA, mB, mC]);
  const subs = [
    makeSub(0,  0, 12),  // A → idx [0..12)
    makeSub(1, 12, 18),  // B → idx [12..30)
    makeSub(2, 30,  6),  // C → idx [30..36)
  ];
  const mesh = makeMesh({ name: 'painted', material: multi, subMeshes: subs });

  const { factory, created } = makeFactory();
  const r = splitMultiMaterialMeshes([mesh], factory, genGroupId);

  assert.equal(created.length, 3, '3 children minted');
  assert.equal(r.meshes.length, 3, 'output contains the 3 siblings only');
  assert.deepEqual(r.disposed, [mesh], 'source mesh queued for disposal');
  assert.equal(r.orphanMultiMaterials.length, 1, 'MultiMaterial wrapper orphaned');
  assert.equal(r.orphanMultiMaterials[0], multi);

  // Shared groupId — every child stamps the same id.
  const ids = new Set(created.map(c => c.metadata.sourceGroupId));
  assert.equal(ids.size, 1, `all siblings share one groupId, got ${[...ids].join(',')}`);

  // Sub-material binding — child i ↔ multi.subMaterials[subs[i].materialIndex].
  assert.equal(created[0].material, mA);
  assert.equal(created[1].material, mB);
  assert.equal(created[2].material, mC);

  // Index ranges plumbed verbatim to the factory spec.
  assert.equal(created[0].__spec.indexStart, 0);
  assert.equal(created[0].__spec.indexCount, 12);
  assert.equal(created[1].__spec.indexStart, 12);
  assert.equal(created[1].__spec.indexCount, 18);
  assert.equal(created[2].__spec.indexStart, 30);
  assert.equal(created[2].__spec.indexCount, 6);

  // Names suffixed with __partN so debugging is sane.
  assert.equal(created[0].name, 'painted__part0');
  assert.equal(created[1].name, 'painted__part1');
  assert.equal(created[2].name, 'painted__part2');
});

await test('multi-material mesh with 1 subMesh → unwrap, no split', () => {
  const mA = makeMat('A'), mB = makeMat('B');
  const multi = makeMulti([mA, mB]);
  const subs = [ makeSub(1, 0, 36) ];   // single subMesh pointing at B
  const mesh = makeMesh({ name: 'singleSub', material: multi, subMeshes: subs });

  const { factory, created } = makeFactory();
  const r = splitMultiMaterialMeshes([mesh], factory, genGroupId);

  assert.equal(created.length, 0, 'no children — unwrap path');
  assert.equal(r.meshes.length, 1, 'mesh passed through');
  assert.equal(r.meshes[0], mesh);
  assert.equal(mesh.material, mB, 'material rewritten to the singular sub-material');
  assert.equal(r.disposed.length, 0);
  assert.deepEqual(r.orphanMultiMaterials, [multi]);
});

await test('multi-material mesh with no subMeshes → unwrap to first sub-material', () => {
  const mA = makeMat('A'), mB = makeMat('B');
  const multi = makeMulti([mA, mB]);
  const mesh = makeMesh({ name: 'noSubs', material: multi, subMeshes: [] });

  const { factory, created } = makeFactory();
  const r = splitMultiMaterialMeshes([mesh], factory, genGroupId);

  assert.equal(created.length, 0);
  assert.equal(mesh.material, mA, 'falls back to subMaterials[0]');
  assert.deepEqual(r.orphanMultiMaterials, [multi]);
});

await test('mixed batch — splits only the multi, leaves singles alone', () => {
  const mA = makeMat('A'), mB = makeMat('B'), mX = makeMat('X');
  const multi = makeMulti([mA, mB]);
  const m1 = makeMesh({ name: 'lone', material: mX });
  const m2 = makeMesh({ name: 'painted', material: multi, subMeshes: [makeSub(0, 0, 6), makeSub(1, 6, 6)] });
  const m3 = makeMesh({ name: 'noMat', material: null });

  const { factory, created } = makeFactory();
  const r = splitMultiMaterialMeshes([m1, m2, m3], factory, genGroupId);

  assert.equal(created.length, 2, 'two siblings from the only multi');
  assert.equal(r.meshes.length, 4, '1 lone + 2 siblings + 1 noMat');
  assert.ok(r.meshes.includes(m1));
  assert.ok(r.meshes.includes(m3));
  assert.ok(!r.meshes.includes(m2), 'split source no longer in output');
  assert.deepEqual(r.disposed, [m2]);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
