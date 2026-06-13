// Unit tests for the full-res texture source registry + export-prefers-source
// (perf wave 2026-06-13 — the viewport texture cap's fidelity safety net).
//   node --import ./tests/register-hooks.mjs tests/texture-source.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const {
  setTextureSource, getTextureSource, hasTextureSource,
  clearTextureSource, clearTextureSources,
} = await import('../src/core/assets/TextureSource.js');
const { textureToBlob } = await import('../src/core/print/ExportTextures.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

const blobOf = (s) => new Blob([s], { type: 'image/png' });

await test('set/get round-trips blob + dimensions', async () => {
  clearTextureSources();
  const b = blobOf('FULLRES');
  setTextureSource('tex_a', b, 4096, 2048);
  const src = getTextureSource('tex_a');
  assert.equal(src.blob, b);
  assert.equal(src.width, 4096);
  assert.equal(src.height, 2048);
  assert.ok(hasTextureSource('tex_a'));
});

await test('first writer wins (capture-before-cap cannot be overwritten)', async () => {
  clearTextureSources();
  const full = blobOf('FULL');
  setTextureSource('tex_b', full, 4096, 4096);
  setTextureSource('tex_b', blobOf('CAPPED'), 1024, 1024);  // must be ignored
  assert.equal(getTextureSource('tex_b').blob, full);
  assert.equal(getTextureSource('tex_b').width, 4096);
});

await test('clearTextureSource drops one, clearTextureSources drops all', async () => {
  clearTextureSources();
  setTextureSource('x', blobOf('1'), 8, 8);
  setTextureSource('y', blobOf('2'), 8, 8);
  clearTextureSource('x');
  assert.equal(hasTextureSource('x'), false);
  assert.equal(hasTextureSource('y'), true);
  clearTextureSources();
  assert.equal(hasTextureSource('y'), false);
});

await test('export prefers the captured source over GPU readback', async () => {
  clearTextureSources();
  const full = blobOf('FULLRES-SOURCE');
  setTextureSource('tex_export', full, 4096, 4096);
  // A texture whose readPixels would BLOW UP — proving export never touches
  // the (possibly capped) GPU copy when a source exists.
  const trap = {
    name: 'tex_export',
    getSize: () => { throw new Error('GPU readback must not run when a source exists'); },
    readPixels: () => { throw new Error('GPU readback must not run when a source exists'); },
  };
  const blob = await textureToBlob(trap, 'tex_export');
  assert.equal(blob, full, 'must return the exact full-res source blob');
});

await test('export falls back to GPU readback when no source captured', async () => {
  clearTextureSources();
  let readbackTried = false;
  const tex = {
    name: 'no_source',
    getSize: () => { readbackTried = true; return { width: 0, height: 0 }; },  // → null readback
    readPixels: () => null,
  };
  // No source for this id → textureToPngBlob path runs (returns null at 0×0)
  // → textureToBlob throws. We only assert the GPU path was attempted.
  await assert.rejects(() => textureToBlob(tex, 'no_source'));
  assert.ok(readbackTried, 'fallback must hit the GPU readback path');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
