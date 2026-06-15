import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const { setState } = await import('../src/core/StateManager.js');
const { getPrinterProfile } = await import('../src/core/print/PrinterProfiles.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('default printer profile is Mimaki 3DUJ-553 bed reference', () => {
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Mimaki 3DUJ-553');
  assert.deepEqual(profile.bed, { x: 508, y: 508, z: 305 });
});

await test('target printer selection resolves filament profile', () => {
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Bambu Lab X1 Carbon');
  assert.deepEqual(profile.bed, { x: 256, y: 256, z: 256 });
});

await test('unknown target printer falls back to Mimaki default', () => {
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'unknown-printer' } }), { silent: true });
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Mimaki 3DUJ-553');
  assert.deepEqual(profile.bed, { x: 508, y: 508, z: 305 });
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
