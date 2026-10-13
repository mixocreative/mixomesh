// Unit tests for TextureCap (task 6.6g) — viewport texture cap seam.
//   node --import ./tests/register-hooks.mjs tests/texture-cap.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const {
  currentCapPx, captureAndCap, applyCapToTexture, clearCapUrl, clearCapUrls,
  hasCaptureFailed, markCaptureFailed, clearCaptureFailed,
} = await import('../src/core/assets/TextureCap.js');
const {
  setTextureSource, getTextureSource, clearTextureSources,
} = await import('../src/core/assets/TextureSource.js');
const { setState, getState } = await import('../src/core/StateManager.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

const setCap = (v) => setState(s => ({
  ...s, scene: { ...s.scene, render: { ...s.scene.render, textureCapPx: v } },
}), { silent: true });

// --- fakes ------------------------------------------------------------
const created = [];
const revoked = [];
let urlSeq = 0;
URL.createObjectURL = () => { const u = `blob:cap-${++urlSeq}`; created.push(u); return u; };
URL.revokeObjectURL = (u) => { revoked.push(u); };
const resetUrls = () => { created.length = 0; revoked.length = 0; };

let bitmapCalls = 0;
globalThis.createImageBitmap = async () => { bitmapCalls++; return { close() {} }; };

// document whose canvas supports drawImage + toBlob and records its size.
const canvases = [];
const baseDoc = globalThis.document;
globalThis.document = {
  ...baseDoc,
  createElement: (tag) => {
    const el = baseDoc.createElement(tag);
    if (tag === 'canvas') {
      const ctx = el.getContext();
      el.getContext = () => ({ ...ctx, drawImage() {} });
      canvases.push(el);
    }
    return el;
  },
};

function fakeTexture(w, h, { pixels } = {}) {
  const tex = {
    w, h, updates: [], readCalls: 0,
    getSize: () => ({ width: tex.w, height: tex.h }),
    readPixels() {
      tex.readCalls++;
      if (pixels === 'throw') throw new Error('gpu lost');
      if (pixels === null) return null;
      return new Uint8Array(tex.w * tex.h * 4).fill(200);
    },
    updateURL(url) {
      tex.updates.push(url);
      // the new GPU upload has the capped size
      const c = canvases[canvases.length - 1];
      tex.w = c.width; tex.h = c.height;
    },
  };
  return tex;
}

const png = (s = 'x') => new Blob([s], { type: 'image/png' });
const reset = () => {
  clearTextureSources(); clearCapUrls(); resetUrls(); canvases.length = 0; bitmapCalls = 0;
  setCap(0);
};

await test('currentCapPx: 0 when unset / invalid, value when positive finite', () => {
  setCap(undefined); assert.equal(currentCapPx(), 0);
  setCap(0);         assert.equal(currentCapPx(), 0);
  setCap(-5);        assert.equal(currentCapPx(), 0);
  setCap(NaN);       assert.equal(currentCapPx(), 0);
  setCap('2048');    assert.equal(currentCapPx(), 0);   // strict number only
  setCap(2048);      assert.equal(currentCapPx(), 2048);
  setCap(0);
});

await test('captureFailed flag helpers: mark / has / clear, falsy ids ignored', () => {
  reset();
  assert.equal(hasCaptureFailed('a'), false);
  markCaptureFailed('a');
  assert.equal(hasCaptureFailed('a'), true);
  markCaptureFailed(''); markCaptureFailed(null);
  assert.equal(hasCaptureFailed(''), false);
  clearCaptureFailed('a');
  assert.equal(hasCaptureFailed('a'), false);
});

await test('applyCapToTexture: no-op without a captured source', async () => {
  reset();
  const tex = fakeTexture(4096, 4096);
  await applyCapToTexture('nosrc', tex, 1024);
  assert.equal(tex.updates.length, 0);
  assert.equal(bitmapCalls, 0);
  assert.equal(created.length, 0);
});

await test('applyCapToTexture: no-op when texture lacks updateURL or src has zero size', async () => {
  reset();
  setTextureSource('x1', png(), 4096, 4096);
  await applyCapToTexture('x1', { getSize: () => ({ width: 4096, height: 4096 }) }, 1024);
  assert.equal(created.length, 0);
  setTextureSource('x2', png(), 0, 0);
  const tex = fakeTexture(8, 8);
  await applyCapToTexture('x2', tex, 4);
  assert.equal(tex.updates.length, 0);
});

await test('applyCapToTexture: downsizes to the cap preserving aspect, tracks URL', async () => {
  reset();
  setTextureSource('big', png(), 4096, 2048);
  const tex = fakeTexture(4096, 2048);
  await applyCapToTexture('big', tex, 1024);
  assert.equal(tex.updates.length, 1);
  assert.equal(canvases.at(-1).width, 1024);
  assert.equal(canvases.at(-1).height, 512);
  assert.equal(tex.w, 1024);
  assert.equal(created.length, 1);
  assert.equal(revoked.length, 0);
});

await test('applyCapToTexture: already at target size is a no-op; cap >= source restores full', async () => {
  reset();
  setTextureSource('s', png(), 2048, 2048);
  const tex = fakeTexture(2048, 2048);
  await applyCapToTexture('s', tex, 4096);   // cap above source → full res, already there
  assert.equal(tex.updates.length, 0);
  await applyCapToTexture('s', tex, 0);      // off → full res, already there
  assert.equal(tex.updates.length, 0);
  await applyCapToTexture('s', tex, 512);    // shrink
  assert.equal(tex.w, 512);
  await applyCapToTexture('s', tex, 0);      // raising the cap restores full from the source
  assert.equal(tex.updates.length, 2);
  assert.equal(tex.w, 2048);
});

await test('applyCapToTexture: replacing a cap revokes the previous URL only', async () => {
  reset();
  setTextureSource('r', png(), 4096, 4096);
  const tex = fakeTexture(4096, 4096);
  await applyCapToTexture('r', tex, 2048);
  const first = created[0];
  await applyCapToTexture('r', tex, 1024);
  assert.deepEqual(revoked, [first]);
  assert.equal(created.length, 2);
});

await test('applyCapToTexture: decode failure warns and leaves the texture alone', async () => {
  reset();
  setTextureSource('d', png(), 4096, 4096);
  const realBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => { throw new Error('bad png'); };
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const tex = fakeTexture(4096, 4096);
  try { await applyCapToTexture('d', tex, 512); }
  finally { globalThis.createImageBitmap = realBitmap; console.warn = warn; }
  assert.equal(warned, 1);
  assert.equal(tex.updates.length, 0);
});

await test('captureAndCap: captures full-res source FIRST, then caps the GPU texture', async () => {
  reset();
  setCap(512);
  const tex = fakeTexture(2048, 1024);
  await captureAndCap('c1', tex);
  const src = getTextureSource('c1');
  assert.ok(src, 'source must be recorded');
  assert.equal(src.width, 2048);   // full-res dims, not the capped ones
  assert.equal(src.height, 1024);
  assert.ok(src.imageContentHash, 'content hash stored');
  assert.equal(tex.readCalls, 1);
  assert.equal(tex.updates.length, 1);
  assert.equal(tex.w, 512);
  assert.equal(hasCaptureFailed('c1'), false);
  setCap(0);
});

await test('captureAndCap: second call reuses the source (no re-read of capped GPU texture)', async () => {
  reset();
  setCap(256);
  const tex = fakeTexture(1024, 1024);
  await captureAndCap('c2', tex);
  const first = getTextureSource('c2');
  assert.equal(tex.readCalls, 1);
  await captureAndCap('c2', tex);
  assert.equal(tex.readCalls, 1, 'must not read back again');
  assert.ok(getTextureSource('c2') === first);
  assert.equal(getTextureSource('c2').width, 1024);
  setCap(0);
});

await test('captureAndCap: null readback sets captureFailed and never caps', async () => {
  reset();
  setCap(256);
  const tex = fakeTexture(1024, 1024, { pixels: null });
  await captureAndCap('f1', tex);
  assert.equal(hasCaptureFailed('f1'), true);
  assert.equal(getTextureSource('f1'), null);
  assert.equal(tex.updates.length, 0);
  assert.equal(tex.w, 1024);
  setCap(0);
});

await test('captureAndCap: readback throw sets captureFailed, warns, does not reject', async () => {
  reset();
  setCap(256);
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const tex = fakeTexture(1024, 1024, { pixels: 'throw' });
  try { await captureAndCap('f2', tex); } finally { console.warn = warn; }
  assert.equal(hasCaptureFailed('f2'), true);
  assert.equal(warned, 1);
  assert.equal(tex.updates.length, 0);
  setCap(0);
});

await test('captureAndCap: a later successful capture clears the failed flag', async () => {
  reset();
  markCaptureFailed('f3');
  await captureAndCap('f3', fakeTexture(64, 64));
  assert.equal(hasCaptureFailed('f3'), false);
  assert.ok(getTextureSource('f3'));
});

await test('captureAndCap: falsy id or texture is a harmless no-op', async () => {
  reset();
  await captureAndCap('', fakeTexture(8, 8));
  await captureAndCap('z', null);
  assert.equal(getTextureSource('z'), null);
  assert.equal(hasCaptureFailed('z'), false);
});

await test('captureAndCap: writes imageContentHash + textureView into a registered asset', async () => {
  reset();
  setState(s => ({
    ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, reg: { id: 'reg', kind: 'texture' } } },
  }), { silent: true });
  await captureAndCap('reg', fakeTexture(32, 32));
  const a = getState().scene.assetLibrary.reg;
  assert.ok(a.imageContentHash);
  assert.ok(a.textureView);
  assert.equal(a.imageContentHash, getTextureSource('reg').imageContentHash);
});

