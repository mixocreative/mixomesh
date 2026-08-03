import assert from 'node:assert/strict';
import { shaderSignature, findDuplicateShaderGroups } from '../src/core/shaders/ShaderSignature.js';

const base = {
  id: 'shader_a',
  name: 'Paint A',
  type: 'pbr',
  diffuseColor: '#Aa00FF',
  opacity: 1,
  roughness: 0.45,
  metallic: 0.1,
  uvBase: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  diffuseTextureAssetId: 'tex_a',
  linkedMeshIds: ['mesh_a'],
};
const assets = {
  tex_a: {
    imageContentHash: 'abc',
    textureView: { colorSpace: 'srgb', invertY: false, wrapU: 1, wrapV: 1, samplingMode: 3 },
  },
  tex_b: {
    imageContentHash: 'abc',
    textureView: { colorSpace: 'srgb', invertY: false, wrapU: 1, wrapV: 1, samplingMode: 3 },
  },
  tex_wrap: {
    imageContentHash: 'abc',
    textureView: { colorSpace: 'srgb', invertY: false, wrapU: 2, wrapV: 1, samplingMode: 3 },
  },
};

assert.equal(
  shaderSignature({ ...base, name: 'Renamed', linkedMeshIds: [] }, { assets }).key,
  shaderSignature(base, { assets }).key,
  'names, ids, and link counts are not appearance identity',
);
assert.notEqual(shaderSignature(base, { assets }).key, shaderSignature({ ...base, opacity: 0.5 }, { assets }).key);
assert.equal(
  shaderSignature(base, { assets }).key,
  shaderSignature({ ...base, diffuseTextureAssetId: 'tex_b' }, { assets }).key,
  'different texture assets with equal image + view are appearance-equal',
);
assert.notEqual(
  shaderSignature(base, { assets }).key,
  shaderSignature({ ...base, diffuseTextureAssetId: 'tex_wrap' }, { assets }).key,
  'texture sampler view participates in shader identity',
);
const unsupported = shaderSignature({ ...base, clearCoat: true }, { assets });
assert.equal(unsupported.eligible, false);
assert.ok(unsupported.reasons.includes('clearCoat'));
const unsupportedMaterial = shaderSignature(base, {
  assets,
  material: { _bumpTexture: { name: 'normal.png' } },
});
assert.equal(unsupportedMaterial.eligible, false);
assert.ok(unsupportedMaterial.reasons.includes('normalTexture'));

const groups = findDuplicateShaderGroups([
  base,
  { ...base, id: 'shader_b', name: 'Other name', diffuseTextureAssetId: 'tex_b', linkedMeshIds: ['mesh_b', 'mesh_c'] },
  { ...base, id: 'shader_c', opacity: 0.5, linkedMeshIds: [] },
], { assets });
assert.equal(groups.length, 1);
assert.equal(groups[0].canonicalId, 'shader_a');
assert.deepEqual(groups[0].duplicateIds, ['shader_b']);
assert.equal(groups[0].linkedObjectCount, 3);
