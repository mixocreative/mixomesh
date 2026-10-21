// cia A-01: an edit made while a save is writing is not in the file, so the
// project must still read dirty when that save completes.
//   node --import ./tests/register-hooks.mjs --test tests/save-dirty-race-a01.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { markDirty, setState, subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { Toast } = await import('../src/ui/Toast.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
PersistenceManager.init();

const REF = { name: 'p.mixo' };
let gate = null;
const written = [];
storage.writeFile = async (ref, text) => { if (gate) await gate; written.push(text); };
storage.persistRef = async () => null;
storage.kvGet = async () => [];
storage.kvSet = async () => {};
storage.kvDelete = async () => {};
storage.kvKeys = async () => [];
storage.pickSaveProject = async () => ({ ref: REF, name: 'p.mixo' });

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const edit = (label) => HistoryManager.push({
  label,
  execute() { setState(st => ({ ...st, scene: { ...st.scene, userSwatches: [...st.scene.userSwatches, label] } }), { silent: true }); },
  undo() { setState(st => ({ ...st, scene: { ...st.scene, userSwatches: st.scene.userSwatches.filter(x => x !== label) } }), { silent: true }); },
});

test('an undoable edit during the write leaves the project dirty; undoing it reads clean', async () => {
  edit('before save');
  assert.equal(PersistenceManager.isDirty(), true);
  let release;
  gate = new Promise(r => { release = r; });
  const saving = PersistenceManager.save();
  await tick();
  edit('during write');
  release();
  assert.equal(await saving, true);
  assert.ok(!JSON.parse(written.at(-1)).userSwatches.includes('during write'), 'the file predates the edit');
  assert.equal(PersistenceManager.isDirty(), true, 'edit made during the write is not saved');
  HistoryManager.undo();
  assert.equal(PersistenceManager.isDirty(), false, 'back at the state the file holds');
  HistoryManager.redo();
  assert.equal(PersistenceManager.isDirty(), true);
});

test('a non-undoable change during the write stays sticky-dirty after the save', async () => {
  gate = null;
  assert.equal(await PersistenceManager.save(), true);
  assert.equal(PersistenceManager.isDirty(), false);
  let release;
  gate = new Promise(r => { release = r; });
  const saving = PersistenceManager.save();
  await tick();
  markDirty();
  release();
  assert.equal(await saving, true);
  assert.equal(PersistenceManager.isDirty(), true, 'import that landed mid-write is not in the file');
  gate = null;
  assert.equal(await PersistenceManager.save(), true);
  assert.equal(PersistenceManager.isDirty(), false, 'the next save picks it up');
});

test('PROJECT_SAVED listeners see the post-save dirty answer, in any subscription order', async () => {
  gate = null;
  await PersistenceManager.save();
  const seen = [];
  const off = subscribe(EVENTS.PROJECT_SAVED, () => seen.push(PersistenceManager.isDirty()));
  let release;
  gate = new Promise(r => { release = r; });
  const saving = PersistenceManager.save();
  await tick();
  edit('late');
  release();
  await saving;
  off();
  assert.deepEqual(seen, [true], 'a UI listener reading isDirty() on PROJECT_SAVED gets the truth');
});
