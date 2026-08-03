// Content-addressed image bytes and texture-view identity.
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const {
  clearTextureImages,
  getTextureImage,
  hashImage,
  listTextureImages,
  storeTextureImage,
} = await import('../src/core/assets/TextureImageStore.js');
const { normalizeTextureView, textureViewKey } = await import('../src/core/assets/TextureView.js');
const { setState } = await import('../src/core/StateManager.js');
const { serialiseTextureImages } = await import('../src/core/persist/ProjectSerializer.js');

const bytesA = new TextEncoder().encode('same-name:first');
const bytesB = new TextEncoder().encode('same-name:second');
const bytesACopy = new Uint8Array(bytesA);

assert.notEqual(await hashImage(bytesA), await hashImage(bytesB), 'same filename cannot imply identity');
assert.equal(await hashImage(bytesA), await hashImage(bytesACopy), 'equal bytes must share identity');

const hash = await hashImage(bytesA);
const baseView = normalizeTextureView({ imageContentHash: hash, wrapU: 1 });
assert.notEqual(
  textureViewKey(baseView),
  textureViewKey({ ...baseView, wrapU: 2 }),
  'sampler differences require distinct texture views',
);

clearTextureImages();
const blobA = new Blob([bytesA], { type: 'image/png' });
const blobACopy = new Blob([bytesACopy], { type: 'image/png' });
assert.equal(await storeTextureImage(blobA, 32, 16), hash);
assert.equal(await storeTextureImage(blobACopy, 32, 16), hash);
assert.equal(listTextureImages().length, 1, 'two views over equal bytes persist one image payload');
assert.equal(getTextureImage(hash).blob, blobA, 'first canonical payload wins');

setState(state => ({
  ...state,
  scene: {
    ...state.scene,
    assetLibrary: {
      view_a: { id: 'view_a', kind: 'texture', imageContentHash: hash },
      view_b: { id: 'view_b', kind: 'texture', imageContentHash: hash },
    },
  },
}), { silent: true });
const persistedImages = await serialiseTextureImages();
assert.equal(persistedImages.length, 1, 'two persisted views emit one encoded image blob');
assert.equal(persistedImages[0].hash, hash);

assert.deepEqual(normalizeTextureView({ imageContentHash: hash }), {
  imageContentHash: hash,
  colorSpace: 'srgb',
  invertY: false,
  wrapU: 1,
  wrapV: 1,
  samplingMode: 3,
});
