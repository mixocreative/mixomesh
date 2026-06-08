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

await test('default printer profile is Mimaki 3DUJ-553 textured Materials Extension', () => {
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Mimaki 3DUJ-553');
  assert.equal(profile.format, '3mf-materials-ext');
  assert.equal(profile.color.mode, 'texture-uv');
  assert.deepEqual(profile.bed, { x: 508, y: 508, z: 305 });
});

await test('target printer selection resolves filament profile', () => {
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Bambu Lab X1 Carbon');
  assert.equal(profile.format, '3mf-colorgroup');
  assert.equal(profile.color.mode, 'solid-per-part');
});

await test('unknown target printer falls back to Mimaki default', () => {
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'unknown-printer' } }), { silent: true });
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Mimaki 3DUJ-553');
  assert.equal(profile.format, '3mf-materials-ext');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
