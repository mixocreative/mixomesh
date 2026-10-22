import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const { setState } = await import('../src/core/StateManager.js');
const { getPrinterProfile, normalizePrinterProfile, listPrinterProfiles, printerProfileExists } = await import('../src/core/print/PrinterProfiles.js');
const DS = (await import('../src/config/default-settings.json', { with: { type: 'json' } })).default;

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

await test('#24: factory bedDimensions match the factory targetPrinterId (no config drift)', () => {
  // bedDimensions + targetPrinterId are stored independently in
  // default-settings.json and reset together on New — if an edit changes one
  // but not the other they silently desync (the bed preview would lie about
  // the selected printer). Pin the invariant at the config source of truth.
  const expected = getPrinterProfile(DS.print.targetPrinterId).bed;
  assert.deepEqual(DS.print.bedDimensions, expected,
    `default-settings bedDimensions ${JSON.stringify(DS.print.bedDimensions)} != bed of ${DS.print.targetPrinterId} ${JSON.stringify(expected)}`);
});

await test('unknown target printer falls back to Mimaki default', () => {
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'unknown-printer' } }), { silent: true });
  const profile = getPrinterProfile();
  assert.equal(profile.displayName, 'Mimaki 3DUJ-553');
  assert.deepEqual(profile.bed, { x: 508, y: 508, z: 305 });
});
await test('v1 row (displayName/vendor/bed/defaultMaterialId only) normalises with v2 defaults', () => {
  const p = normalizePrinterProfile('legacy', { displayName: 'Old', vendor: 'V', bed: { x: 100, y: 90, z: 80 }, defaultMaterialId: 'petg' });
  assert.equal(p.id, 'legacy');
  assert.equal(p.process, 'fdm');
  assert.deepEqual(p.bed, { x: 100, y: 90, z: 80 });
  assert.equal(p.colour.mode, 'none');
  assert.equal(p.export.recommended, 'stl');
  assert.equal(p.export.splitByMaterial, false);
  assert.equal(p.export.obj.axis, 'y-up');
  assert.equal(p.export.threeMF.flavour, 'core');
  assert.equal(p.validation.requireWatertight, true);
  assert.equal(p.defaultMaterialId, 'petg');
  const bare = normalizePrinterProfile('x', {});
  assert.deepEqual(bare.bed, { x: null, y: null, z: null });
  assert.equal(bare.defaultMaterialId, 'pla');
});

await test('v2 rows resolve: Mimaki recommends OBJ, Bambu/Prusa flavours, Custom bed is unset', () => {
  assert.equal(getPrinterProfile('mimaki-3duj-553').export.recommended, 'obj-mtl');
  assert.equal(getPrinterProfile('bambu-x1c').export.threeMF.flavour, 'bambu');
  assert.equal(getPrinterProfile('prusa-xl').export.threeMF.flavour, 'prusa');
  for (const id of ['stratasys-j55', 'stratasys-j850', 'hp-mjf-580', 'bambu-h2d', 'prusa-xl', 'creality-k1', 'creality-ender-3', 'elegoo-centauri-carbon', 'anycubic-kobra-3', 'anycubic-photon-mono', 'formlabs-form-4']) {
    assert.ok(printerProfileExists(id), id);
  }
  assert.deepEqual(getPrinterProfile('custom').bed, { x: null, y: null, z: null });
});


console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
