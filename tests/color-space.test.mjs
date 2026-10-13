// Task 1.9 colour-space checks.
//   node --import ./tests/register-hooks.mjs tests/color-space.test.mjs
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { linearToSrgbByte, linearRgbaToSrgbInPlace, isLinearTexture } =
  await import('../src/core/shaders/ColorSpace.js');
const { textureToPngBlob } = await import('../src/core/assets/TextureReadback.js');
const { textureToBlob } = await import('../src/core/print/ExportTextures.js');
const { setTextureSource, clearTextureSource } = await import('../src/core/assets/TextureSource.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('linearToSrgbByte known values', () => {
  assert.equal(linearToSrgbByte(0), 0);
  assert.equal(linearToSrgbByte(255), 255);
  assert.equal(linearToSrgbByte(128), 188);
  assert.equal(linearToSrgbByte(1), 13);
});

await test('buffer helper preserves alpha', () => {
  const b = new Uint8ClampedArray([128, 0, 255, 77]);
  linearRgbaToSrgbInPlace(b);
  assert.deepEqual([...b], [188, 0, 255, 77]);
});

await test('isLinearTexture detects gammaSpace=false only', () => {
  assert.equal(isLinearTexture({ gammaSpace: false }), true);
  assert.equal(isLinearTexture({ gammaSpace: true }), false);
  assert.equal(isLinearTexture({}), false);
  assert.equal(isLinearTexture(null), false);
});

function fakeCanvasEnv(captured) {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { captured.data = [...img.data]; },
      }),
      toBlob: (cb) => cb({ fake: true }),
    }),
  };
}

await test('GPU export fallback (toSrgb): linear texture converted, sRGB passes; capture (default) stays raw', async () => {
  const cap = {};
  fakeCanvasEnv(cap);
  const mk = (gammaSpace) => ({
    gammaSpace,
    getSize: () => ({ width: 1, height: 1 }),
    readPixels: () => new Uint8Array([128, 0, 255, 77]),
  });
  await textureToPngBlob(mk(false), { toSrgb: true });
  assert.deepEqual(cap.data, [188, 0, 255, 77]);
  await textureToPngBlob(mk(true), { toSrgb: true });
  assert.deepEqual(cap.data, [128, 0, 255, 77]);
  await textureToPngBlob(mk(false));   // source capture path: never converted (cap re-uploads these bytes)
  assert.deepEqual(cap.data, [128, 0, 255, 77]);
});

await test('frozen source path is exported verbatim (same bytes, no GPU read)', async () => {
  const blob = new Blob([new Uint8Array([9, 8, 7, 6, 5])]);
  setTextureSource('a1', blob, 1, 1);
  try {
    const tex = { gammaSpace: false, readPixels: () => { throw new Error('GPU must not be read'); } };
    const out = await textureToBlob(tex, 'a1');
    assert.equal(out, blob);
    assert.deepEqual([...new Uint8Array(await out.arrayBuffer())], [9, 8, 7, 6, 5]);
  } finally { clearTextureSource('a1'); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
