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
const { unitVolumesMM3, unitBoxVolumesMM3, overlappingPairs, quote, totalTriangles, costTriangleCap, supportVolumesMM3 } =
  await import('../src/core/print/PrintCost.js');
const { setSupportMeshLookup, setSupportFiguresLookup } = await import('../src/core/scene/SupportMeshSource.js');
const { signedVolume } = await import('../src/core/print/PrintSpace.js');
const { countSceneSupportTriangles } = await import('../src/core/scene/TriangleCount.js');
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

// Volume basis toggle (owner ask 2026-09-19): 'bbox' bills the object's own
// print-space box (10×20×30 = 6000 mm³ for the tetra), 'mesh' its enclosed
// volume (1000 mm³). Same settings, same ctx — only the basis moves.
await test('quote volumeMode: bbox = per-unit AABB volume, mesh = enclosed volume, cache carries both', () => {
  setValidation({ a: { results: [], validatedAt: Date.now(), stale: false } });
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }]);
  const box = unitBoxVolumesMM3(ctx).get('a');
  assert.ok(Math.abs(box.volumeMM3 - 6000) < 1e-6, `tetra AABB 10×20×30, got ${box.volumeMM3}`);
  assert.equal(box.triangles, 4);
  const s = { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' };
  const mesh = quote(ctx, { ...s, volumeMode: 'mesh' }, { densityGcm3: 1 });
  const bbox = quote(ctx, { ...s, volumeMode: 'bbox' }, { densityGcm3: 1 });
  assert.equal(mesh.volumeMode, 'mesh');
  assert.equal(bbox.volumeMode, 'bbox');
  assert.ok(Math.abs(mesh.volumeCM3 - 1) < 1e-6);
  assert.ok(Math.abs(bbox.volumeCM3 - 6) < 1e-6);
  assert.ok(Math.abs(bbox.total - 3) < 1e-6, '6 cm³ × 1 g/cm³ × 0.5 = 3');
  assert.equal(bbox.approximate, false, 'a box needs no watertight mesh');
  // Ratio scales the box like the mesh: ×8 at ratio 2.
  const ctx2 = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }], { target: 2 });
  assert.ok(Math.abs(unitBoxVolumesMM3(ctx2).get('a').volumeMM3 - 48000) < 1e-3);
  // Pre-computed geometry: bbox mode reads volsBox, never re-walks the scene.
  const geometry = { vols: unitVolumesMM3(ctx), volsBox: unitBoxVolumesMM3(ctx), pairs: overlappingPairs(ctx) };
  ctx.units[0].parts[0].mesh.getVerticesData = () => { throw new Error('re-walked the scene'); };
  const cached = quote(ctx, { ...s, volumeMode: 'bbox' }, { densityGcm3: 1 }, geometry);
  assert.ok(Math.abs(cached.volumeCM3 - 6) < 1e-6);
  // Unknown / absent mode = mesh (the default in default-settings.json).
  assert.equal(quote(ctx, { ...s, volumeMode: 'nonsense' }, { densityGcm3: 1 }, geometry).volumeMode, 'mesh');
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
    supportCost: null, supportVolumeCM3: null, supportTriangles: 0,
    setupFee: 0, total: null, currency: 'USD', approximate: true, overlaps: 0,
    reasons: ['tooBig'],
  });
});

// ── P4.3: supports in the quote and the triangle budget ─────────────────────
// Axis-aligned box as an outward-wound triangle list (12 triangles), w×h×d.
function boxSpec(w, h, d) {
  const pos = [0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0, 0, 0, d, w, 0, d, w, h, d, 0, h, d];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { pos, idx };
}
const CUBE = boxSpec(10, 10, 10);       // 1000 mm³ = 1.0 cm³
const SUPPORT_BOX = boxSpec(4, 5, 2);   // 40 mm³ = 0.04 cm³ (engine mm = mm-physical)
const SUPPORT_TRIS = SUPPORT_BOX.idx.length / 3;

// Stand-in for the support cache: object id → { revision, mesh }.
function lookupFor(entries) {
  return (id, revision) => {
    const hit = entries[id];
    return hit && hit.revision === revision ? hit.mesh : undefined;
  };
}
// Export-build figures of the same entries (what the worker measures and the cache holds): per object, at the revision.
function figuresFor(entries) {
  return (id, revision) => {
    const hit = entries[id];
    if (!hit || hit.revision !== revision) return undefined;
    if (hit.failed) return { failed: true };
    return { volumeMM3: Math.abs(signedVolume(hit.mesh.positions, hit.mesh.indices)), triangles: hit.mesh.indices.length / 3 };
  };
}
/** Install (or with null clear) both the preview-mesh cache and the export-figures cache stand-ins. */
function useSupports(entries) {
  setSupportMeshLookup(entries ? lookupFor(entries) : () => undefined);
  setSupportFiguresLookup(entries ? figuresFor(entries) : () => undefined);
}
const supportMesh = { positions: new Float32Array(SUPPORT_BOX.pos), indices: Uint32Array.from(SUPPORT_BOX.idx) };
const builtSupports = (extra = {}) => ({ supports: { sourceHash: 'h', pose: {}, revision: 3, stale: false, ...extra } });

