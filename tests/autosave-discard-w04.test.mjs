// cia W-04: work the user explicitly discarded must not come back as
// "Recover unsaved work" on the next launch. Discard in the unsaved-changes
// dialog (New project, window close) drops the autosave; Save keeps nothing
// stale either; Cancel keeps it (the work is still live).
//   node --import ./tests/register-hooks.mjs --test tests/autosave-discard-w04.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { autosaveTick, findRecoverableAutosave } = await import('../src/core/persist/Autosave.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { SettingsStore } = await import('../src/core/SettingsStore.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { Toast } = await import('../src/ui/Toast.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
SceneManager.setCursorFromState = () => {};
SettingsStore.seedBootState = () => {};
SettingsStore.applyToScene = () => {};
for (const k of ['rebuildBed', 'setGrid', 'setWireframeEdgeColor', 'setOverlay', 'applyRenderSettings', 'setScaleLock',
  'setFollowMode', 'setCursorVisible', 'setActive', 'setSelected', 'attachToSelection', 'updateBedPreview']) SceneManager[k] = () => {};
const { Selection } = await import('../src/core/Selection.js');
Selection.clear = () => {}; Selection.set = () => {}; Selection.refresh = () => {};
const { MeshValidator } = await import('../src/core/MeshValidator.js');
MeshValidator.shouldAutoValidate = () => false;
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
PersistenceManager.init();

const kv = new Map();
const autosaveKeys = () => [...kv.keys()].filter(k => k.startsWith('autosave_'));
storage.kvGet = async k => kv.get(k);
storage.kvKeys = async () => [...kv.keys()];
storage.kvDelete = async k => { kv.delete(k); };
storage.kvSet = async (k, v) => { kv.set(k, v); };
storage.writeFile = async () => {};
storage.persistRef = async () => null;
storage.pickSaveProject = async () => ({ ref: { name: 'p.mixo' }, name: 'p.mixo' });

let answer = 'discard';
subscribe(EVENTS.MODAL_OPEN, p => { if (p?.id === 'dirtyConfirm') p.onClose?.(answer); });
const edit = () => HistoryManager.push({ label: 'edit', execute() {}, undo() {} });

async function dirtyWithAutosave() {
  edit();
  assert.equal(await autosaveTick(), true);
  assert.equal(autosaveKeys().length, 1, 'precondition: an autosave exists');
}

test('New project + Discard drops the autosave; the next launch offers nothing', async () => {
  await dirtyWithAutosave();
  answer = 'discard';
  await PersistenceManager.newProject();
  assert.deepEqual(autosaveKeys(), []);
  assert.equal(await findRecoverableAutosave(), null);
});

test('New project + Cancel keeps the autosave (the work is still open)', async () => {
  await dirtyWithAutosave();
  answer = 'cancel';
  await PersistenceManager.newProject();
  assert.equal(autosaveKeys().length, 1);
  assert.ok(await findRecoverableAutosave());
});

test('window close + Discard drops the autosave', async () => {
  answer = 'discard';
  assert.deepEqual(await PersistenceManager.requestClose(), { action: 'discard' });
  assert.deepEqual(autosaveKeys(), []);
  assert.equal(await findRecoverableAutosave(), null);
});

test("Open + Discard drops the discarded project's autosave (loader already did this; pinned)", async () => {
  await dirtyWithAutosave();
  answer = 'discard';
  const doc = JSON.stringify({ version: '3.4', project: { name: 'Other', id: 'p_other' }, scene: {} });
  await PersistenceManager.openPicked({ ref: { name: 'Other.mixo' }, file: new Blob([doc]) });
  assert.deepEqual(autosaveKeys(), []);
  assert.equal(await findRecoverableAutosave(), null);
});
