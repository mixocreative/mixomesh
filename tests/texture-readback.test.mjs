// Unit tests for the shared texture readback normalizer (review C1).
//   node --import ./tests/register-hooks.mjs tests/texture-readback.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { readTextureRGBA, flipRGBAVertically } =
  await import('../src/core/assets/TextureReadback.js');

function fakeTexture(pixels, w, h, { promised = false } = {}) {
  return {
    name: 't',
    getSize: () => ({ width: w, height: h }),
    readPixels: () => (promised ? Promise.resolve(pixels) : pixels),
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('sync Uint8 RGBA passes through', async () => {
  const px = new Uint8Array([1, 2, 3, 4]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1));
  assert.deepEqual([...r.rgba], [1, 2, 3, 4]);
  assert.equal(r.width, 1); assert.equal(r.height, 1);
});

await test('PROMISE-returning readPixels is awaited (modern Babylon)', async () => {
  const px = new Uint8Array([9, 8, 7, 255]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1, { promised: true }));
  assert.ok(r, 'must not treat the Promise as a pixel buffer');
  assert.deepEqual([...r.rgba], [9, 8, 7, 255]);
});

await test('RGB stride expands to RGBA with opaque alpha', async () => {
  const px = new Uint8Array([10, 20, 30]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1));
  assert.deepEqual([...r.rgba], [10, 20, 30, 255]);
});

await test('Float32 RGBA converts to clamped bytes', async () => {
  const px = new Float32Array([0, 0.5, 1, 2]);     // 2 → clamps to 255
  const r = await readTextureRGBA(fakeTexture(px, 1, 1, { promised: true }));
  assert.deepEqual([...r.rgba], [0, 128, 255, 255]);
});

await test('null on missing size or pixels', async () => {
  assert.equal(await readTextureRGBA({ getSize: () => null, readPixels: () => null }), null);
  assert.equal(await readTextureRGBA(fakeTexture(null, 2, 2)), null);
});

await test('flipRGBAVertically swaps rows in place', async () => {
  // 1×2 image: top px (1,1,1,1), bottom px (2,2,2,2).
  const buf = new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2]);
  flipRGBAVertically(buf, 1, 2);
  assert.deepEqual([...buf], [2, 2, 2, 2, 1, 1, 1, 1]);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
