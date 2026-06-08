// MeshValidator unit tests. Run:
//   node --import ./tests/register-hooks.mjs tests/validator.test.mjs
//
// Focus: the non-manifold check must weld by POSITION first, so an unwelded
// (per-triangle) but topologically closed import does NOT false-positive —
// and the result is a non-blocking WARNING.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { MeshValidator } = await import('../src/core/MeshValidator.js');

// Unit cube scaled to 0.1 m (under the default bed → no exceedsBed noise).
const S = 0.1;
const C = [
  [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
  [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
];
const TRIS = [
  [0, 1, 2], [0, 2, 3],   // z-
  [4, 6, 5], [4, 7, 6],   // z+
  [0, 5, 1], [0, 4, 5],   // y-
  [3, 2, 6], [3, 6, 7],   // y+
  [0, 3, 7], [0, 7, 4],   // x-
  [1, 5, 6], [1, 6, 2],   // x+
];

// Build UNWELDED geometry: every triangle gets its own 3 vertex copies, so
// raw-index topology would scream "non-manifold" on a perfectly closed cube.
function buildMesh(tris) {
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
    name: 'unit',
    getVerticesData: () => new Float32Array(positions),
    getIndices: () => indices,
    getWorldMatrix: () => ({}),
    getBoundingInfo: () => ({ boundingBox: {
      minimumWorld: { x: 0, y: 0, z: 0, subtract: (o) => ({ x: -o.x, y: -o.y, z: -o.z }) },
      maximumWorld: { x: S, y: S, z: S, subtract: () => ({ x: S, y: S, z: S }) },
    } }),
    intersects: () => ({ hit: false }),     // → not inverted
    getTotalVertices: () => positions.length / 3,
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}
const nm = (results) => results.find(r => r.type === 'nonManifold');

await test('closed unwelded cube → NO non-manifold (position weld kills false positive)', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(TRIS));
  assert.equal(nm(results), undefined, `unexpected: ${JSON.stringify(results)}`);
});

await test('cube missing a face → reports a SMALL real boundary count', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(TRIS.slice(0, 11)));
  const r = nm(results);
  assert.ok(r, 'expected a nonManifold result');
  assert.ok(r.count > 0 && r.count <= 10, `expected a few boundary edges, got ${r.count}`);
});

await test('non-manifold is a WARNING, never a blocking error', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(TRIS.slice(0, 11)));
  const r = nm(results);
  assert.equal(r.severity, 'warning');
  assert.equal(MeshValidator.hasErrors(results), false, 'must not hard-block export');
});

await test('inverted-normals check is also non-blocking (warning)', async () => {
  // Force the inverted heuristic on with an always-hit ray.
  const m = buildMesh(TRIS);
  m.intersects = () => ({ hit: true });
  const results = await MeshValidator.validateMesh(m);
  const inv = results.find(r => r.type === 'invertedNormals');
  if (inv) assert.equal(inv.severity, 'warning');
  assert.equal(MeshValidator.hasErrors(results), false);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
