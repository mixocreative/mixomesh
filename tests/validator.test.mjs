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
const { signedVolume }  = await import('../src/core/print/PrintSpace.js');

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

// Reverse every triangle's winding (index flip — same op as the
// 'invertedNormals' auto-fix).
const flip = (tris) => tris.map(([a, b, c]) => [a, c, b]);

// Build UNWELDED geometry: every triangle gets its own 3 vertex copies, so
// raw-index topology would scream "non-manifold" on a perfectly closed cube.
// `sideOrientation` / `material` are optional so a test can mimic Babylon's
// effective orientation (undefined ⇒ CounterClockWise default, 0 ⇒ ClockWise).
function buildMesh(tris, extra = {}) {
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
    intersects: () => ({ hit: false }),
    getTotalVertices: () => positions.length / 3,
    ...extra,
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

// ── Inverted normals: orientation-aware (2026-09-17) ─────────────────────
// Babylon is left-handed. A CounterClockWise-flagged mesh (the default —
// native primitives, OBJ/STL/3MF imports, Boolean results) renders OUTWARD when
// its right-handed signed volume is NEGATIVE (MeshBuilder.CreateBox: -8000 for
// a 20 mm box); a ClockWise-flagged mesh (glTF loader in LH scenes) renders
// outward when it is POSITIVE. The previous unconditional `V < 0 ⇒ inverted`
// pinned the ClockWise rule for every mesh and mis-reported every correct
// CounterClockWise mesh — the old tolerant `if (inv)` test that lived here was
// rewritten to assert the orientation-aware verdict.
const inv = (results) => results.find(r => r.type === 'invertedNormals');
const CLOCKWISE = 0;   // BABYLON.Material.ClockWiseSideOrientation

await test('fixture cube has NEGATIVE right-handed signed volume (Babylon CCW-outward convention)', () => {
  const m = buildMesh(TRIS);
  const v = signedVolume(m.getVerticesData(), m.getIndices());
  assert.ok(v < 0, `expected V < 0, got ${v}`);
  assert.ok(Math.abs(Math.abs(v) - S * S * S) < 1e-9, `|V| should be S³, got ${v}`);
});

await test('CounterClockWise mesh, negative volume → NOT inverted (was a false positive)', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(TRIS));
  assert.equal(inv(results), undefined, `unexpected: ${JSON.stringify(results)}`);
});

await test('CounterClockWise mesh, positive volume → inverted (warning, Auto-Fix message)', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(flip(TRIS)));
  const r = inv(results);
  assert.ok(r, 'flipped CCW cube must be reported inverted');
  assert.equal(r.severity, 'warning');
  assert.equal(r.autoFixAvailable, true);
  assert.equal(MeshValidator.hasErrors(results), false, 'non-blocking');
  assert.ok(!/auto-fixed on export/.test(r.message), 'nothing auto-fixes on export (audit M1)');
  assert.match(r.message, /Auto-Fix/);
});

await test('ClockWise mesh (mesh.sideOrientation), positive volume → NOT inverted', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(flip(TRIS), { sideOrientation: CLOCKWISE }));
  assert.equal(inv(results), undefined, `unexpected: ${JSON.stringify(results)}`);
});

await test('ClockWise mesh (mesh.sideOrientation), negative volume → inverted', async () => {
  const results = await MeshValidator.validateMesh(buildMesh(TRIS, { sideOrientation: CLOCKWISE }));
  assert.ok(inv(results), 'CW-flagged cube with V < 0 must be reported inverted');
});

await test('material.sideOrientation overrides the mesh flag (same rule as PrintSpace)', async () => {
  // CCW mesh flag, but a ClockWise material → effective ClockWise → V < 0 inverted.
  const m = buildMesh(TRIS, { sideOrientation: 1, material: { sideOrientation: CLOCKWISE } });
  assert.ok(inv(await MeshValidator.validateMesh(m)), 'material override must win');
});

await test('ValidateWorker request carries the clockwise flag', async () => {
  const { validateTopologyInWorker } = await import('../src/core/ValidateWorker.js');
  const posted = [];
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(msg) {
      posted.push(msg);
      // Echo a 'done' so the promise settles.
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, type: 'done', badEdgeCount: 0, inverted: false } }));
    }
    terminate() {}
  }
  const prev = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    await validateTopologyInWorker(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), [0, 1, 2], true);
    await validateTopologyInWorker(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), [0, 1, 2]);
  } finally {
    globalThis.Worker = prev;
  }
  assert.equal(posted.length, 2);
  assert.equal(posted[0].clockwise, true, 'explicit true is forwarded');
  assert.equal(posted[1].clockwise, false, 'defaults to false (CounterClockWise)');
  assert.ok(posted[0].positions instanceof Float32Array && posted[0].indices instanceof Uint32Array);
});

await test('worker pure function applies the same orientation rule', async () => {
  // The worker module binds self.onmessage at import; give it a stub `self`.
  const prevSelf = globalThis.self;
  const sent = [];
  globalThis.self = { postMessage: (m) => sent.push(m) };
  try {
    const { checkInvertedNormals } = await import('../src/core/workers/MeshValidate.worker.js');
    const m = buildMesh(TRIS);
    const pos = m.getVerticesData(), idx = m.getIndices();
    assert.equal(checkInvertedNormals(pos, idx, false), false, 'CCW + V<0 → outward');
    assert.equal(checkInvertedNormals(pos, idx, true),  true,  'CW + V<0 → inverted');
    const f = buildMesh(flip(TRIS));
    assert.equal(checkInvertedNormals(f.getVerticesData(), f.getIndices(), false), true,  'CCW + V>0 → inverted');
    assert.equal(checkInvertedNormals(f.getVerticesData(), f.getIndices(), true),  false, 'CW + V>0 → outward');
    // Message path: the flag is read off the request.
    globalThis.self.onmessage({ data: { id: 7, positions: pos, indices: Uint32Array.from(idx), clockwise: true } });
    globalThis.self.onmessage({ data: { id: 8, positions: pos, indices: Uint32Array.from(idx) } });
    assert.deepEqual(sent.map(x => [x.id, x.type, x.inverted]), [[7, 'done', true], [8, 'done', false]]);
  } finally {
    globalThis.self = prevSelf;
  }
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
