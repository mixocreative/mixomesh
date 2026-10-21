// cia B-02: autosave has a liveness signal. The status bar shows when the last
// snapshot was written, and a failing or skipped autosave stays visible there
// (persistently, not one dismissable toast) until a snapshot succeeds.
//   node --import ./tests/register-hooks.mjs --test tests/autosave-liveness-b02.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

// Minimal status-bar DOM: three segments whose innerHTML we can read back.
const segments = {};
const fakeEl = (id) => ({
  id, innerHTML: '', textContent: '', title: '',
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector() { return null; }, appendChild() {},
});
globalThis.document = {
  ...globalThis.document,
  getElementById: (id) => {
    if (id === 'status-bar') return { set innerHTML(_) { for (const s of ['sb-left', 'sb-center', 'sb-right']) segments[s] = fakeEl(s); } };
    return segments[id] ?? null;
  },
};

const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { autosaveTick, autosaveStatus } = await import('../src/core/persist/Autosave.js');
const { StatusBar } = await import('../src/ui/StatusBar.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { Toast } = await import('../src/ui/Toast.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
StatusBar.init();
PersistenceManager.init();

const kv = new Map();
storage.kvGet = async k => kv.get(k);
storage.kvKeys = async () => [...kv.keys()];
storage.kvDelete = async k => { kv.delete(k); };
let kvSetFails = false;
storage.kvSet = async (k, v) => { if (kvSetFails) throw new Error('IndexedDB is blocked'); kv.set(k, v); };
const right = () => segments['sb-right'].innerHTML;
const edit = () => HistoryManager.push({ label: 'edit', execute() {}, undo() {} });

test('a successful snapshot shows "autosaved" with its time in the status bar', async () => {
  edit();
  assert.equal(await autosaveTick(), true);
  const status = autosaveStatus();
  assert.equal(status.state, 'written');
  assert.ok(status.lastWrittenAt, 'the status carries the write time');
  assert.match(right(), /status\.autosaved|Autosaved/, 'the status bar names the last autosave');
});

test('three consecutive failures stay visible in the status bar until a snapshot succeeds', async () => {
  kvSetFails = true;
  for (let i = 0; i < 3; i++) assert.equal(await autosaveTick(), false);
  const status = autosaveStatus();
  assert.equal(status.state, 'failing');
  assert.equal(status.failures, 3, 'every failure counts, not just the first');
  assert.match(status.lastError, /IndexedDB is blocked/);
  assert.match(right(), /status\.autosaveFailed|Autosave failed/, 'the failure is on a persistent surface');

  kvSetFails = false;
  assert.equal(await autosaveTick(), true);
  assert.equal(autosaveStatus().state, 'written');
  assert.doesNotMatch(right(), /status\.autosaveFailed|Autosave failed/, 'cleared by the next success');
});

test('ticks skipped three times in a row while dirty read "paused" with the reason', async () => {
  edit();
  AssetLoader.isImporting = () => true;   // an import depth that never unwinds
  try {
    for (let i = 0; i < 3; i++) assert.equal(await autosaveTick(), false);
    assert.equal(autosaveStatus().state, 'paused');
    assert.match(right(), /status\.autosavePaused|Autosave paused/);
  } finally {
    AssetLoader.isImporting = () => false;
  }
  assert.equal(await autosaveTick(), true);
  assert.equal(autosaveStatus().state, 'written');
});
