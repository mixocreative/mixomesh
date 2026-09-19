// Headless PrintCost tests. Run:
//   node --import ./tests/register-hooks.mjs tests/print-cost.test.mjs
//
// Harness mirrors export.test.mjs (installEnv + StateManager + duck-typed
// Babylon meshes with real position/index buffers) but builds a minimal
// ExportContext-shaped object directly rather than going through
// buildExportContext/collectPrintUnits — PrintCost.js only ever consumes
// {units, pivot, ratioFactor, unitFactor, state}, so the test stays a pure
// unit test of that contract. `unitFactor` is deliberately 1 here (not the
// real BU_TO_MM=1000) so the fixture's raw coordinates ARE the millimetre
// values described in the comments below — the production code path (which
// always reads ctx.unitFactor, never a literal) is exercised for real by
// tests/export.test.mjs's flattenWorld-driven writers.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { StateManager } = await import('../src/core/StateManager.js');
const { unitVolumesMM3, overlappingPairs, quote, totalTriangles, costTriangleCap } =
  await import('../src/core/print/PrintCost.js');
const { setCapabilities } = await import('../src/core/storage/capabilities.js');

// M9: the cost gate is a UI-responsiveness cap that tracks the HUD triangle
// budget, NOT the repair engine's cap. Pin a small deterministic budget.
setCapabilities({ triangleBudget: 5000 });

// ── Fixture: a tetrahedron with V0=(0,0,0), V1=(-10,0,0), V2=(0,20,0),
// V3=(0,0,30) — an axis-aligned right tetrahedron, volume = (1/6)*10*20*30
// = 1000 (mm³ once unitFactor/ratioFactor resolve to 1). ─────────────────
const tetra = {
  pos: [0, 0, 0, -10, 0, 0, 0, 20, 0, 0, 0, 30],
  idx: [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
};

function fakeMesh({ pos, idx }, { side = 1, offset = [0, 0, 0] } = {}) {
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < pos.length; i += 3) { xs.push(pos[i]); ys.push(pos[i + 1]); zs.push(pos[i + 2]); }
  const lo = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
  const hi = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  return {
    sideOrientation: side,   // 1 = CounterClockWise, 0 = ClockWise (glTF)
    material: null,
    getVerticesData(kind) { return kind === 'position' ? new Float32Array(pos) : null; },
    getIndices() { return idx; },
    computeWorldMatrix() {},
    getWorldMatrix() { return window.BABYLON.Matrix.Translation(offset[0], offset[1], offset[2]); },
    getBoundingInfo() {
      return {
        boundingBox: {
          minimumWorld: { x: lo[0] + offset[0], y: lo[1] + offset[1], z: lo[2] + offset[2] },
          maximumWorld: { x: hi[0] + offset[0], y: hi[1] + offset[1], z: hi[2] + offset[2] },
        },
      };
    },
  };
}

// A mesh with a huge (fake) triangle count and a `getVerticesData` that
// THROWS if ever called — proves `quote()` short-circuits on the cheap
// `totalTriangles` gate before doing any real per-vertex work. `getIndices`
// only needs a `.length`, so a bare-length array avoids allocating real data.
function fakeHugeMesh() {
  return {
    sideOrientation: 1,
    material: null,
    getVerticesData() { throw new Error('tooBig gate must short-circuit before getVerticesData is ever called'); },
    getIndices() { return new Array((costTriangleCap() + 1) * 3); },
    computeWorldMatrix() {},
    getWorldMatrix() { return window.BABYLON.Matrix.Translation(0, 0, 0); },
    getBoundingInfo() {
      return { boundingBox: { minimumWorld: { x: 0, y: 0, z: 0 }, maximumWorld: { x: 0, y: 0, z: 0 } } };
    },
  };
}

/**
 * @param {Array<{id:string, mesh:object}>} unitSpecs
 * @param {{target?:number|null}} [opts] target is used directly as
 *   ctx.ratioFactor (null → 1) — this harness tests PrintCost's generic
 *   "volume scales with ratioFactor³" contract, not ExportContext's own
 *   referenceRatio/targetRatio division (covered by export.test.mjs).
 */
function ctxWith(unitSpecs, { target = null } = {}) {
  const units = unitSpecs.map(({ id, mesh }) => ({ logicalId: id, parts: [{ meshId: id, mesh }] }));
  return {
    units,
    pivot: { x: 0, y: 0, z: 0 },
    ratioFactor: target ?? 1,
    unitFactor: 1,
    state: StateManager.getState(),
  };
}

