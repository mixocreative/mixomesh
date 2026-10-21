// cia A-09 (save half): a texture imported moments before Ctrl+S has its
// image bytes captured on idle. A save that runs first must wait for that
// capture, or the .mixo carries no bytes for the texture and reopens untextured.
//   node --import ./tests/register-hooks.mjs --test tests/save-texture-capture-a09.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { buildDocument } = await import('../src/core/persist/ProjectSerializer.js');
const { setState, getState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { bindRestoredTexture } = await import('../src/core/assets/TextureAssets.js');

SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
AssetLoader.getContainerGeomMeshes = () => [];
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => new Uint8Array([1]).buffer;
URL.createObjectURL = () => 'blob:cap';
URL.revokeObjectURL = () => {};

const liveTexture = {
  name: 'tex.png',
  metadata: {},
  isReady: () => true,
  getSize: () => ({ width: 4, height: 4 }),
  readPixels: () => new Uint8Array(4 * 4 * 4).fill(200),
  updateURL() {},
};

test('a save made before the idle capture still contains the texture image', async () => {
  setState(s => ({ ...s, scene: { ...s.scene,
    assetLibrary: {
      tex1: { id: 'tex1', name: 'tex', filename: 'tex.png', extension: '.png', kind: 'texture', isImported: true, babylonTextureName: 'tex.png' },
    },
    shaders: { sh1: { id: 'sh1', name: 'Tex', type: 'standard', diffuseTextureAssetId: 'tex1', linkedMeshIds: [] } },
    objects: {}, collections: {},
  } }), { silent: true });
  bindRestoredTexture('tex1', liveTexture);

  const doc = await buildDocument();

  const entry = doc.assetLibrary.find(a => a.id === 'tex1');
  assert.ok(entry?.imageContentHash, 'the saved texture entry names its image');
  assert.deepEqual(doc.textureImages.map(i => i.hash), [entry.imageContentHash], 'the image bytes are in the same file');
  assert.equal(getState().scene.assetLibrary.tex1.imageContentHash, entry.imageContentHash);
});
