// cia W-00: saving a project that holds a 5M-triangle model froze the tab.
// The whole document became one giant JSON string on the main thread (the
// other half, not embedding deleted / unreferenced assets, is escalated in
// .audit/pending/W-00-unreferenced-assets.md). Contract now: the document is
// handed to the adapter in parts. A small document is one string; a document
// with a large embedded asset is a Blob whose parts hold the base64
// separately, and it reads back identical.
//   node --import ./tests/register-hooks.mjs --test tests/save-heavy-document-w00.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const Serializer = await import('../src/core/persist/ProjectSerializer.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { Toast } = await import('../src/ui/Toast.js');

Toast.show = () => {};
SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getContainerGeomMeshes = () => [];
PersistenceManager.init();

const asset = (id, extra = {}) => ({ id, name: id, filename: `${id}.stl`, extension: '.stl', kind: 'mesh', contentHash: `h_${id}`, ...extra });
const bytesOf = {};
AssetLoader.getAssetBytes = async (id) => bytesOf[id] ?? null;

test('a small document is written as one string; a large embedded asset makes it a Blob that reads back identical', async () => {
  const written = [];
  storage.writeFile = async (ref, data) => { written.push(data); };
  storage.persistRef = async () => null;
  storage.kvGet = async () => [];
  storage.kvSet = async () => {};
  storage.kvDelete = async () => {};
  storage.kvKeys = async () => [];
  storage.pickSaveProject = async () => ({ ref: { name: 'p.mixo' }, name: 'p.mixo' });

  bytesOf.small = new Uint8Array([9, 8, 7]).buffer;
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { small: asset('small') },
    objects: { o1: { id: 'o1', name: 'small', assetId: 'small', ratio: 1 } },
  } }), { silent: true });
  assert.equal(await PersistenceManager.saveAs(), true);
  assert.equal(typeof written.at(-1), 'string', 'a small document stays one string');

  const big = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  bytesOf.big = big.buffer;
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { big: asset('big'), small: asset('small') },
    objects: { o1: { id: 'o1', name: 'big', assetId: 'big', ratio: 1 }, o2: { id: 'o2', name: 'small', assetId: 'small', ratio: 1 } },
  } }), { silent: true });
  assert.equal(await PersistenceManager.save(), true);
  const data = written.at(-1);
  assert.ok(data instanceof Blob, 'a document with a large embedded asset is handed over as a Blob, never one giant string');
  const parsed = JSON.parse(await data.text());
  const embedded = parsed.assetLibrary.find(a => a.id === 'big').fileData;
  assert.deepEqual([...Serializer.bufFromB64(embedded)], [...big], 'the embedded bytes round-trip exactly');
  assert.equal(parsed.assetLibrary.find(a => a.id === 'small').fileData, Serializer.b64FromBuf(bytesOf.small));
  assert.deepEqual(parsed.sceneObjects.map(o => o.id), ['o1', 'o2']);
  assert.equal(parsed.project.name, 'p', 'the rest of the document is intact around the parts');
});
