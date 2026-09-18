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
const { AssetLoader }   = await import('../src/core/AssetLoader.js');
const { getState, setState, dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');

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
  let positions = [];
  let indices = [];
  let n = 0;
  for (const [a, b, c] of tris) {
    for (const idx of [a, b, c]) {
      positions.push(C[idx][0], C[idx][1], C[idx][2]);
      indices.push(n++);
    }
  }
  return {
    name: 'unit',
    // Only the kinds a real mesh in this fixture carries answer: 'position'
    // (no normals/UVs/colors here). T3: an "answer anything" stub let the
    // shared weld believe every attribute was present and remap garbage.
    // Stateful so a repair/weld write-back (setVerticesData/setIndices) is
    // visible to a later getIndices()/getVerticesData() call.
    getVerticesData: (kind = 'position') => (kind === 'position' ? new Float32Array(positions) : undefined),
    getIndices: () => indices,
    setVerticesData: (kind, data) => { if (kind === 'position') positions = Array.from(data); },
    setIndices: (data) => { indices = Array.from(data); },
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

let _workerOnMessage = null;
await test('worker weld key is exact: a closed 10 mm cube has 0 non-manifold edges (was 1 from 63-bit key overflow)', async () => {
  // Regression 2026-09-18: the packed weld key used 3 × 21 bits (63 bits),
  // past JS's 53-bit exact integers, so vertices differing only in z by
  // < ~10 cm collided and welded — a closed cube read as non-manifold and
  // every real model's count was garbage.
  const prevSelf = globalThis.self;
  const sent = [];
  globalThis.self = { postMessage: (m) => sent.push(m) };
  try {
    await import('../src/core/workers/MeshValidate.worker.js');
    // The module binds self.onmessage ONCE at first import — keep it for
    // the orientation test below, which runs on the same cached module.
    _workerOnMessage = globalThis.self.onmessage;
    const s = 0.01;   // 10 mm in BU
    const positions = Float32Array.from([0,0,0, s,0,0, s,s,0, 0,s,0, 0,0,s, s,0,s, s,s,s, 0,s,s]);
    const indices = Uint32Array.from([0,2,1,0,3,2, 4,5,6,4,6,7, 0,5,4,0,1,5, 1,6,5,1,2,6, 2,7,6,2,3,7, 3,4,7,3,0,4]);
    globalThis.self.onmessage({ data: { id: 1, positions, indices, clockwise: false } });
    assert.equal(sent[0].type, 'done');
    assert.equal(sent[0].badEdgeCount, 0, 'closed cube must have 0 bad edges');
    // Two vertices that differ ONLY in z by 10 mm must stay distinct: an
    // open quad on top of a closed cube's face would otherwise weld into it.
    const p2 = Float32Array.from([0,0,0, s,0,0, 0,s,0, 0,0,s, s,0,s, 0,s,s]);
    const i2 = Uint32Array.from([0,1,2, 3,4,5]);
    globalThis.self.onmessage({ data: { id: 2, positions: p2, indices: i2, clockwise: false } });
    assert.equal(sent[1].badEdgeCount, 6, 'two separate open triangles = 6 boundary edges, none welded away');
    // Far-away coordinates (outside ±6.5 m) still work via the string-key fallback.
    const p3 = Float32Array.from(positions.map(v => v + 20));
    globalThis.self.onmessage({ data: { id: 3, positions: p3, indices, clockwise: false } });
    assert.equal(sent[2].badEdgeCount, 0, 'out-of-range coordinates: closed cube still 0 bad edges');
  } finally {
    globalThis.self = prevSelf;
  }
});

await test('worker pure function applies the same orientation rule', async () => {
  // The worker module binds self.onmessage at import; give it a stub `self`.
  const prevSelf = globalThis.self;
  const sent = [];
  globalThis.self = { postMessage: (m) => sent.push(m), onmessage: _workerOnMessage };
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

// ── holes (MeshRepair engine) 2026-09-17 ─────────────────────────────────
await test('open mesh → holes warning with count, auto-fix available', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine({ diagnose: () => ({ boundary: 3, nonManifold: 0, components: 1, isWatertight: false }), repairObject: async (V, T) => ({ V, T: [...T, [1,2,3]], report: { holesFilled: 1 } }) });
  const m = buildMesh([[0,2,1],[0,1,3],[0,3,2]]);           // 3 of 4 tetra faces
  const results = await MeshValidator.validateMesh(m);
  const holes = results.find(r => r.type === 'holes');
  assert.ok(holes, 'holes reported'); assert.equal(holes.count, 3); assert.equal(holes.autoFixAvailable, true);
  await MeshValidator.autoFix(m, results);
  assert.equal(m.getIndices().length, 12, 'engine closed the hole');
  assert.equal(holes.fixed, true);
});
// I4: the validator's own badEdgeCount is boundary edges PLUS non-manifold
// edges, so using it as the offline `holes` count reported the very same
// edges twice — once as nonManifold, once as holes. Offline, only
// nonManifold speaks; `holes` requires an engine answer.
await test('engine unavailable → NO holes result (no double-count), nonManifold still speaks', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine(null);
  const m = buildMesh([[0,2,1],[0,1,3],[0,3,2]]);
  const results = await MeshValidator.validateMesh(m);
  assert.equal(results.find(r => r.type === 'holes'), undefined,
    `holes must not be emitted without an engine answer: ${JSON.stringify(results)}`);
  const open = nm(results);
  assert.ok(open, 'nonManifold is the only open-geometry result offline');
  assert.ok(open.count > 0);
});

// I3 / CIA F6: above the repair cap the engine refuses to diagnose (I2), so
// no Auto-Fix may be offered — a button whose only outcome is
// "too large to repair" is not a fix — and the message says why.
await test('above REPAIR_TRIANGLE_CAP → no Auto-Fix offered and the message says why', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  let diagnoseCalls = 0;
  R.__test.setEngine({
    diagnose: () => { diagnoseCalls++; return { boundary: 3, nonManifold: 0, components: 1, isWatertight: false }; },
    repairObject: async (V, T) => ({ V, T, report: {} }),
  });
  // Three real (open-tetra) triangles + degenerate padding to clear the cap.
  // Degenerate triangles are skipped by the topology pass, so badEdgeCount
  // still reflects the three real faces.
  const m = buildMesh([[0, 2, 1], [0, 1, 3], [0, 3, 2]]);
  const realIndices = m.getIndices();
  const padded = [...realIndices];
  while (padded.length / 3 <= R.REPAIR_TRIANGLE_CAP) padded.push(0, 0, 0);
  m.getIndices = () => padded;

  const results = await MeshValidator.validateMesh(m);
  assert.equal(diagnoseCalls, 0, 'diagnose is never even attempted above the cap');
  assert.equal(results.find(r => r.type === 'holes'), undefined, 'no engine answer → no holes result');
  const open = nm(results);
  assert.ok(open, 'nonManifold still reported');
  assert.equal(open.autoFixAvailable, false, 'Auto-Fix withheld above the repair cap');
  assert.match(open.message, /too large to repair/);
});

// I6: the offline fallback is a REAL weld now (src/core/repair/Weld.js).
// The old test injected a fake `mergeVerticesByDistance` — an API Babylon
// 9.6.2 does not have — so it proved nothing about the shipped code path.
await test('engine unavailable + nonManifold → autoFix runs the REAL shared weld, no throw', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine(null);
  const m = buildMesh(TRIS.slice(0, 11));
  const before = m.getVerticesData('position').length / 3;
  assert.equal(before, 33, 'fixture is fully unwelded: 11 triangles x 3 own copies');
  const results = await MeshValidator.validateMesh(m);
  const r = nm(results);
  assert.ok(r, 'expected a nonManifold result');
  assert.equal(r.autoFixAvailable, true, 'weld fallback keeps this available offline');
  await MeshValidator.autoFix(m, results);
  assert.equal(r.fixed, true);
  const after = m.getVerticesData('position').length / 3;
  assert.ok(after < before, `weld must compact the vertex buffer (${before} → ${after})`);
  assert.equal(after, 8, 'the 11 faces of a unit cube share exactly 8 corners');
  assert.equal(m.getIndices().length, 33, 'every triangle survives (none were degenerate)');
});

