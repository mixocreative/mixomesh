// Texture identity contract (Blueprint §10b, review H6 + C2).
// Dedupe is scoped by sourceFileHash — same file re-imported dedupes, two
// DIFFERENT files never silently merge even with identical generic names.
// Reload rebind: bindRestoredTexture + restoreShader keep the persisted
// diffuseTextureAssetId once the texture instance is live.
//   node --import ./tests/register-hooks.mjs tests/texture-identity.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { AssetLoader }  = await import('../src/core/AssetLoader.js');
const { ShaderLibrary } = await import('../src/core/ShaderLibrary.js');
const { getState } = await import('../src/core/StateManager.js');

function fakeTex(name, w = 2, h = 2) {
  return { name, getSize: () => ({ width: w, height: h }) };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('same texture instance → same assetId', () => {
  const t = fakeTex('Image_0');
  const a = AssetLoader.registerImportedTexture(t, { sourceFileHash: 'AAA', sourceAssetId: 'asset_1' });
  const b = AssetLoader.registerImportedTexture(t, { sourceFileHash: 'AAA', sourceAssetId: 'asset_1' });
  assert.equal(a, b);
});

await test('same file re-imported (new instance, same hash) → dedupes to one assetId', () => {
  const a = AssetLoader.registerImportedTexture(fakeTex('Wood'), { sourceFileHash: 'FILE1', sourceAssetId: 'asset_1' });
  const b = AssetLoader.registerImportedTexture(fakeTex('Wood'), { sourceFileHash: 'FILE1', sourceAssetId: 'asset_2' });
  assert.equal(a, b, 'identical source bytes must share one texture asset');
});

await test('same image source with a different sampler view stays distinct', () => {
  const a = AssetLoader.registerImportedTexture(
    { ...fakeTex('Sampler'), wrapU: 1 },
    { sourceFileHash: 'FILE_VIEW', sourceAssetId: 'asset_1' },
  );
  const b = AssetLoader.registerImportedTexture(
    { ...fakeTex('Sampler'), wrapU: 2 },
    { sourceFileHash: 'FILE_VIEW', sourceAssetId: 'asset_2' },
  );
  assert.notEqual(a, b);
});

await test('DIFFERENT files, identical generic name + size → distinct assetIds (H6)', () => {
  const a = AssetLoader.registerImportedTexture(fakeTex('Image_0'), { sourceFileHash: 'FILE_A', sourceAssetId: 'asset_a' });
  const b = AssetLoader.registerImportedTexture(fakeTex('Image_0'), { sourceFileHash: 'FILE_B', sourceAssetId: 'asset_b' });
  assert.notEqual(a, b, 'cross-file aliasing — review H6 regression');
});

await test('entry carries §10b identity fields', () => {
  const id = AssetLoader.registerImportedTexture(fakeTex('Cloth'), { sourceFileHash: 'FILE_C', sourceAssetId: 'asset_c' });
  const e = getState().scene.assetLibrary[id];
  assert.equal(e.sourceFileHash, 'FILE_C');
  assert.equal(e.sourceAssetId, 'asset_c');
  assert.equal(e.babylonTextureName, 'Cloth');
  assert.equal(e.isImported, true);
});

await test('bindRestoredTexture registers under the persisted id', () => {
  const t = fakeTex('Restored');
  AssetLoader.bindRestoredTexture('tex_persisted_1', t);
  assert.equal(AssetLoader.getBabylonTexture('tex_persisted_1'), t);
});

await test('restoreShader keeps diffuseTextureAssetId when the texture is live (C2)', () => {
  const t = fakeTex('Paint');
  AssetLoader.bindRestoredTexture('tex_live', t);
  const id = ShaderLibrary.restoreShader({
    id: 'sh_live', name: 'Painted', type: 'standard',
    diffuseColor: '#ff0000', diffuseTextureAssetId: 'tex_live',
    uvBase: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, roughness: 0.5, metallic: 0,
  });
  assert.equal(getState().scene.shaders[id].diffuseTextureAssetId, 'tex_live',
    'live texture must stay bound — colour fallback is for genuinely missing only');
});

await test('restoreShader falls back to colour when the texture is missing', () => {
  const id = ShaderLibrary.restoreShader({
    id: 'sh_gone', name: 'Ghosted', type: 'standard',
    diffuseColor: '#00ff00', diffuseTextureAssetId: 'tex_nope',
    uvBase: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, roughness: 0.5, metallic: 0,
  });
  assert.equal(getState().scene.shaders[id].diffuseTextureAssetId, null);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
