// L2-02: a reopened glTF texture must export the bytes the fresh import
// exported. glTF base-colour textures upload into an sRGB buffer, which
// Babylon reports as gammaSpace === false although the stored bytes are sRGB.
import assert from 'node:assert/strict';
import test from 'node:test';
import { B, PM, AssetLoader, goodDoc, makeContainer, sceneObject, seedCurrentScene } from './load-harness.mjs';

const { isLinearTexture } = await import('../src/core/shaders/ColorSpace.js');
const { textureViewFromBabylon } = await import('../src/core/assets/TextureView.js');
const { textureToPngBlob } = await import('../src/core/assets/TextureReadback.js');
const { textureToBlob } = await import('../src/core/print/ExportTextures.js');
const { getTextureSource } = await import('../src/core/assets/TextureSource.js');
const { hashImage } = await import('../src/core/assets/TextureImageStore.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');

const srgbBuffer = () => ({ gammaSpace: false, _texture: { _gammaSpace: true, _useSRGBBuffer: true } });
const linear = () => ({ gammaSpace: false, _texture: { _gammaSpace: false, _useSRGBBuffer: false } });

test('colour-space classification: an sRGB-buffer texture holds sRGB bytes, not linear ones', () => {
  assert.equal(isLinearTexture(srgbBuffer()), false, 'sRGB buffer');
  assert.equal(isLinearTexture(linear()), true, 'linear data');
  assert.equal(isLinearTexture({ gammaSpace: false }), true, 'flagged linear, no internal texture');
  assert.equal(isLinearTexture({ gammaSpace: true }), false, 'gamma');
  assert.equal(isLinearTexture(null), false, 'missing');
  assert.equal(textureViewFromBabylon(srgbBuffer(), null).colorSpace, 'srgb', 'saved view of an sRGB buffer');
  assert.equal(textureViewFromBabylon(linear(), null).colorSpace, 'linear', 'saved view of linear data');
});

test('the export readback leaves sRGB-buffer bytes alone', async () => {
  const saved = globalThis.document;
  let written = null;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { written = [...img.data]; },
      }),
      toBlob: (cb) => cb(new Blob([])),
    }),
  };
  try {
    const tex = { ...srgbBuffer(), getSize: () => ({ width: 1, height: 1 }), readPixels: () => new Uint8Array([128, 64, 200, 255]) };
    await textureToPngBlob(tex, { toSrgb: true });
    assert.deepEqual(written, [128, 64, 200, 255]);
  } finally {
    globalThis.document = saved;
  }
});

test('a reopened container texture exports its stored image bytes, not a GPU readback', async () => {
  const png = new TextEncoder().encode('captured-export-png');
  const hash = await hashImage(new Blob([png], { type: 'image/png' }));
  const gpuTexture = {
    ...srgbBuffer(), name: 'midtone', metadata: {}, isReady: () => true,
    getSize: () => ({ width: 48, height: 32 }),
    readPixels: () => { throw new Error('export must not read the GPU copy'); },
  };
  const realLoad = B.SceneLoader.LoadAssetContainerAsync;
  B.SceneLoader.LoadAssetContainerAsync = async () => ({ ...makeContainer(), textures: [gpuTexture] });
  try {
    const doc = goodDoc('Reopen texture');
    doc.assetLibrary.push({
      id: 'tex1', name: 'midtone', filename: 'midtone', extension: '.imported', kind: 'texture',
      isImported: true, sourceAssetId: 'a_ok', babylonTextureName: 'midtone',
      imageContentHash: hash, contentHash: hash,
    });
    doc.textureImages = [{ hash, fileData: encodeBase64(png.buffer), mimeType: 'image/png', width: 48, height: 32 }];
    doc.shaders = [{ id: 'sh1', name: 'Tex', type: 'pbr', diffuseTextureAssetId: 'tex1' }];
    doc.sceneObjects = [sceneObject('o_ok', 'a_ok', { shaderId: 'sh1' })];
    seedCurrentScene();
    await PM._loadProject(doc);

    assert.equal(AssetLoader.getBabylonTexture('tex1'), gpuTexture, 'container texture rebound');
    const source = getTextureSource('tex1');
    assert.deepEqual({ width: source?.width, height: source?.height }, { width: 48, height: 32 });
    const out = await textureToBlob(gpuTexture, 'tex1');
    assert.deepEqual(new Uint8Array(await out.arrayBuffer()), png);
  } finally {
    B.SceneLoader.LoadAssetContainerAsync = realLoad;
  }
});
