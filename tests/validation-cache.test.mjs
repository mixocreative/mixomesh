// Validation result cache (arch review A6). Results live in
// state.scene.validation keyed by meshId: { results, validatedAt, stale }.
// Written by MeshValidator, marked stale on transform/update, dropped on
// remove, cleared on new/load. Export-clone validation must NOT pollute the
// cache (clones carry the source meshId in metadata but are not the live
// registered mesh).
//   node --import ./tests/register-hooks.mjs tests/validation-cache.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { AssetLoader }   = await import('../src/core/AssetLoader.js');
const { setState, getState, dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

MeshValidator.init();

// ── Open-shell fixture (guaranteed nonManifold warning) ──────────────────
const S = 0.1;
const C = [
  [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
  [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
];
const LO_TRIS = [
  [0, 1, 2], [0, 2, 3],
  [0, 5, 1], [0, 4, 5],
  [0, 3, 7], [0, 7, 4],
];
const HI_TRIS = [
  [4, 6, 5], [4, 7, 6],
  [3, 2, 6], [3, 6, 7],
  [1, 5, 6], [1, 6, 2],
];

function buildMesh(name, tris, meshId = name) {
  const positions = [];
  const indices = [];
  let n = 0;
  for (const [a, b, c] of tris) {
    for (const idx of [a, b, c]) {
      positions.push(C[idx][0], C[idx][1], C[idx][2]);
      indices.push(n++);
    }
  }
  return {
    name,
    metadata: { meshId },
    getVerticesData: () => new Float32Array(positions),
    getIndices: () => indices,
    getWorldMatrix: () => ({}),
    getBoundingInfo: () => ({ boundingBox: {
      minimumWorld: { x: 0, y: 0, z: 0, subtract: (o) => ({ x: -o.x, y: -o.y, z: -o.z }) },
      maximumWorld: { x: S, y: S, z: S, subtract: () => ({ x: S, y: S, z: S }) },
    } }),
    intersects: () => ({ hit: false }),
    getTotalVertices: () => positions.length / 3,
  };
}

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

function seedState(objects) {
  meshes.clear();
  for (const o of objects) if (o.mesh) meshes.set(o.id, o.mesh);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      validation: {},
      objects: Object.fromEntries(objects.map(o => [o.id, {
        id: o.id, name: o.id, sourceGroupId: o.sourceGroupId ?? null,
        isGhost: false, isPrintPart: true,
      }])),
    },
  }), { silent: true });
}

const cache = (id) => getState().scene.validation[id];

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('freshState carries the validation slot', async () => {
  const { freshState } = await import('../src/core/StateManager.js');
  assert.deepEqual(freshState().scene.validation, {});
});

await test('validateMesh caches results under the live meshId', async () => {
  const m = buildMesh('Shell__part0', LO_TRIS, 'mesh_v1');
  seedState([{ id: 'mesh_v1', mesh: m }]);
  const results = await MeshValidator.validateMesh(m);
  assert.ok(results.length > 0, 'open shell must warn');
  const e = cache('mesh_v1');
  assert.ok(e, 'cache entry written');
  assert.equal(e.stale, false);
  assert.equal(e.results.length, results.length);
});

await test('group routing caches the union result under EVERY sibling', async () => {
  const lo = buildMesh('p0', LO_TRIS, 'mesh_g1');
  const hi = buildMesh('p1', HI_TRIS, 'mesh_g2');
  seedState([
    { id: 'mesh_g1', sourceGroupId: 'grpA', mesh: lo },
    { id: 'mesh_g2', sourceGroupId: 'grpA', mesh: hi },
  ]);
  await MeshValidator.validateMesh(lo);
  assert.ok(cache('mesh_g1'), 'routed sibling cached');
  assert.ok(cache('mesh_g2'), 'other sibling cached too (Blueprint §9)');
  assert.equal(cache('mesh_g2').results.length, 0, 'closed union → clean results');
});

await test('export-clone validation does NOT pollute the cache', async () => {
  const live = buildMesh('Live', LO_TRIS, 'mesh_live');
  seedState([{ id: 'mesh_live', mesh: live }]);
  // A clone carries the same metadata.meshId but is NOT the registered mesh.
  const clone = buildMesh('Live__export', HI_TRIS, 'mesh_live');
  await MeshValidator.validateMesh(clone);
  assert.equal(cache('mesh_live'), undefined,
    'clone results must not be written under the live id');
});

await test('TRANSFORM_COMMITTED marks entries stale (results kept)', async () => {
  const m = buildMesh('S2', LO_TRIS, 'mesh_v2');
  seedState([{ id: 'mesh_v2', mesh: m }]);
  await MeshValidator.validateMesh(m);
  dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: ['mesh_v2'] });
  const e = cache('mesh_v2');
  assert.equal(e.stale, true, 'stale after transform');
  assert.ok(e.results.length > 0, 'old results retained for display');
});

await test('OBJECT_REMOVED drops the entry; PROJECT_NEW clears everything', async () => {
  const m = buildMesh('S3', LO_TRIS, 'mesh_v3');
  seedState([{ id: 'mesh_v3', mesh: m }]);
  await MeshValidator.validateMesh(m);
  dispatch(EVENTS.OBJECT_REMOVED, { id: 'mesh_v3' });
  assert.equal(cache('mesh_v3'), undefined, 'removed object → entry dropped');

  seedState([{ id: 'mesh_v3', mesh: m }]);
  await MeshValidator.validateMesh(m);
  dispatch(EVENTS.PROJECT_NEW, {});
  assert.deepEqual(getState().scene.validation, {}, 'new project → cache cleared');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
