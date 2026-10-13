// Properties-panel ratio targeting. Run:
//   node --import ./tests/register-hooks.mjs tests/properties-ratio.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const PropertiesPanelModule = await import('../src/ui/PropertiesPanel.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('ratio target helper expands selected logical object to every split part', () => {
  assert.equal(typeof PropertiesPanelModule.__test?.ratioTargetIds, 'function');
  const objects = {
    lead: {
      id: 'lead',
      sourceGroupId: 'sg1',
      logicalObjectId: 'lead',
      isInternalPart: false,
    },
    part: {
      id: 'part',
      sourceGroupId: 'sg1',
      logicalObjectId: 'lead',
      isInternalPart: true,
    },
  };
  assert.deepEqual(PropertiesPanelModule.__test.ratioTargetIds(['lead'], objects), ['lead', 'part']);
});

await test('1.13 default verb: relabel while the scale was never declared, convert once trusted', () => {
  const { defaultScaleVerb } = PropertiesPanelModule.__test;
  const assets = { stl: { id: 'stl', modelRatio: 1 }, glb: { id: 'glb', modelRatio: 72 } };
  assert.equal(defaultScaleVerb([{ assetId: 'stl', ratio: 1, ratioSource: 'default' }], assets), 'label', 'STL/OBJ → Set scale');
  assert.equal(defaultScaleVerb([{ assetId: 'glb', ratio: 72, ratioSource: 'file' }], assets), 'convert', 'glTF extras → Convert');
  assert.equal(defaultScaleVerb([{ assetId: 'stl', ratio: 72, ratioSource: 'user' }], assets), 'convert', 'declared by the user → Convert');
  assert.equal(defaultScaleVerb([{ assetId: 'stl' }], assets), 'label', 'absent source derives the seed (default)');
  assert.equal(defaultScaleVerb([{ assetId: 'glb' }], assets), 'convert', 'absent source derives the seed (file)');
  assert.equal(defaultScaleVerb([
    { assetId: 'stl', ratioSource: 'default' }, { assetId: 'glb', ratioSource: 'file' },
  ], assets), 'convert', 'mixed selection → convert (relabel only when NOTHING was declared)');
});

await test('1.13 consequence line: relabel never resizes; convert = old/new', () => {
  const { scaleConsequence } = PropertiesPanelModule.__test;
  assert.deepEqual(scaleConsequence([72], 35), { changed: true, factor: +(72 / 35).toFixed(6) });
  assert.deepEqual(scaleConsequence([1], 72), { changed: true, factor: +(1 / 72).toFixed(6) });
  assert.equal(scaleConsequence([72], 72).changed, false, 'same scale → nothing to apply');
  assert.equal(scaleConsequence([35, 72], 144).factor, null, 'mixed ratios → no single factor');
  assert.equal(scaleConsequence([72], 0).changed, false, 'invalid ratio ignored');
});

await test('4.6 Source status: ghost = missing; resolved status wins; else linked / embedded copy', () => {
  const { sourceStatusFor } = PropertiesPanelModule.__test;
  assert.equal(sourceStatusFor({ isGhost: true }, { id: 'x' }), 'missing');
  assert.equal(sourceStatusFor({}, { id: 'loose', filename: 'a.stl' }), 'embedded', 'no link, never resolved → embedded copy');
  assert.equal(sourceStatusFor({}, { id: 'fh', filename: 'a.stl', fileHandleKey: 'fh_1' }), 'linked');
  assert.equal(sourceStatusFor({}, { id: 'src', filename: 'a.stl', source: { kind: 'folder', refKey: 'k', path: 'a.stl', label: 'P' } }), 'linked');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
