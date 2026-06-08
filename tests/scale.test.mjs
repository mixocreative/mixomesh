import assert from 'node:assert/strict';
import {
  computePrintExportScale,
  computeSceneNormalizationScale,
  computeSceneScaleRebakeFactor,
  formatScaleRatio,
  parseScaleRatioText,
  sceneScaleFromState,
  printScaleFromState,
  authoredScaleFromAsset,
} from '../src/core/scale/ScaleMath.js';

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('parseScaleRatioText: common downscale forms', () => {
  assert.equal(parseScaleRatioText('1:72'), 72);
  assert.equal(parseScaleRatioText('1/35'), 35);
  assert.equal(parseScaleRatioText('48'), 48);
});

await test('parseScaleRatioText: upscale form', () => {
  assert.equal(parseScaleRatioText('2:1'), 0.5);
});

await test('formatScaleRatio: downscale and upscale labels', () => {
  assert.equal(formatScaleRatio(72), '1:72');
  assert.equal(formatScaleRatio(0.5), '2:1');
  assert.equal(formatScaleRatio(1), '1:1');
});

await test('computeSceneNormalizationScale: authored scale into scene scale', () => {
  const authoredScale = { sourceUnit: 'millimeters', authoredRatio: 72 };
  const sceneScale = { sceneRatio: 35 };
  assert.equal(computeSceneNormalizationScale(authoredScale, sceneScale), 0.001 * (72 / 35));
});

await test('computePrintExportScale: scene BU to exported millimeters', () => {
  assert.equal(computePrintExportScale({ sceneRatio: 12 }, { printRatio: 35 }), (12 / 35) * 1000);
});

await test('computeSceneScaleRebakeFactor: previous over next', () => {
  assert.equal(computeSceneScaleRebakeFactor(12, 24), 0.5);
});

await test('state compatibility: old persisted field names map to new runtime names', () => {
  const state = { print: { workingRatio: 12, targetRatio: 35 } };
  assert.deepEqual(sceneScaleFromState(state), { sceneRatio: 12 });
  assert.deepEqual(printScaleFromState(state), { printRatio: 35 });
});

await test('asset compatibility: old modelRatio/sourceUnit map to authoredScale', () => {
  assert.deepEqual(authoredScaleFromAsset({ sourceUnit: 'inches', modelRatio: 48, unitConfirmed: true }), {
    sourceUnit: 'inches',
    authoredRatio: 48,
    detectedFrom: 'default',
    confirmedByUser: true,
  });
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
