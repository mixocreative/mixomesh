// cia A-08: a Save still in flight must write only to the file that was bound
// when it started, and an Open that arrives meanwhile must wait for it instead
// of rebinding the target under the write.
//   node --import ./tests/register-hooks.mjs --test tests/save-target-a08.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { setState, getState } = await import('../src/core/StateManager.js');
const { Toast } = await import('../src/ui/Toast.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { Selection } = await import('../src/core/Selection.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');

Toast.show = () => {};
MeshValidator.shouldAutoValidate = () => false;
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
for (const k of ['rebuildBed', 'setGrid', 'setCursorFromState', 'setWireframeEdgeColor', 'setOverlay', 'applyRenderSettings',
  'setScaleLock', 'setFollowMode', 'setCursorVisible', 'setActive', 'setSelected', 'attachToSelection', 'updateBedPreview']) SceneManager[k] = () => {};
Selection.clear = () => {}; Selection.set = () => {}; Selection.refresh = () => {};
AssetLoader.getBabylonMesh = () => null;
PersistenceManager.init();

const REF_A = { name: 'A.mixo', tag: 'A' };
const REF_B = { name: 'B.mixo', tag: 'B' };
const writes = [];
storage.writeFile = async (ref, text) => { writes.push({ to: ref?.tag ?? String(ref), project: JSON.parse(text).project.name }); };
storage.persistRef = async () => null;
storage.kvGet = async () => [];
storage.kvSet = async () => {};
storage.kvDelete = async () => {};
storage.kvKeys = async () => [];
storage.pickSaveProject = async () => ({ ref: REF_A, name: 'A.mixo' });

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('a Save in flight on A keeps writing A even when B is opened meanwhile', async () => {
  setState(s => ({ ...s, project: { ...s.project, name: 'A' }, scene: { ...s.scene,
    assetLibrary: { a1: { id: 'a1', name: 'big', filename: 'big.stl', extension: '.stl', kind: 'mesh', contentHash: 'h' } },
    objects: { o1: { id: 'o1', name: 'big', assetId: 'a1', ratio: 1 } } } }), { silent: true });
  AssetLoader.getAssetBytes = async () => new Uint8Array([1]).buffer;
  assert.equal(await PersistenceManager.saveAs(), true);
  writes.length = 0;

  let release;
  const gate = new Promise(r => { release = r; });
  AssetLoader.getAssetBytes = async () => { await gate; return new Uint8Array([1]).buffer; };

  const saving = PersistenceManager.save();
  await tick();
  const docB = JSON.stringify({ version: '3.4', project: { name: 'B', id: 'p_b' }, scene: {} });
  const opening = PersistenceManager.openPicked({ ref: REF_B, file: new Blob([docB]) });
  await tick();
  assert.equal(getState().project.name, 'A', 'the open waits while the save is writing');

  release();
  assert.equal(await saving, true);
  await opening;
  assert.equal(getState().project.name, 'B');
  assert.deepEqual(writes, [{ to: 'A', project: 'A' }], 'only A.mixo was written, and only with A');

  await PersistenceManager.save();
  assert.deepEqual(writes.at(-1), { to: 'B', project: 'B' }, 'after the open, Save targets B');
});