function setValidation(entries) {
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: entries } }), { silent: true });
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  setValidation({});
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('unitVolumesMM3: 1000 mm³ tetra at ratio 1, ×8 at ratio 2', () => {
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra, { side: 0 }) }], { target: null });
  assert.ok(Math.abs(unitVolumesMM3(ctx).get('a').volumeMM3 - 1000) < 1e-6);

  const ctx2 = ctxWith([{ id: 'a', mesh: fakeMesh(tetra, { side: 0 }) }], { target: 2 });   // print at 2× reference
  assert.ok(Math.abs(unitVolumesMM3(ctx2).get('a').volumeMM3 - 8000) < 1e-3);
});

await test('unitVolumesMM3: watertight flag follows the validation cache (holes/nonManifold → false)', () => {
  setValidation({ a: { results: [], validatedAt: Date.now(), stale: false } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  assert.equal(unitVolumesMM3(ctx).get('a').watertight, true, 'clean cache entry = watertight');

  setValidation({ a: { results: [{ type: 'holes', severity: 'warning', message: 'x' }], stale: false } });
  const ctx2 = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  assert.equal(unitVolumesMM3(ctx2).get('a').watertight, false);
});

// CIA F5 / I11: "never validated" is not "watertight" - it is "nobody has
// checked", and an open shell's signed volume is arbitrary. The quote must
// say so instead of presenting the number as if it were exact.
await test('F5: a part with no cache entry is NOT validated and the quote says so', () => {
  setValidation({});
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  assert.equal(unitVolumesMM3(ctx).get('a').validated, false, 'no cache entry = not validated');

  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });
  assert.ok(q.reasons.includes('notValidated:1'), `expected notValidated:1, got ${q.reasons.join(',')}`);
  assert.equal(q.approximate, true, 'unverified geometry can never read as an exact quote');
  assert.ok(!q.reasons.some(r => /notWatertight/.test(r)),
    'not-validated is its OWN reason - it must not be double-counted as not-watertight');
});

await test('F5: a STALE cache entry counts as not validated (same as PrintReadiness validation-pending)', () => {
  setValidation({ a: { results: [], validatedAt: Date.now(), stale: true } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  assert.equal(unitVolumesMM3(ctx).get('a').validated, false);
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });
  assert.ok(q.reasons.includes('notValidated:1'));
});

await test('F5: a freshly validated, clean part carries NO notValidated reason', () => {
  setValidation({ a: { results: [], validatedAt: Date.now(), stale: false } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  assert.equal(unitVolumesMM3(ctx).get('a').validated, true);
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });
  assert.ok(!q.reasons.some(r => /notValidated/.test(r)), `got ${q.reasons.join(',')}`);
  assert.equal(q.approximate, false, 'a validated, closed, priced part quotes exactly');
});

await test('overlappingPairs: AABB intersection flags overlapping units, never subtracts', () => {
  const ctx = ctxWith([
    { id: 'a', mesh: fakeMesh(tetra) },
    { id: 'b', mesh: fakeMesh(tetra, { offset: [2, 0, 0] }) },
  ]);
  const pairs = overlappingPairs(ctx);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].sort(), ['a', 'b']);

  const far = ctxWith([
    { id: 'a', mesh: fakeMesh(tetra) },
    { id: 'c', mesh: fakeMesh(tetra, { offset: [1000, 0, 0] }) },
  ]);
  assert.equal(overlappingPairs(far).length, 0, 'far-apart units do not overlap');
});

// M6: the epsilon's sign was inverted, so two parts placed flush against each
// other - the normal kitbash / bed-layout case - counted as overlapping and
// marked every such quote approximate for no reason.
await test('M6: exactly-touching boxes do NOT overlap; a 0.1 mm interpenetration does', () => {
  // The tetra spans x in [-10, 0]. Offsetting by +10 puts the second unit's
  // minimum exactly at the first's maximum: touching, not overlapping.
  const touching = ctxWith([
    { id: 'a', mesh: fakeMesh(tetra) },
    { id: 'b', mesh: fakeMesh(tetra, { offset: [10, 0, 0] }) },
  ]);
  assert.equal(overlappingPairs(touching).length, 0,
    'flush faces are a legitimate layout, not an overlap');

  // 0.1 mm of real interpenetration (10x the 0.01 mm epsilon) IS an overlap.
  const overlapping = ctxWith([
    { id: 'a', mesh: fakeMesh(tetra) },
    { id: 'b', mesh: fakeMesh(tetra, { offset: [9.9, 0, 0] }) },
  ]);
  assert.equal(overlappingPairs(overlapping).length, 1,
    '0.1 mm interpenetration is flagged');
});