// ── repairObject (Task 3): one-click repair shared by every entry point ──
await test('repairObject: fills holes, records geometryFixes, dirties, re-validates clean', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  let repaired = false;
  R.__test.setEngine({
    diagnose: () => ({ boundary: repaired ? 0 : 3, nonManifold: 0, components: 1, isWatertight: repaired }),
    repairObject: async (V, T) => { repaired = true; return { V, T: [...T, [1, 2, 3]], report: { holesFilled: 1 } }; },
  });

  const m = buildMesh([[0, 2, 1], [0, 1, 3], [0, 3, 2]]);   // 3 of 4 tetra faces (open)
  m.metadata = { meshId: 'm1' };
  AssetLoader.getBabylonMesh = (id) => (id === 'm1' ? m : null);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, m1: { id: 'm1', name: 'm1', isPrintPart: true, isGhost: false } } },
  }), { silent: true });

  PersistenceManager.init();
  dispatch(EVENTS.PROJECT_SAVED, {});
  assert.equal(PersistenceManager.isDirty(), false, 'clean before repair');

  const { holesFilled, remaining } = await MeshValidator.repairObject('m1');

  assert.ok(holesFilled > 0, 'holesFilled reported');
  assert.ok(getState().scene.objects.m1.geometryFixes.includes('holes'), 'geometryFixes records the applied fix');
  assert.equal(PersistenceManager.isDirty(), true, 'repair dirties the project (M4)');
  assert.equal(remaining.find(r => r.type === 'holes'), undefined, 'remaining has no holes after repair');
});

