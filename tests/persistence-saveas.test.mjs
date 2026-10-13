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
const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
const { storage } = await import('../src/core/storage/StorageAdapter.js');

SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;

let savedEvents = 0;
subscribe(EVENTS.PROJECT_SAVED, () => { savedEvents++; });

function handle(name, { failWrite = false } = {}) {
  const h = {
    name, kind: 'file', writes: [], aborts: 0,
    async createWritable() {
      return {
        write: async (text) => { if (failWrite) throw new Error('disk full'); h.writes.push(text); },
        close: async () => {},
        abort: async () => { h.aborts++; },
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

await test('failed write aborts the writable (no half-written file)', async () => {
  const bad = handle('Broken2.mixo', { failWrite: true });
  window.showSaveFilePicker = async () => bad;
  await assert.rejects(PersistenceManager.saveAs(), /disk full/);
  assert.equal(bad.aborts, 1, 'w.abort() called once');
});

await test('pushRecent failure after a good write: save() still resolves true, failure reported', async () => {
  const good = handle('Recent.mixo');
  window.showSaveFilePicker = async () => good;
  assert.equal(await PersistenceManager.saveAs(), true);   // binds `good`
  const origGet = storage.kvGet;
  storage.kvGet = async () => { throw new Error('idb quota'); };
  toasts.length = 0;
  try {
    assert.equal(await PersistenceManager.save(), true, 'save() must not reject');
  } finally { storage.kvGet = origGet; }
  assert.equal(good.writes.length, 2, 'bytes were written');
  assert.ok(toasts.some(x => x.type === 'warning' && /idb quota/.test(x.msg)), 'failure surfaced via toast');
});

function stubNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

await test('navigator.storage.persist() requested once on first successful save, never again', async () => {
  // Earlier tests already saved (flag consumed) — load a fresh module instance.
  const fresh = await import('../src/core/PersistenceManager.js?fresh=persist');
  let persistCalls = 0;
  stubNavigator({ storage: { persist: async () => { persistCalls++; return true; } } });
  try {
    window.showSaveFilePicker = async () => handle('Persist.mixo');
    await fresh.PersistenceManager.saveAs();
    await fresh.PersistenceManager.save();
    assert.equal(persistCalls, 1, 'persist() called exactly once');
    // Throwing / missing persist never fails a save.
    stubNavigator({ storage: { persist: () => { throw new Error('nope'); } } });
    assert.equal(await fresh.PersistenceManager.save(), true);
    stubNavigator({});
    assert.equal(await fresh.PersistenceManager.save(), true);
  } finally { delete globalThis.navigator; }
});

await test('navigator.storage.persist() skipped under Electron', async () => {
  const fresh = await import('../src/core/PersistenceManager.js?fresh=electron');
  let persistCalls = 0;
  stubNavigator({ storage: { persist: async () => { persistCalls++; return true; } } });
  window.electronAPI = {};
  try {
    window.showSaveFilePicker = async () => handle('Desk.mixo');
    await fresh.PersistenceManager.saveAs();
    assert.equal(persistCalls, 0);
  } finally { delete window.electronAPI; delete globalThis.navigator; }
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
