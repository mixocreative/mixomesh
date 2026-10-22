// cia A-08 follow-up: Save / Save As pressed while a project is still loading
// must not write the half-loaded scene; the user is told why nothing was saved.
//   node --import ./tests/register-hooks.mjs --test tests/save-during-load-a08.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { getState } = await import('../src/core/StateManager.js');
const { Toast } = await import('../src/ui/Toast.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { Selection } = await import('../src/core/Selection.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');

const toasts = [];
Toast.show = (msg, kind) => { toasts.push({ msg, kind }); };
MeshValidator.shouldAutoValidate = () => false;
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
for (const k of ['rebuildBed', 'setGrid', 'setCursorFromState', 'setWireframeEdgeColor', 'setOverlay', 'applyRenderSettings',
  'setScaleLock', 'setFollowMode', 'setCursorVisible', 'setActive', 'setSelected', 'attachToSelection', 'updateBedPreview']) SceneManager[k] = () => {};
Selection.clear = () => {}; Selection.set = () => {}; Selection.refresh = () => {};
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
PersistenceManager.init();

const writes = [];
let pickerOpened = 0;
storage.writeFile = async (ref, text) => { writes.push(JSON.parse(text)); };
storage.persistRef = async () => null;
storage.kvGet = async () => [];
storage.kvSet = async () => {};
storage.kvDelete = async () => {};
storage.kvKeys = async () => [];
storage.pickSaveProject = async () => { pickerOpened++; return { ref: { name: 'X.mixo' }, name: 'X.mixo' }; };

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function slowDoc() {
  return JSON.stringify({
    version: '3.4',
    project: { name: 'Loaded', id: 'p_loaded' },
    assetLibrary: [{ id: 'a1', name: 'part', filename: 'part.stl', extension: '.stl', kind: 'mesh', fileHandleKey: 'k1' }],
    sceneObjects: [],
  });
}

async function withLoadInFlight(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  storage.resolveAsset = async () => { await gate; return null; };
  const opening = PersistenceManager.openPicked({ ref: { name: 'L.mixo' }, file: new Blob([slowDoc()]) });
  await tick();
  assert.equal(PersistenceManager.isLoading(), true, 'the load is still in flight');
  try { return await fn(); } finally { release(); await opening; }
}

test('Ctrl+S while a project loads writes nothing and says why', async () => {
  writes.length = 0; toasts.length = 0; pickerOpened = 0;
  const saved = await withLoadInFlight(() => PersistenceManager.save());
  assert.equal(saved, false, 'save reports that nothing was written');
  assert.equal(writes.length, 0, 'no half-loaded document reached disk');
  assert.equal(pickerOpened, 0, 'no Save As picker was offered for a half-loaded scene');
  assert.ok(toasts.some(t => t.kind === 'warning' || t.kind === 'error'), 'the user was told');
});

test('Save As while a project loads writes nothing', async () => {
  writes.length = 0; toasts.length = 0;
  const saved = await withLoadInFlight(() => PersistenceManager.saveAs());
  assert.equal(saved, false);
  assert.equal(writes.length, 0);
  assert.ok(toasts.length > 0);
});

test('after the load finishes, Save writes the loaded project', async () => {
  writes.length = 0;
  assert.equal(PersistenceManager.isLoading(), false);
  assert.equal(await PersistenceManager.save(), true);
  assert.equal(writes.at(-1).project.name, getState().project.name);
});
