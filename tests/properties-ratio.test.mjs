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

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