// I10: the Cost block memoises the geometry pass per ExportContext and hands
// it back, so a keystroke recomputes money only.
await test('I10: quote accepts pre-computed geometry and does no per-vertex work with it', () => {
  setValidation({ a: { results: [], validatedAt: Date.now(), stale: false } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  const geometry = { vols: unitVolumesMM3(ctx), pairs: overlappingPairs(ctx) };
  // Poison the mesh: any fresh geometry pass would now throw.
  ctx.units[0].parts[0].mesh.getVerticesData = () => { throw new Error('re-walked the scene'); };
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 }, geometry);
  assert.ok(Math.abs(q.volumeCM3 - 1) < 1e-6, 'same volume, from the cached pass');
  assert.ok(Math.abs(q.materialCost - 0.55) < 1e-6, 'money recomputed from the new settings');
});

await test('quote: grams = cm³ × density; support premium; overlap flagged not subtracted', () => {
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }, { id: 'b', mesh: fakeMesh(tetra, { offset: [2, 0, 0] }) }]);
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0.2, supportPercent: 40, currency: 'USD' }, { densityGcm3: 1.1, supportDensityGcm3: 1.1 });
  assert.ok(Math.abs(q.volumeCM3 - 2) < 1e-6, 'sum of both (overlap NOT subtracted)');
  assert.ok(Math.abs(q.grams - 2.2) < 1e-6); assert.ok(Math.abs(q.materialCost - 1.1) < 1e-6);
  assert.ok(Math.abs(q.supportGrams - 0.88) < 1e-6); assert.ok(Math.abs(q.total - (1.1 + 0.176)) < 1e-6);
  assert.equal(q.overlaps, 1); assert.equal(q.approximate, true); assert.ok(q.reasons.some(r => /overlap/.test(r)));
});

await test('quote: not-watertight part → approximate with reason; missing price → total null', () => {
  // A `holes` result in the validation cache marks the quote approximate
  // with a `notWatertight:1` reason, even though density + price both resolve.
  setValidation({ a: { results: [{ type: 'holes', severity: 'warning', message: 'open edge' }] } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  const q1 = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });
  assert.equal(q1.approximate, true);
  assert.ok(q1.reasons.includes('notWatertight:1'), `expected notWatertight:1, got ${q1.reasons.join(',')}`);
  assert.notEqual(q1.total, null, 'price + density both resolve, so total is still computable');

  // pricePerGram: 0 in settings + a material lacking pricePerGram → no price
  // can be resolved anywhere → total MUST be null (never silently 0), and a
  // `noPrice` reason is reported.
  setValidation({});
  const ctx2 = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  const q2 = quote(ctx2, { pricePerGram: 0, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });   // material has density but no pricePerGram
  assert.equal(q2.total, null, 'total must be null, never 0, when no price resolves');
  assert.ok(q2.reasons.includes('noPrice'), `expected noPrice, got ${q2.reasons.join(',')}`);
  assert.equal(q2.approximate, true);
});

await test('totalTriangles: cheap array-length sum across units/parts', () => {
  const ctx = ctxWith([
    { id: 'a', mesh: fakeMesh(tetra) },
    { id: 'b', mesh: fakeMesh(tetra, { offset: [2, 0, 0] }) },
  ]);
  assert.equal(totalTriangles(ctx), 8, 'two 4-triangle tetrahedra = 8 triangles');
});

await test('M9: quote above costTriangleCap() short-circuits before any volume computation (tooBig, never throws)', () => {
  const ctx = ctxWith([{ id: 'a', mesh: fakeHugeMesh() }]);
  // fakeHugeMesh's getVerticesData throws — if quote() ever called
  // unitVolumesMM3/overlappingPairs on it, this assertion would throw
  // instead of returning cleanly, proving the gate runs FIRST.
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' },
    { densityGcm3: 1.1 });
  assert.deepEqual(q, {
    volumeCM3: null, grams: null, materialCost: null, supportGrams: null,
    supportCost: null, setupFee: 0, total: null, currency: 'USD', approximate: true, overlaps: 0,
    reasons: ['tooBig'],
  });
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
