import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const R = await import('../src/core/repair/MeshRepair.js');
const { signedVolume } = await import('../src/core/print/PrintSpace.js');
const CLOCKWISE = 0, COUNTER_CLOCKWISE = 1;
const triples = (flat) => flat.reduce((a, _x, i, arr) => (i % 3 ? a : [...a, [arr[i], arr[i + 1], arr[i + 2]]]), []);

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

/** Every (position, uv) pair a mesh currently carries, as sorted strings. */
function uvPairs(mesh) {
  const pos = mesh.getVerticesData('position');
  const uv = mesh.getVerticesData('uv');
  const out = [];
  for (let i = 0; i < pos.length / 3; i++) {
    out.push(`${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}|${uv[i * 2]},${uv[i * 2 + 1]}`);
  }
  return out.sort();
}

await test('meshToArrays / arraysToMesh round-trip re-attaches UVs by nearest vertex (no original triangles)', () => {
  const UVS = [0,0, 1,0, 0,1, 1,1];
  const m = fakeMesh(OPEN_POS, OPEN_IDX, UVS);
  const { V, T } = R.meshToArrays(m);
  assert.deepEqual(V[1], [10, 0, 0]); assert.deepEqual(T[0], [0, 2, 1]);
  // engine output: same vertices reordered + one new triangle closing the hole
  const V2 = [V[3], V[0], V[1], V[2]]; const T2 = [[1,3,2],[1,2,0],[1,0,3],[2,3,0]];
  R.arraysToMesh(m, V2, T2, Float32Array.from(OPEN_POS), Float32Array.from(UVS));
  assert.equal(m.getIndices().length, 12);
  // Vertex ORDER is rebuilt per triangle corner, so identity is asserted on
  // the (position, uv) pairing — the thing the texture actually depends on.
  assert.deepEqual(uvPairs(m), uvPairs(fakeMesh(OPEN_POS, OPEN_IDX, UVS)),
    'every position keeps the UV of the original vertex at that position');
});

// ── C1: UV seams survive a repair ────────────────────────────────────────
// Two triangles sharing an edge, each side carrying its OWN UVs for the two
// shared-edge vertices (that IS a UV seam: one position, two UVs). MeshFixLib
// stage 1 merges duplicate positions, so the engine hands back 4 vertices
// where the mesh had 6 — re-attaching UVs by position alone collapsed both
// sides of the seam onto one UV and smeared the texture (review C1).
const SEAM_POS = [0,0,0, 1,0,0, 1,1,0,   0,0,0, 1,1,0, 0,1,0];
const SEAM_UV  = [0,0, 1,0, 1,1,   0.5,0, 0.5,1, 0,1];
const SEAM_IDX = [0,1,2, 3,4,5];
// The merge the engine performs: 6 vertices → 4, triangles re-indexed.
const MERGED_V = [[0,0,0], [1,0,0], [1,1,0], [0,1,0]];

await test('C1: a merging repair on a textured SEAMED quad keeps every seam UV exactly', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async () => ({ V: MERGED_V.map(v => [...v]), T: [[0,1,2],[0,2,3]], report: {} }),
  });
  const m = fakeMesh(SEAM_POS, SEAM_IDX, SEAM_UV);
  const expected = uvPairs(fakeMesh(SEAM_POS, SEAM_IDX, SEAM_UV));
  const r = await R.repairMesh(m);
  assert.equal(r.changed, true, 'the engine merged vertices, so the mesh was rewritten');
  assert.equal(m.getVerticesData('position').length / 3, 6,
    'the merged seam vertices are SPLIT BACK APART so both UVs survive');
  assert.deepEqual(uvPairs(m), expected, 'every (position, uv) pair is byte-identical to the input');
  assert.equal(m.getIndices().length, 6, 'still two triangles');
});

await test('C1: a HOLE-FILLING repair fills the hole and leaves untouched seam UVs exact', async () => {
  const NEW_V = [0.5, 0.5, 1];   // hole-fill vertex the engine invents
  R.__test.setEngine({
    diagnose: (V, T) => ({ boundary: T.length > 2 ? 0 : 2, nonManifold: 0, components: 1, isWatertight: T.length > 2 }),
    repairObject: async () => ({
      V: [...MERGED_V.map(v => [...v]), NEW_V],
      T: [[0,1,2],[0,2,3],[0,1,4]],
      report: { holesFilled: 1 },
    }),
  });
  const m = fakeMesh(SEAM_POS, SEAM_IDX, SEAM_UV);
  const expected = uvPairs(fakeMesh(SEAM_POS, SEAM_IDX, SEAM_UV));
  const r = await R.repairMesh(m);
  assert.equal(r.holesFilled, 1);
  assert.equal(m.getIndices().length, 9, 'hole filled — three triangles now');
  const after = uvPairs(m);
  for (const pair of expected) {
    assert.ok(after.includes(pair), `untouched vertex lost its UV: ${pair} missing from ${after.join(' ')}`);
  }
  assert.ok([...m.getVerticesData('uv')].every(Number.isFinite),
    'hole-fill vertices got a real (nearest-vertex) UV, never NaN');
});

