// Per-object scale ratio redesign (2026-06-16). Pure-math coverage for the
// new ScaleMath helpers + the import-seed cancellation and export factor.

import assert from 'node:assert/strict';
import {
  objectRatio,
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

await test('exportRatiosFromState: list wins; else legacy [targetRatio]; else [] (as-shown)', () => {
  assert.deepEqual(exportRatiosFromState({ print: { exportRatios: [72, 144] } }), [72, 144]);
  assert.deepEqual(exportRatiosFromState({ print: { targetRatio: 35 } }), [35]);
  assert.deepEqual(exportRatiosFromState({ print: {} }), []);
  assert.deepEqual(exportRatiosFromState({ print: { exportRatios: [] , targetRatio: 8 } }), [8]);
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

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