/** A cube unit with built supports, exported under `includeSupports`. */
function cubeWithSupports({ includeSupports = 'printable', obj = builtSupports(), ratio = null } = {}) {
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(CUBE) }], { target: ratio });
  ctx.units[0].obj = obj;
  ctx.includeSupports = includeSupports;
  return ctx;
}
const MATERIAL = { densityGcm3: 1.1, supportDensityGcm3: 1.0 };
const SETTINGS = { pricePerGram: 0.5, supportPricePerGram: 0, supportPercent: 0, currency: 'USD' };
const fresh = () => setValidation({ a: { results: [], validatedAt: Date.now(), stale: false } });

await test('P4.3 (a): cost total = model + measured support volume x price (cube + known supports)', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const q = quote(cubeWithSupports(), SETTINGS, MATERIAL);
  assert.ok(Math.abs(q.supportVolumeCM3 - 0.04) < 1e-9, `support volume 0.04 cm³, got ${q.supportVolumeCM3}`);
  assert.equal(q.supportTriangles, SUPPORT_TRIS);
  // Model 1.0 cm³ × 1.1 g/cm³ × 0.5 = 0.55; supports 0.04 cm³ × 1.0 g/cm³ × 0.5 (price falls back to the model's) = 0.02.
  assert.ok(Math.abs(q.materialCost - 0.55) < 1e-9, `model cost 0.55, got ${q.materialCost}`);
  assert.ok(Math.abs(q.supportCost - 0.02) < 1e-9, `support cost 0.02, got ${q.supportCost}`);
  assert.ok(Math.abs(q.total - 0.57) < 1e-9, `total 0.57, got ${q.total}`);
  assert.ok(!q.reasons.some(r => /support/.test(r)), `fresh supports carry no reason, got ${q.reasons.join(',')}`);
  useSupports(null);
});

await test('P4.3 (a2): a measured support volume replaces the support-% estimate (no double count)', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const q = quote(cubeWithSupports(), { ...SETTINGS, supportPercent: 50 }, MATERIAL);
  assert.ok(Math.abs(q.supportCost - 0.02) < 1e-9, `supports measured, so 50% is ignored; got ${q.supportCost}`);
  useSupports(null);
});

await test('P4.3 (a3): a ratio other than as shown is flagged approximate (supports are sized as shown)', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const q = quote(cubeWithSupports({ ratio: 2 }), SETTINGS, MATERIAL);
  assert.ok(q.reasons.includes('supportsAsShown'), `got ${q.reasons.join(',')}`);
  assert.equal(q.approximate, true);
  useSupports(null);
});

await test('P4.3 (b): includeSupports = none leaves supports out (no Supports line, model-only total)', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const ctx = cubeWithSupports({ includeSupports: 'none' });
  assert.equal(supportVolumesMM3(ctx).size, 0);
  const q = quote(ctx, SETTINGS, MATERIAL);
  assert.equal(q.supportVolumeCM3, null, 'no Supports line when none is exported');
  assert.ok(Math.abs(q.total - 0.55) < 1e-9, `total is the model only, 0.55; got ${q.total}`);
  useSupports(null);
});

await test('P4.3 (b2): a STALE support is excluded and flagged, never quoted', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const q = quote(cubeWithSupports({ obj: builtSupports({ stale: true }) }), SETTINGS, MATERIAL);
  assert.equal(q.supportVolumeCM3, null);
  assert.equal(q.supportTriangles, 0);
  assert.ok(Math.abs(q.total - 0.55) < 1e-9, `total is the model only, 0.55; got ${q.total}`);
  assert.ok(q.reasons.includes('supportsStale:1'), `got ${q.reasons.join(',')}`);
  assert.equal(q.approximate, true);
  useSupports(null);
});