// I7a: a multi-part logical object (MultiMaterial split / glTF
// multi-primitive) validates as the welded UNION, and the union is synthetic
// geometry no fix can be applied to — so group results carry
// autoFixAvailable:false and the old validate→autoFix route left these
// objects PERMANENTLY unrepairable. repairObject now walks the parts.
await test('repairObject: a MULTI-PART object is repaired as ONE solid on its welded union, each part keeps its own triangles', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine({
    // Boundary edges = edges used once. The open tetra (3 faces) has 3;
    // the engine "fix" adds the missing 4th face and closes it.
    diagnose: (_V, T) => {
      const use = new Map();
      for (const [a, b, c] of T) for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = x < y ? `${x}-${y}` : `${y}-${x}`; use.set(k, (use.get(k) ?? 0) + 1); }
      const boundary = [...use.values()].filter(n => n === 1).length;
      return { boundary, nonManifold: 0, components: 1, isWatertight: boundary === 0 };
    },
    repairObject: async (V, T) => ({
      V: V.map(v => [...v]),
      T: [...T.map(t => [...t]), [1, 2, 3]],
      report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 },
    }),
  });

  // One open tetra split across two "material" parts: p1 owns two faces,
  // p2 owns one. Per-part repair would have capped BOTH parts' seams
  // (two closed shells with an internal wall); the union repair adds the
  // one missing face only.
  const p1 = buildMesh([[0, 2, 1], [0, 1, 3]]); p1.metadata = { meshId: 'p1' };
  const p2 = buildMesh([[0, 3, 2]]);            p2.metadata = { meshId: 'p2' };
  const meshes = { p1, p2 };
  AssetLoader.getBabylonMesh = (id) => meshes[id] ?? null;
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: {
        p1: { id: 'p1', name: 'lead', isPrintPart: true, isGhost: false, logicalObjectId: 'p1' },
        p2: { id: 'p2', name: 'part-2', isPrintPart: true, isGhost: false, logicalObjectId: 'p1', isInternalPart: true },
      },
    },
  }), { silent: true });

  const res = await MeshValidator.repairObject('p1');
  assert.deepEqual(res.applied, ['groupRepair']);
  assert.equal(res.holesFilled, 1, "the ENGINE's own counter for the ONE union repair — not summed per part");
  assert.ok(getState().scene.objects.p1.geometryFixes?.includes('groupRepair'), 'part 1 recorded the group fix');
  assert.ok(getState().scene.objects.p2.geometryFixes?.includes('groupRepair'), 'part 2 recorded the group fix');
  const t1 = p1.getIndices().length / 3, t2 = p2.getIndices().length / 3;
  assert.equal(t1 + t2, 4, `union has exactly 4 faces after the repair (no seam caps), got ${t1} + ${t2}`);
  assert.ok(t1 >= 2 && t2 >= 1, 'every part kept its own original triangles');
});

