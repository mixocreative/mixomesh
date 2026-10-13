// Printer profile defaults vs user overrides (task 1.3, Decision 32):
// ApplyPrinterProfileCommand is ONE undo step, user edits are their own
// steps, and "modified" is derived from the profile at read time.
//   node --import ./tests/register-hooks.mjs tests/printer-commands.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { getState, setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const HM = await import('../src/core/HistoryManager.js');
const { modifiedFields, effectivePrintSettings, profileDefaults, formatKeyOf } = await import('../src/core/print/PrintProfileSettings.js');
const { getPrinterProfile } = await import('../src/core/print/PrinterProfiles.js');

let bedRebuilds = 0;
SceneManager.rebuildBed = () => { bedRebuilds++; };
SceneManager.updateBedPreview = () => {};

function reset() {
  HM.clear();
  setState(s => ({
    ...s,
    print: {
      ...s.print, targetPrinterId: 'mimaki-3duj-553', bedDimensions: { x: 508, y: 508, z: 305 },
      exportFormat: null, splitByMaterial: null, objAxis: null, threeMFFlavour: null, individually: false,
    },
  }), { silent: true });
}

test('formatKeyOf maps printers.json format ids to writer keys', () => {
  assert.equal(formatKeyOf('obj-mtl'), 'obj');
  assert.equal(formatKeyOf('3mf-bambu'), '3mf');
  assert.equal(formatKeyOf('3mf-textured'), '3mf');
  assert.equal(formatKeyOf('wrl'), 'wrl');
  assert.equal(formatKeyOf('gltf'), null);
});

test('Bambu X1C profile defaults: 3MF (bambu flavour), split by material, Z-up, 256³ bed', () => {
  const d = profileDefaults(getPrinterProfile('bambu-x1c'));
  assert.deepEqual(d, {
    exportFormat: '3mf', splitByMaterial: true, objAxis: 'z-up', threeMFFlavour: 'bambu',
    bedDimensions: { x: 256, y: 256, z: 256 },
  });
  assert.equal(profileDefaults(getPrinterProfile('custom')).bedDimensions, null, 'Custom has no finite bed');
});

test('selecting a printer applies every profile field in ONE undo step', () => {
  reset();
  bedRebuilds = 0;
  HM.push(new HM.ApplyPrinterProfileCommand('bambu-x1c'));
  const p = getState().print;
  assert.equal(p.targetPrinterId, 'bambu-x1c');
  assert.equal(p.exportFormat, '3mf');
  assert.equal(p.threeMFFlavour, 'bambu');
  assert.equal(p.objAxis, 'z-up');
  assert.equal(p.splitByMaterial, true);
  assert.deepEqual(p.bedDimensions, { x: 256, y: 256, z: 256 });
  assert.equal(bedRebuilds, 1, 'the floor is rebuilt for the new bed');
  assert.deepEqual(modifiedFields(p), {}, 'freshly applied profile → nothing modified');

  HM.undo();
  const back = getState().print;
  assert.equal(back.targetPrinterId, 'mimaki-3duj-553', 'one Ctrl+Z restores the previous printer');
  assert.deepEqual(back.bedDimensions, { x: 508, y: 508, z: 305 });
  assert.equal(back.exportFormat, null);
});

test('override → modified; Printer default ↺ reverts; Ctrl+Z restores the override', () => {
  reset();
  HM.push(new HM.ApplyPrinterProfileCommand('bambu-x1c'));
  HM.push(new HM.SetPrintSettingsCommand({ exportFormat: 'stl' }));
  assert.deepEqual(modifiedFields(getState().print), { exportFormat: '3mf' }, 'STL differs from the profile (3MF)');
  assert.equal(effectivePrintSettings(getState().print).exportFormat, 'stl');

  HM.push(new HM.ApplyPrinterProfileCommand(getState().print.targetPrinterId));   // Printer default ↺
  assert.equal(getState().print.exportFormat, '3mf');
  assert.deepEqual(modifiedFields(getState().print), {});

  HM.undo();
  assert.equal(getState().print.exportFormat, 'stl', 'undo after Printer default restores the override');
  assert.ok('exportFormat' in modifiedFields(getState().print));
});

test('Custom keeps the current bed (no null axes written)', () => {
  reset();
  HM.push(new HM.ApplyPrinterProfileCommand('custom'));
  assert.deepEqual(getState().print.bedDimensions, { x: 508, y: 508, z: 305 });
  assert.equal(getState().print.exportFormat, 'stl');
  HM.push(new HM.SetPrintSettingsCommand({ bedDimensions: { x: 100, y: 100, z: 100 } }));
  assert.equal('bedDimensions' in modifiedFields(getState().print), false, 'a Custom bed is always the user\'s own');
});

test('a changed bed on a named printer counts as modified', () => {
  reset();
  HM.push(new HM.SetPrintSettingsCommand({ bedDimensions: { x: 500, y: 508, z: 305 } }));
  assert.deepEqual(modifiedFields(getState().print).bedDimensions, { x: 508, y: 508, z: 305 });
});

test('SetPrintSettingsCommand ignores keys outside the print-settings allow-list', () => {
  reset();
  HM.push(new HM.SetPrintSettingsCommand({ exportFormat: 'ply', strictExport: true, bogus: 1 }));
  assert.equal(getState().print.exportFormat, 'ply');
  assert.equal(getState().print.strictExport, false, 'per-user strictExport is not a project command');
  assert.equal('bogus' in getState().print, false);
});

test('SetReferenceObjectCommand is undoable', () => {
  reset();
  setState(s => ({ ...s, print: { ...s.print, referenceObjectId: null } }), { silent: true });
  HM.push(new HM.SetReferenceObjectCommand('tank'));
  assert.equal(getState().print.referenceObjectId, 'tank');
  HM.undo();
  assert.equal(getState().print.referenceObjectId, null);
});