await test('P4.3 (b3): figures cached for another revision (or none) are PENDING, never stale or guessed', () => {
  useSupports({ a: { revision: 2, mesh: supportMesh } });
  fresh();
  const ctx = cubeWithSupports();
  assert.equal(supportVolumesMM3(ctx).get('a').pending, true);
  const q = quote(ctx, SETTINGS, MATERIAL);
  assert.equal(q.supportVolumeCM3, null, 'record at revision 3, figures cached at 2: not quoted as measured');
  assert.ok(q.reasons.includes('supportsPending:1'), `got ${q.reasons.join(',')}`);
  useSupports(null);
});

await test('P4.3b (1): supportsOnly quotes the supports alone; the model line is excluded', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh } });
  fresh();
  const q = quote(cubeWithSupports({ includeSupports: 'supportsOnly' }), SETTINGS, MATERIAL);
  assert.equal(q.modelExcluded, true);
  assert.equal(q.volumeCM3, 0, 'no model volume');
  assert.equal(q.grams, 0);
  assert.equal(q.materialCost, 0);
  assert.ok(Math.abs(q.supportCost - 0.02) < 1e-9, `supports 0.02, got ${q.supportCost}`);
  assert.ok(Math.abs(q.total - 0.02) < 1e-9, `total = supports only (0.02), got ${q.total}`);
  assert.ok(!q.reasons.some(r => /^(notWatertight|notValidated|overlap)/.test(r)), `model reasons are moot, got ${q.reasons.join(',')}`);
  // printable still carries the model.
  const both = quote(cubeWithSupports({ includeSupports: 'printable' }), SETTINGS, MATERIAL);
  assert.equal(both.modelExcluded, false);
  assert.ok(Math.abs(both.total - 0.57) < 1e-9);
  useSupports(null);
});

await test('P4.3b (3a): the quote reads the EXPORT build figures, never the preview mesh volume', () => {
  // The drawn (preview) mesh is 0.04 cm³ (tips only would be less); the export build measured 0.2 cm³.
  setSupportMeshLookup(lookupFor({ a: { revision: 3, mesh: supportMesh } }));
  setSupportFiguresLookup(() => ({ volumeMM3: 200, triangles: 24 }));
  fresh();
  const q = quote(cubeWithSupports(), SETTINGS, MATERIAL);
  assert.ok(Math.abs(q.supportVolumeCM3 - 0.2) < 1e-9, `export volume 0.2 cm³, got ${q.supportVolumeCM3}`);
  assert.equal(q.supportTriangles, 24);
  useSupports(null);
});

await test('P4.3b (3b): not measured yet = pending: labelled support-% estimate, never the preview volume', () => {
  // A preview mesh is cached, the export figures are not: the quote must not fall back to the preview.
  setSupportMeshLookup(lookupFor({ a: { revision: 3, mesh: supportMesh } }));
  setSupportFiguresLookup(() => undefined);
  fresh();
  const ctx = cubeWithSupports();
  assert.deepEqual(supportVolumesMM3(ctx).get('a'), { volumeMM3: 0, triangles: 0, stale: false, pending: true });
  const q = quote(ctx, { ...SETTINGS, supportPercent: 50 }, MATERIAL);
  assert.equal(q.supportVolumeCM3, null, 'no measured volume');
  assert.equal(q.supportTriangles, 0);
  assert.ok(q.reasons.includes('supportsPending:1'), `got ${q.reasons.join(',')}`);
  assert.equal(q.approximate, true);
  // Estimate: 1.0 cm³ x 50 % x 1.0 g/cm³ = 0.5 g x 0.5 = 0.25 (the support-% path).
  assert.ok(Math.abs(q.supportCost - 0.25) < 1e-9, `estimate 0.25, got ${q.supportCost}`);
  useSupports(null);
});

await test('P4.3b (3c): an export build that cannot be made is left out as stale, not pending forever', () => {
  useSupports({ a: { revision: 3, mesh: supportMesh, failed: true } });
  fresh();
  const q = quote(cubeWithSupports(), SETTINGS, MATERIAL);
  assert.ok(q.reasons.includes('supportsStale:1'), `got ${q.reasons.join(',')}`);
  assert.ok(!q.reasons.some(r => r.startsWith('supportsPending')));
  useSupports(null);
});

await test('P4.3 (c): support triangles are counted apart from the model, fresh objects only', () => {
  setSupportMeshLookup(lookupFor({ a: { revision: 3, mesh: supportMesh }, b: { revision: 1, mesh: supportMesh } }));
  const objects = {
    a: { supports: { revision: 3, stale: false } },
    b: { supports: { revision: 1, stale: true } },
    c: {},
  };
  assert.equal(countSceneSupportTriangles(objects), SUPPORT_TRIS, 'only the fresh support mesh counts');
  useSupports(null);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
