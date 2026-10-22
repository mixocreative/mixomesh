// cia A-05: the automation API's `projectSaved` event means bytes reached
// disk. Undo back to the saved point and File > New write nothing, so they
// must not emit it; a real Save emits it once.
//   node --import ./tests/register-hooks.mjs --test tests/api-project-saved-a05.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { createAppDispatcher } = await import('../src/core/api/AppDispatcherDeps.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { SettingsStore } = await import('../src/core/SettingsStore.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { Toast } = await import('../src/ui/Toast.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
SceneManager.setCursorFromState = () => {};
SettingsStore.seedBootState = () => {};
SettingsStore.applyToScene = () => {};
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
storage.writeFile = async () => {};
storage.persistRef = async () => null;
storage.kvGet = async () => [];
storage.kvSet = async () => {};
storage.kvDelete = async () => {};
storage.kvKeys = async () => [];
storage.pickSaveProject = async () => ({ ref: { name: 'p.mixo' }, name: 'p.mixo' });
PersistenceManager.init();

const events = [];
const d = await createAppDispatcher({ notify: e => events.push(e) });
await d.dispatch('events.subscribe', { events: ['projectSaved'] });
const saved = () => events.filter(e => e.type === 'projectSaved').length;

test('undo back to the saved point emits no projectSaved', () => {
  events.length = 0;
  HistoryManager.push({ label: 'move', execute() {}, undo() {} });
  HistoryManager.undo();
  assert.equal(PersistenceManager.isDirty(), false, 'the project reads clean again');
  assert.equal(saved(), 0, 'but nothing was written');
});

test('File > New emits no projectSaved', async () => {
  events.length = 0;
  await PersistenceManager.newProject();
  assert.equal(saved(), 0);
});

test('a real Save emits projectSaved once', async () => {
  events.length = 0;
  HistoryManager.push({ label: 'move', execute() {}, undo() {} });
  assert.equal(await PersistenceManager.save(), true);
  assert.equal(saved(), 1);
});