// ── CIA F2: never write unvalidated engine output ────────────────────────
await test('F2: engine output with an out-of-range index throws and the mesh is NOT written', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V) => ({ V: V.map(v => [...v]), T: [[0, 1, 99]], report: {} }),
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  await assert.rejects(R.repairMesh(m), /malformed geometry/);
  assert.deepEqual(m.getIndices(), OPEN_IDX, 'original indices untouched');
});

await test('F2: a non-finite coordinate throws before write-back', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V, T) => ({ V: [[0, NaN, 0], ...V.slice(1).map(v => [...v])], T: T.map(x => [...x]), report: {} }),
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  await assert.rejects(R.repairMesh(m), /malformed geometry/);
  assert.deepEqual(Array.from(m.getVerticesData('position')), OPEN_POS, 'original positions untouched');
});

// ── I1: written-back winding is conformed to the mesh's side flag ────────
// Measured 2026-09-18: MeshFixLib normalises its output to a POSITIVE
// right-handed signed volume regardless of input. Babylon is left-handed, so
// a CounterClockWise-outward mesh has a NEGATIVE signed volume — the engine's
// output is outward only under a ClockWise flag. The flag must stay as it
// was and the indices must be reversed when the geometry disagrees with it.
const TETRA_POS = [0,0,0, 10,0,0, 0,20,0, 0,0,30];
const TETRA_POSWIND = [0,2,1, 0,1,3, 0,3,2, 1,2,3];                               // signed volume +1000
const TETRA_NEGWIND = triples(TETRA_POSWIND).flatMap(([a, b, c]) => [a, c, b]);   // signed volume -1000
const engineReturning = (T, isWatertight) => ({
  diagnose: () => ({ boundary: isWatertight ? 0 : 2, nonManifold: 0, components: 1, isWatertight }),
  repairObject: async (V) => ({ V: V.map(v => [...v]), T: triples(T), report: { holesFilled: 1 } }),
});

await test('I1: sanity — the two tetra windings have opposite signed volumes', () => {
  assert.ok(signedVolume(TETRA_POS, TETRA_NEGWIND) < 0, 'TETRA_NEGWIND is the negative-volume winding');
  assert.ok(signedVolume(TETRA_POS, TETRA_POSWIND) > 0, 'TETRA_POSWIND is the positive-volume winding');
});

await test('I1: ClockWise (glTF) mesh + engine POSITIVE output ⇒ flag kept, indices kept (already outward)', async () => {
  R.__test.setEngine(engineReturning(TETRA_POSWIND, true));
  const m = fakeMesh(TETRA_POS, [0,2,1, 0,1,3, 0,3,2]);
  m.sideOrientation = CLOCKWISE;
  await R.repairMesh(m);
  assert.equal(m.sideOrientation, CLOCKWISE, 'side flag is never re-tagged');
  assert.ok(signedVolume(m.getVerticesData('position'), m.getIndices()) > 0, 'ClockWise outward = positive signed volume');
});

await test('I1: CounterClockWise (native/OBJ) mesh + engine POSITIVE output ⇒ flag kept, indices REVERSED', async () => {
  R.__test.setEngine(engineReturning(TETRA_POSWIND, true));
  const m = fakeMesh(TETRA_POS, [0,1,2, 0,3,1, 0,2,3]);
  m.sideOrientation = COUNTER_CLOCKWISE;
  await R.repairMesh(m);
  assert.equal(m.sideOrientation, COUNTER_CLOCKWISE, 'side flag is never re-tagged');
  assert.ok(signedVolume(m.getVerticesData('position'), m.getIndices()) < 0,
    'CounterClockWise outward = negative signed volume — the old code shipped this inside-out');
});

await test('I1: an engine that happens to return the flag-consistent winding is left untouched', async () => {
  R.__test.setEngine(engineReturning(TETRA_NEGWIND, true));
  const m = fakeMesh(TETRA_POS, [0,1,2, 0,3,1, 0,2,3]);
  m.sideOrientation = COUNTER_CLOCKWISE;
  await R.repairMesh(m);
  assert.deepEqual(m.getIndices(), TETRA_NEGWIND, 'indices written back verbatim');
});

await test('I1: a PARTIAL repair is conformed by the same rule (engine still orients globally)', async () => {
  R.__test.setEngine(engineReturning(TETRA_POSWIND, false));
  const m = fakeMesh(TETRA_POS, [0,1,2, 0,3,1, 0,2,3]);
  m.sideOrientation = COUNTER_CLOCKWISE;
  const r = await R.repairMesh(m);
  assert.equal(r.isWatertight, false);
  assert.ok(signedVolume(m.getVerticesData('position'), m.getIndices()) < 0, 'reversed to match the CounterClockWise flag');
});