// I7b: a repair that changes nothing must be reported as "nothing to repair",
// never as success — `applied` is the signal every caller keys on.
await test('repairObject: a healthy object reports applied:[] (callers must not toast success)', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  let repairCalls = 0;
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V, T) => { repairCalls++; return { V, T, report: {} }; },
  });
  const m = buildMesh(TRIS);   // closed cube — nothing to fix
  m.metadata = { meshId: 'ok1' };
  AssetLoader.getBabylonMesh = (id) => (id === 'ok1' ? m : null);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ok1: { id: 'ok1', name: 'ok1', isPrintPart: true, isGhost: false } } },
  }), { silent: true });

  const res = await MeshValidator.repairObject('ok1');
  assert.deepEqual(res.applied, [], 'nothing was applied');
  assert.equal(res.holesFilled, 0);
  assert.equal(repairCalls, 0, 'a healthy mesh is never handed to the repair engine');
  assert.equal(getState().scene.objects.ok1.geometryFixes, undefined, 'no fix recorded');
});

await test('repairObjects: a batch where nothing needed fixing reports repaired:0', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V, T) => ({ V, T, report: {} }),
  });
  const a = buildMesh(TRIS); a.metadata = { meshId: 'a' };
  const b = buildMesh(TRIS); b.metadata = { meshId: 'b' };
  const meshes = { a, b };
  AssetLoader.getBabylonMesh = (id) => meshes[id] ?? null;
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: {
      a: { id: 'a', name: 'a', isPrintPart: true, isGhost: false },
      b: { id: 'b', name: 'b', isPrintPart: true, isGhost: false },
    } },
  }), { silent: true });
  const res = await MeshValidator.repairObjects(['a', 'b']);
  assert.equal(res.repaired, 0, 'no object was changed → callers must NOT show a success toast');
  assert.equal(res.failed.length, 0);
});

await test('repairObject: missing mesh tolerates gracefully (no throw, empty remaining)', async () => {
  AssetLoader.getBabylonMesh = () => null;
  const res = await MeshValidator.repairObject('does-not-exist');
  assert.deepEqual(res, { holesFilled: 0, nmFixed: 0, applied: [], remaining: [] });
});

// ── repairObjects (fix round 1): shared sequential batch, tolerant ────────
await test('repairObjects: sequential and tolerant — a failure on one object does not lose the other\'s fix', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  let call = 0;
  R.__test.setEngine({
    // Honest diagnose: 3 faces = open, 4+ = closed — otherwise repairObject's
    // automatic second pass (2026-09-18) would spend the "boom" call on
    // object 1 instead of object 2.
    diagnose: (_V, T) => ({ boundary: T.length > 3 ? 0 : 3, nonManifold: 0, components: 1, isWatertight: T.length > 3 }),
    repairObject: async (V, T) => {
      call++;
      if (call === 2) throw new Error('boom');
      // buildMesh is an unwelded soup (tri k owns vertices 3k..3k+2); the
      // missing face C1-C2-C3 in those indices is (2, 1, 5) — a REAL closing
      // triangle, so the written mesh validates clean and no second pass runs.
      return { V, T: [...T, [2, 1, 5]], report: { holesFilled: 1 } };
    },
  });

  const OPEN_TETRA = [[0, 2, 1], [0, 1, 3], [0, 3, 2]];   // 3 of 4 faces (open)
  const m1 = buildMesh(OPEN_TETRA);
  m1.metadata = { meshId: 'm1' };
  const m2 = buildMesh(OPEN_TETRA);
  m2.metadata = { meshId: 'm2' };
  const meshes = { m1, m2 };
  AssetLoader.getBabylonMesh = (id) => meshes[id] ?? null;

  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: {
        ...s.scene.objects,
        m1: { id: 'm1', name: 'obj-one', isPrintPart: true, isGhost: false },
        m2: { id: 'm2', name: 'obj-two', isPrintPart: true, isGhost: false },
      },
    },
  }), { silent: true });

  const progress = [];
  const result = await MeshValidator.repairObjects(['m1', 'm2'], {
    onProgress: (frac, name) => progress.push([frac, name]),
  });

  assert.ok(result.holesFilled > 0, 'holesFilled counts the successful repair (object 1)');
  assert.equal(result.failed.length, 1, 'object 2 failure is recorded, not thrown');
  assert.equal(result.failed[0].meshId, 'm2');
  assert.equal(result.failed[0].name, 'obj-two');
  assert.ok(result.failed[0].error instanceof Error, 'the underlying error is preserved');
  assert.ok(getState().scene.objects.m1.geometryFixes?.includes('holes'), 'object 1 still recorded its fix despite object 2 failing');
  assert.equal(getState().scene.objects.m2.geometryFixes, undefined, 'object 2 never reached the record step');
  assert.equal(progress.length, 2, 'onProgress called once per object');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
