// Group-aware validator tests. Run:
//   node --import ./tests/register-hooks.mjs tests/validator-group.test.mjs
//
// Import splits MultiMaterial meshes into N siblings stamped with
// the same sourceGroupId. Each shell is non-watertight by construction, so
// the per-mesh topology check would always scream. validateGroup welds the
// siblings' world-space positions back into one body and runs the manifold
// check on the union.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { AssetLoader }   = await import('../src/core/AssetLoader.js');
const { setState }      = await import('../src/core/StateManager.js');

// ── Closed unit cube split into two material groups ─────────────────────
// Same 8 vertex positions across both halves. Each half holds a subset of
// the 12 cube triangles — open on its own, but position-welding in
// _checkNonManifold rejoins them into the closed cube.
const S = 0.1;
const C = [
  [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
  [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
];

// Material A: bottom + two adjacent side caps (6 triangles).
const LO_TRIS = [
  [0, 1, 2], [0, 2, 3],   // z-
  [0, 5, 1], [0, 4, 5],   // y-
  [0, 3, 7], [0, 7, 4],   // x-
];
// Material B: complementary 6 triangles. Union = closed cube.
const HI_TRIS = [
  [4, 6, 5], [4, 7, 6],   // z+
  [3, 2, 6], [3, 6, 7],   // y+
  [1, 5, 6], [1, 6, 2],   // x+
];

function buildHalfMesh(name, tris) {
  // Unwelded — each triangle gets its own 3 vertex copies. Position-welding
  // in _checkNonManifold rejoins the seam across siblings.
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

// Stub the AssetLoader.getBabylonMesh lookup. Public API hangs off the
// exported object, so monkey-patch is the simplest seam.
const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

function seedState(objects) {
  meshes.clear();
  for (const o of objects) if (o.mesh) meshes.set(o.id, o.mesh);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: Object.fromEntries(objects.map(o => [o.id, {
        id: o.id,
        name: o.id,
        sourceGroupId: o.sourceGroupId ?? null,
        isGhost: false,
        isPrintPart: true,
      }])),
    },
  }), { silent: true });
}

// Tests ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}
const nm = (results) => results.find(r => r.type === 'nonManifold');

await test('split clean cube → group union is watertight (no nonManifold)', async () => {
  const lo = buildHalfMesh('lo', LO_TRIS);
  const hi = buildHalfMesh('hi', HI_TRIS);
  seedState([
    { id: 'lo', sourceGroupId: 'grp_1', mesh: lo },
    { id: 'hi', sourceGroupId: 'grp_1', mesh: hi },
  ]);
  const results = await MeshValidator.validateGroup('grp_1');
  assert.equal(nm(results), undefined,
    `welded union should be closed; got ${JSON.stringify(results)}`);
});

await test('one half alone (group of 1) → reports the seam as non-manifold', async () => {
  const lo = buildHalfMesh('lo', LO_TRIS);
  seedState([{ id: 'lo', sourceGroupId: 'grp_solo', mesh: lo }]);
  const results = await MeshValidator.validateGroup('grp_solo');
  const r = nm(results);
  assert.ok(r, 'open shell should flag a boundary');
  assert.ok(r.count > 0, `expected boundary edges, got count=${r?.count}`);
  assert.equal(r.scope, 'group');
  assert.equal(r.sourceGroupId, 'grp_solo');
});

await test('broken group (missing a face on lower half) → still flags non-manifold', async () => {
  const loBroken = buildHalfMesh('lo', LO_TRIS.slice(0, LO_TRIS.length - 1));   // drop a +X tri
  const hi = buildHalfMesh('hi', HI_TRIS);
  seedState([
    { id: 'lo', sourceGroupId: 'grp_2', mesh: loBroken },
    { id: 'hi', sourceGroupId: 'grp_2', mesh: hi },
  ]);
  const results = await MeshValidator.validateGroup('grp_2');
  const r = nm(results);
  assert.ok(r, 'missing-face union must flag a boundary');
  assert.ok(r.count > 0 && r.count <= 6, `small boundary edge count, got ${r?.count}`);
});

await test('validateMesh on grouped sibling routes through the group path', async () => {
  const lo = buildHalfMesh('lo', LO_TRIS);
  const hi = buildHalfMesh('hi', HI_TRIS);
  seedState([
    { id: 'lo', sourceGroupId: 'grp_route', mesh: lo },
    { id: 'hi', sourceGroupId: 'grp_route', mesh: hi },
  ]);
  // Per-mesh check on `lo` alone would scream; via group routing it stays silent.
  const results = await MeshValidator.validateMesh(lo);
  assert.equal(nm(results), undefined,
    `routing on a grouped sibling should hit the union, got ${JSON.stringify(results)}`);
});

await test('validateAllPrintParts dedupes by sourceGroupId', async () => {
  const lo = buildHalfMesh('lo', LO_TRIS);
  const hi = buildHalfMesh('hi', HI_TRIS);
  seedState([
    { id: 'lo', sourceGroupId: 'grp_dedup', mesh: lo },
    { id: 'hi', sourceGroupId: 'grp_dedup', mesh: hi },
  ]);
  const map = await MeshValidator.validateAllPrintParts();
  // Only one of the two siblings produces an entry — the other is collapsed.
  assert.equal(map.size, 1, `dedup should yield 1 entry, got ${map.size}`);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