// ── M7 / M8 / I2 / CIA F4 ───────────────────────────────────────────────
await test('M7: the engine own defaultOptions reach the WASM call, with our overrides on top', async () => {
  let seen = null;
  R.__test.setEngine({
    defaultOptions: () => ({ mergePrecision: 'auto', edgeFlipPasses: 20, removeSmallShells: true, deepRepair: false }),
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V, T, _p, opts) => { seen = opts; return { V, T, report: {} }; },
  });
  await R.repairMesh(fakeMesh(OPEN_POS, OPEN_IDX), { engine: { deepRepair: true } });
  assert.equal(seen.mergePrecision, 'auto', 'an upstream default we never name still arrives');
  assert.equal(seen.edgeFlipPasses, 20);
  assert.equal(seen.removeSmallShells, false, 'our override beats the engine default');
  assert.equal(seen.repairSelfIntersections, false);
  assert.equal(seen.deepRepair, true, 'caller override beats both');
});

await test('M8: the too-large message names the cap that was actually APPLIED', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: async (V, T) => ({ V, T, report: {} }),
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);   // 3 triangles
  await assert.rejects(R.repairMesh(m, { triangleCap: 1 }), /3 triangles > 1\)/);
  await assert.rejects(R.diagnoseMesh(m, { triangleCap: 1 }), /too large to diagnose/);
});

await test('F4: a repair that never returns rejects with /timed out/ instead of hanging', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, components: 1, isWatertight: true }),
    repairObject: () => new Promise(() => {}),   // never settles
  });
  await assert.rejects(R.repairMesh(fakeMesh(OPEN_POS, OPEN_IDX), { timeoutMs: 20 }), /timed out/);
});

await test('I2: diagnoseMesh refuses above the repair cap, never entering the WASM call', async () => {
  let calls = 0;
  R.__test.setEngine({
    diagnose: () => { calls++; return { boundary: 0, nonManifold: 0, components: 1, isWatertight: true }; },
    repairObject: async (V, T) => ({ V, T, report: {} }),
  });
  const big = fakeMesh(OPEN_POS, new Array(R.REPAIR_TRIANGLE_CAP * 3 + 3).fill(0));
  await assert.rejects(R.diagnoseMesh(big), /too large to diagnose/);
  assert.equal(calls, 0, 'the WASM diagnose is never entered above the cap');
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

await test('repairMesh treats a winding-only change as changed even with an all-zero/absent report', async () => {
  R.__test.setEngine({
    diagnose: () => ({ boundary: 0, nonManifold: 0, windingInconsistencies: 0, oppositeWindingPairs: 0, components: 1, isWatertight: true }),
    // Same vertices, but the first triangle's winding is flipped (last two
    // indices swapped) and the report carries NO counters at all — a
    // real winding-fix pass from the vendored engine looks exactly like this.
    repairObject: async (V, T) => {
      const T2 = T.map(t => [...t]);
      const [a, b, c] = T2[0]; T2[0] = [a, c, b];
      return { V, T: T2, report: {} };
    },
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  const r = await R.repairMesh(m);
  assert.equal(r.changed, true, 'data differs (winding) even though every report counter is 0/absent');
  assert.deepEqual(m.getIndices(), [0, 1, 2, 0, 1, 3, 0, 3, 2], 'repaired (re-wound) indices were written back');
});

await test('repairMesh treats byte-identical output as unchanged and diagnoses the ORIGINAL mesh', async () => {
  let repairedWith = null; let diagnosedWith = null;
  R.__test.setEngine({
    diagnose: (V) => { diagnosedWith = V; return { boundary: 0, nonManifold: 0, windingInconsistencies: 0, oppositeWindingPairs: 0, components: 1, isWatertight: true }; },
    // Returns equal-by-value but NOT equal-by-reference arrays, so a
    // reference-identity shortcut could not accidentally pass this test.
    repairObject: async (V, T) => { repairedWith = V; return { V: V.map(v => [...v]), T: T.map(t => [...t]), report: {} }; },
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  const r = await R.repairMesh(m);
  assert.equal(r.changed, false, 'no data difference → unchanged');
  assert.deepEqual(m.getIndices(), OPEN_IDX, 'mesh left untouched (no write-back on unchanged)');
  assert.equal(diagnosedWith, repairedWith, 'diagnosed the ORIGINAL V passed into repairObject, not the (discarded) repaired-output clone');
});

console.log('\n' + out.join('\n')); console.log(`\n${passed} passed, ${failed} failed\n`); process.exit(failed ? 1 : 0);