await test('clearCapUrl: revokes that asset URL only and clears its failed flag', async () => {
  reset();
  setTextureSource('k1', png(), 1024, 1024);
  setTextureSource('k2', png('y'), 1024, 1024);
  await applyCapToTexture('k1', fakeTexture(1024, 1024), 256);
  await applyCapToTexture('k2', fakeTexture(1024, 1024), 256);
  const [u1, u2] = created;
  markCaptureFailed('k1'); markCaptureFailed('k2');
  clearCapUrl('k1');
  assert.deepEqual(revoked, [u1]);
  assert.equal(hasCaptureFailed('k1'), false);
  assert.equal(hasCaptureFailed('k2'), true);
  clearCapUrl('k1');   // idempotent: no double revoke
  assert.deepEqual(revoked, [u1]);
  clearCapUrl('unknown');
  assert.ok(u2);
});

await test('clearCapUrls: revokes every URL and clears all failed flags', async () => {
  reset();
  setTextureSource('m1', png(), 1024, 1024);
  setTextureSource('m2', png('z'), 1024, 1024);
  await applyCapToTexture('m1', fakeTexture(1024, 1024), 256);
  await applyCapToTexture('m2', fakeTexture(1024, 1024), 256);
  markCaptureFailed('m1'); markCaptureFailed('m2');
  clearCapUrls();
  assert.deepEqual([...revoked].sort(), [...created].sort());
  assert.equal(hasCaptureFailed('m1'), false);
  assert.equal(hasCaptureFailed('m2'), false);
  revoked.length = 0;
  clearCapUrls();
  assert.equal(revoked.length, 0, 'second reset has nothing to revoke');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
