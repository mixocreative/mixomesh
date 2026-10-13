// Per-object scale ratio redesign (2026-06-16). Pure-math coverage for the
// new ScaleMath helpers + the import-seed cancellation and export factor.

import assert from 'node:assert/strict';
import {
  objectRatio,
  effectiveRatio,
  effectiveRatioInfo,
  objectScaleFromObject,
  exportRatiosFromState,
  computePrintExportScale,
  computeSceneNormalizationScale,
} from '../src/core/scale/ScaleMath.js';

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('objectRatio: own ratio wins, else modelRatio, else 1', () => {
  assert.equal(objectRatio({ ratio: 72, modelRatio: 1 }), 72);
  assert.equal(objectRatio({ modelRatio: 35 }), 35);
  assert.equal(objectRatio({}), 1);
  assert.equal(objectRatio({ ratio: 0 }), 1);
  assert.equal(objectRatio(null), 1);
});

await test('objectScaleFromObject: wraps objectRatio as sceneRatio', () => {
  assert.deepEqual(objectScaleFromObject({ ratio: 12 }), { sceneRatio: 12 });
});

await test('exportRatiosFromState: list wins; else [] (as-shown; legacy targetRatio is migrated by ProjectLoader)', () => {
  assert.deepEqual(exportRatiosFromState({ print: { exportRatios: [72, 144] } }), [72, 144]);
  assert.deepEqual(exportRatiosFromState({ print: {} }), []);
  assert.deepEqual(exportRatiosFromState({ print: { exportRatios: [], targetRatio: 8 } }), []);
});

await test('import seed cancels: ratio == modelRatio ⇒ unit-only factor', () => {
  // A 1:72-authored file seeded with ratio = modelRatio = 72 lands at its
  // authored size, normalized only by the mm→m source unit factor.
  const f = computeSceneNormalizationScale(
    { sourceUnit: 'millimeters', authoredRatio: 72 },
    { sceneRatio: 72 });
  assert.equal(f, 0.001);
});

await test('export factor: (ratio / T) × 1000', () => {
  // tank ratio 72 → target 144 → 500 (the spec §3.7 worked example).
  assert.equal(computePrintExportScale({ sceneRatio: 72 }, { printRatio: 144 }), 500);
  // tank 72 → target 35
  assert.ok(Math.abs(computePrintExportScale({ sceneRatio: 72 }, { printRatio: 35 }) - (72 / 35) * 1000) < 1e-6);
});

await test('effectiveRatio: node scale 2 on 1:72 -> 36; parent scale counts; non-uniform -> 72 + flag', () => {
  const o = { ratio: 72 };
  assert.equal(effectiveRatio(o, null), 72);
  assert.equal(effectiveRatio(o, { scaling: { x: 1, y: 1, z: 1 } }), 72);
  assert.equal(effectiveRatio(o, { scaling: { x: 2, y: 2, z: 2 } }), 36);
  const kid = { scaling: { x: 1, y: 1, z: 1 }, parent: { scaling: { x: 2, y: 2, z: 2 } } };
  assert.equal(effectiveRatio(o, kid), 36);
  const w = (n) => ({ getWorldMatrix: () => ({ m: [n,0,0,0, 0,n,0,0, 0,0,n,0, 0,0,0,1] }) });
  assert.equal(effectiveRatio(o, w(2)), 36);
  const nu = { scaling: { x: 2, y: 1, z: 1 } };
  assert.equal(effectiveRatio(o, nu), 72);
  assert.equal(effectiveRatioInfo(o, nu).uniform, false);
  assert.equal(effectiveRatioInfo(o, w(2)).uniform, true);
});

await test('RescaleObjectCommand: own-origin rescale, child local offset scales, undo exact', async () => {
  const { installEnv } = await import('./env.mjs');
  installEnv();
  const { RescaleObjectCommand } = await import('../src/core/HistoryManager.js');
  const { AssetLoader } = await import('../src/core/AssetLoader.js');
  const { setState } = await import('../src/core/StateManager.js');
  const mk = (id, x, parent = null) => ({
    metadata: { meshId: id }, parent, geometry: true, position: { x, y: 0, z: 0 },
    verts: [], bakeTransformIntoVertices(m) { this.verts.push(m); }, refreshBoundingInfo() {},
  });
  const top = mk('top', 0.1);
  const kid = mk('kid', 0.02, top);
  const meshes = { top, kid };
  AssetLoader.getBabylonMesh = (id) => meshes[id] ?? null;
  setState(s => ({ ...s, scene: { ...s.scene, objects: {
    top: { id: 'top', ratio: 1 }, kid: { id: 'kid', ratio: 1 } } } }), { silent: true });
  const cmd = new RescaleObjectCommand(['top', 'kid'], 72);
  cmd.execute();
  assert.equal(top.position.x, 0.1, 'top-level position untouched');
  assert.ok(Math.abs(kid.position.x - 0.02 / 72) < 1e-12, 'child local offset scales');
  assert.equal(top.verts.length, 1);
  cmd.undo();
  assert.ok(Math.abs(top.position.x - 0.1) < 1e-12);
  assert.ok(Math.abs(kid.position.x - 0.02) < 1e-12, 'undo restores child offset');
  assert.equal(top.verts.length, 2, 'undo re-bakes inverse');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
