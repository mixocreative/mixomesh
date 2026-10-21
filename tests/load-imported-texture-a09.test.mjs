// cia A-09: an imported (container-owned) texture whose container comes back
// without it, such as an OBJ dropped without a mounted folder, reopens from its
// stored image bytes, so the shader stays textured.
import assert from 'node:assert/strict';
import test from 'node:test';
import { B, PM, AssetLoader, getState, goodDoc, meshAsset, sceneObject, seedCurrentScene } from './load-harness.mjs';

const { hashImage } = await import('../src/core/assets/TextureImageStore.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');

B.Texture = function (url, scene, noMipmap, invertY, samplingMode, onLoad) {
  const tex = { name: url, url, invertY, metadata: {}, getSize: () => ({ width: 16, height: 16 }), isReady: () => true, dispose() {} };
  queueMicrotask(() => onLoad?.());
  return tex;
};
B.Texture.TRILINEAR_SAMPLINGMODE = 3;

const PNG = new TextEncoder().encode('png-bytes-red-over-blue');
const PNG_HASH = await hashImage(new Blob([PNG], { type: 'image/png' }));

function texturedObjDoc() {
  const doc = goodDoc('Textured OBJ');
  doc.assetLibrary = [
    meshAsset('a_obj', { filename: 'part.obj', extension: '.obj' }),
    {
      id: 'tex1', name: 'tex', filename: 'tex.png', extension: '.png', kind: 'texture',
      isImported: true, sourceAssetId: 'a_obj', babylonTextureName: 'tex.png',
      imageContentHash: PNG_HASH, contentHash: PNG_HASH,
    },
  ];
  doc.textureImages = [{ hash: PNG_HASH, fileData: encodeBase64(PNG.buffer), mimeType: 'image/png', width: 16, height: 16 }];
  doc.shaders = [{ id: 'sh1', name: 'Tex', type: 'standard', diffuseTextureAssetId: 'tex1' }];
  doc.sceneObjects = [sceneObject('o_obj', 'a_obj', { shaderId: 'sh1' })];
  return doc;
}

test('an imported texture missing from the restored container reopens from its stored image', async () => {
  seedCurrentScene();
  await PM._loadProject(texturedObjDoc());
  assert.ok(AssetLoader.getBabylonTexture('tex1'), 'texture is live after reopen');
  assert.equal(getState().scene.shaders.sh1.diffuseTextureAssetId, 'tex1', 'shader keeps its texture');
  assert.equal(getState().scene.assetLibrary.tex1.imageContentHash, PNG_HASH, 'entry keeps its image identity');
});
