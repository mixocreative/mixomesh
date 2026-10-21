// cia A-02: one save is one snapshot. buildDocument must take the whole state
// (objects, their world transforms, shaders, collections, assets) in the same
// tick, so an edit or import landing during the async embed is either wholly
// in the file or wholly out of it.
//   node --import ./tests/register-hooks.mjs --test tests/save-torn-document-a02.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { buildDocument } = await import('../src/core/persist/ProjectSerializer.js');
const { setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');

SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getContainerGeomMeshes = () => [];

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const ids = arr => arr.map(x => x.id);
const asset = (id, hash) => ({ id, name: id, filename: `${id}.stl`, extension: '.stl', kind: 'mesh', contentHash: hash });

test('an import landing mid-embed is not half in the file', async () => {
  AssetLoader.getBabylonMesh = () => null;
  let release;
  const gate = new Promise(r => { release = r; });
  AssetLoader.getAssetBytes = async () => { await gate; return new Uint8Array([1, 2, 3]).buffer; };
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { a1: asset('a1', 'h1') },
    objects: { o1: { id: 'o1', name: 'old', assetId: 'a1', shaderId: null, ratio: 1 } },
  } }), { silent: true });

  const building = buildDocument();
  await tick();
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { ...s.scene.assetLibrary, a2: asset('a2', 'h2') },
    collections: { ...s.scene.collections, c2: { id: 'c2', name: 'new' } },
    shaders: { ...s.scene.shaders, sh2: { id: 'sh2', name: 'tex', linkedMeshIds: ['o2'] } },
    objects: { ...s.scene.objects, o2: { id: 'o2', name: 'new', assetId: 'a2', shaderId: 'sh2', collectionId: 'c2', ratio: 1 } },
  } }), { silent: true });
  release();
  const doc = await building;

  assert.deepEqual(ids(doc.sceneObjects), ['o1'], 'the object that arrived during the save is not in this snapshot');
  for (const o of doc.sceneObjects) {
    assert.ok(ids(doc.assetLibrary).includes(o.assetId), `${o.id}: its asset is in the same file`);
    if (o.shaderId) assert.ok(ids(doc.shaders).includes(o.shaderId), `${o.id}: its shader is in the same file`);
    if (o.collectionId) assert.ok(ids(doc.collections).includes(o.collectionId), `${o.id}: its collection is in the same file`);
  }
});

test('object transforms are the ones at save start, not the ones after the embed', async () => {
  const pos = { x: 1 };
  const mesh = {
    computeWorldMatrix() {},
    getWorldMatrix() { return { decompose(s, q, p) { s.set(1, 1, 1); p.set(pos.x, 0, 0); q.x = 0; q.y = 0; q.z = 0; q.w = 1; } }; },
    metadata: { meshId: 'o1' },
  };
  AssetLoader.getBabylonMesh = id => (id === 'o1' ? mesh : null);
  let release;
  const gate = new Promise(r => { release = r; });
  AssetLoader.getAssetBytes = async () => { await gate; return new Uint8Array([1]).buffer; };
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: { a1: asset('a1', 'h1') }, collections: {}, shaders: {},
    objects: { o1: { id: 'o1', name: 'moved', assetId: 'a1', ratio: 1 } },
  } }), { silent: true });

  const building = buildDocument();
  await tick();
  pos.x = 99;   // the user drags the object while the asset is still embedding
  release();
  const doc = await building;
  assert.equal(doc.sceneObjects[0].transform.p[0], 1, 'the file holds the transform the user saw when pressing Ctrl+S');
});
