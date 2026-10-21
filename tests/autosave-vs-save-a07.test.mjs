// cia A-07: an autosave tick that straddles an explicit Save must not leave a
// pre-save snapshot behind, or the next boot offers to "recover" content
// older than the file.
//   node --import ./tests/register-hooks.mjs --test tests/autosave-vs-save-a07.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { autosaveTick, findRecoverableAutosave } = await import('../src/core/persist/Autosave.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { setState } = await import('../src/core/StateManager.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { Toast } = await import('../src/ui/Toast.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
PersistenceManager.init();

const kv = new Map();
const autosaveKeys = () => [...kv.keys()].filter(k => k.startsWith('autosave_'));
storage.kvGet = async k => kv.get(k);
storage.kvKeys = async () => [...kv.keys()];
storage.kvDelete = async k => { kv.delete(k); };
let gate = null;
storage.kvSet = async (k, v) => { if (gate && String(k).startsWith('autosave_')) await gate; kv.set(k, v); };
storage.writeFile = async () => {};
storage.persistRef = async () => null;
storage.pickSaveProject = async () => ({ ref: { name: 'p.mixo' }, name: 'p.mixo' });

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const edit = () => HistoryManager.push({ label: 'edit', execute() {}, undo() {} });

test('a tick whose write lands after the Save leaves nothing to recover', async () => {
  edit();
  let release;
  gate = new Promise(r => { release = r; });
  const ticking = autosaveTick();      // built, now writing the snapshot (slow IDB write)
  await tick();
  assert.equal(await PersistenceManager.save(), true);
  assert.deepEqual(autosaveKeys(), [], 'the save cleared the autosave');
  release();
  await ticking;
  gate = null;
  assert.deepEqual(autosaveKeys(), [], 'the straddling tick did not resurrect a pre-save snapshot');
  assert.equal(await findRecoverableAutosave(), null, 'next boot offers nothing');
});

test('a tick that is still building when the Save completes writes nothing', async () => {
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { a1: { id: 'a1', name: 'loose', filename: 'loose.stl', extension: '.stl', kind: 'mesh', contentHash: 'h1' } },
    objects: { o1: { id: 'o1', name: 'loose', assetId: 'a1', ratio: 1 } },
  } }), { silent: true });
  edit();
  let release;
  const buildGate = new Promise(r => { release = r; });
  let firstEmbed = true;   // the tick's embed is slow; the Save's goes straight through
  AssetLoader.getAssetBytes = async () => {
    if (firstEmbed) { firstEmbed = false; await buildGate; }   // a loose drop embeds even in autosave
    return new Uint8Array([1]).buffer;
  };
  const ticking = autosaveTick();
  await tick();
  assert.equal(await PersistenceManager.save(), true);
  release();
  assert.equal(await ticking, false);
  assert.deepEqual(autosaveKeys(), []);
  AssetLoader.getAssetBytes = async () => new Uint8Array([1]).buffer;
});

test('an edit after the Save is snapshotted by the next tick as usual', async () => {
  edit();
  assert.equal(await autosaveTick(), true);
  assert.equal(autosaveKeys().length, 1);
});
