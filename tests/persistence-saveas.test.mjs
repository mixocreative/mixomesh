// saveAs writes to the picked handle FIRST; only a successful write binds the
// handle and renames the project (audit 2026-09-17 M1). A failing write must
// leave the previous handle + name untouched (no 0-byte file "adopted").
//   node --import ./tests/register-hooks.mjs tests/persistence-saveas.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { getState, setState, subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { Toast } = await import('../src/ui/Toast.js');
Toast.show = () => {};

SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;

let savedEvents = 0;
subscribe(EVENTS.PROJECT_SAVED, () => { savedEvents++; });

function handle(name, { failWrite = false } = {}) {
  const h = {
    name, kind: 'file', writes: [],
    async createWritable() {
      return {
        write: async (text) => { if (failWrite) throw new Error('disk full'); h.writes.push(text); },
        close: async () => {},
      };
    },
  };
  return h;
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('saveAs: successful write binds the handle, renames, dispatches saved', async () => {
  setState(s => ({ ...s, project: { ...s.project, name: 'First' } }), { silent: true });
  const good = handle('Renamed.mixo');
  window.showSaveFilePicker = async () => good;
  savedEvents = 0;
  assert.equal(await PersistenceManager.saveAs(), true);
  assert.equal(getState().project.name, 'Renamed');
  assert.equal(good.writes.length, 1);
  assert.equal(JSON.parse(good.writes[0]).project.name, 'Renamed', 'written doc carries the NEW name');
  assert.ok(savedEvents >= 1);
  // Bound: plain save() now writes to `good` without a picker.
  window.showSaveFilePicker = async () => { throw new Error('picker must not open'); };
  assert.equal(await PersistenceManager.save(), true);
  assert.equal(good.writes.length, 2);
});

await test('saveAs: failing write → previous handle + name unchanged, no saved event', async () => {
  const bad = handle('Broken.mixo', { failWrite: true });
  window.showSaveFilePicker = async () => bad;
  savedEvents = 0;
  await assert.rejects(PersistenceManager.saveAs(), /disk full/);
  assert.equal(getState().project.name, 'Renamed', 'name NOT renamed');
  assert.equal(savedEvents, 0, 'no PROJECT_SAVED on failure');
  // Previous handle still bound: save() writes to the old good handle.
  window.showSaveFilePicker = async () => { throw new Error('picker must not open'); };
  assert.equal(await PersistenceManager.save(), true);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
