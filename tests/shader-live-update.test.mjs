// Shader live-update propagation (review H7 + H8).
// H7: updateShader must reach per-mesh UV-override clone materials — they
// previously kept stale colour/opacity/texture forever.
// H8: switching shader type must rebuild the Babylon material and reassign
// linked meshes — previously a state-only no-op.
//   node --import ./tests/register-hooks.mjs tests/shader-live-update.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { ShaderLibrary } = await import('../src/core/ShaderLibrary.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { setState, getState } = await import('../src/core/StateManager.js');

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

function fakeMesh(meshId) {
  const m = { name: meshId, metadata: { meshId }, material: null };
  meshes.set(meshId, m);
  return m;
}

function seedObjects(ids) {
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: Object.fromEntries(ids.map(id => [id, {
        id, name: id, assetId: 'a1', parentId: null, shaderId: null,
        visible: true, locked: false, isGhost: false, isPrintPart: true,
        collectionId: null, sourceGroupId: null,
      }])),
      uvOverrides: {},
    },
  }), { silent: true });
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('H7: colour update reaches the UV-override clone material', () => {
  const plain = fakeMesh('m_plain');
  const overridden = fakeMesh('m_uv');
  seedObjects(['m_plain', 'm_uv']);

  const shaderId = ShaderLibrary.createShader({ name: 'Paint', type: 'standard', diffuseColor: '#112233' });
  ShaderLibrary.assignToMesh(shaderId, 'm_plain');
  ShaderLibrary.assignToMesh(shaderId, 'm_uv');
  ShaderLibrary.setUVOverride('m_uv', { offsetX: 0.5 });

  const base  = ShaderLibrary.getMaterialById(shaderId);
  const clone = ShaderLibrary.getBabylonMaterial('m_uv');
  assert.notEqual(clone, base, 'override mesh must hold a clone');
  assert.equal(plain.material, base);
  assert.equal(overridden.material, clone);

  ShaderLibrary.updateShader(shaderId, 'diffuseColor', '#ff0000');
  assert.ok(Math.abs(base.diffuseColor.r - 1) < 1e-6, 'base gets the new colour');
  assert.ok(clone.diffuseColor && Math.abs(clone.diffuseColor.r - 1) < 1e-6,
    'UV-override clone must receive the same colour update (H7 regression)');

  ShaderLibrary.updateShader(shaderId, 'opacity', 0.25);
  assert.equal(base.alpha, 0.25);
  assert.equal(clone.alpha, 0.25, 'opacity must reach the clone too');
});

await test('H7: uvBase update does NOT clobber the per-mesh override', () => {
  fakeMesh('m_uv2');
  seedObjects(['m_uv2']);
  const shaderId = ShaderLibrary.createShader({ name: 'UVCheck', type: 'standard' });
  ShaderLibrary.assignToMesh(shaderId, 'm_uv2');
  ShaderLibrary.setUVOverride('m_uv2', { offsetX: 0.7 });

  ShaderLibrary.updateShader(shaderId, 'uvBase', { offsetX: 0.1 });
  const uv = getState().scene.uvOverrides['m_uv2'];
  assert.equal(uv.offsetX, 0.7, 'override offset survives a base UV change');
});

await test('H8: type standard → pbr rebuilds the material and reassigns meshes', () => {
  const m = fakeMesh('m_type');
  seedObjects(['m_type']);
  const shaderId = ShaderLibrary.createShader({ name: 'Morph', type: 'standard', diffuseColor: '#336699' });
  ShaderLibrary.assignToMesh(shaderId, 'm_type');
  const before = ShaderLibrary.getMaterialById(shaderId);
  assert.equal(m.material, before);

  ShaderLibrary.updateShader(shaderId, 'type', 'pbr');
  const after = ShaderLibrary.getMaterialById(shaderId);
  assert.notEqual(after, before, 'type change must mint a new Babylon material');
  assert.ok('metallic' in after, 'new material is PBR-shaped');
  assert.equal(m.material, after, 'linked mesh must be reassigned to the new material');
  assert.equal(before._disposed, true, 'old material disposed');
  assert.equal(getState().scene.shaders[shaderId].type, 'pbr');
});

await test('H8: type change rebuilds UV-override clones from the new base', () => {
  const m = fakeMesh('m_type_uv');
  seedObjects(['m_type_uv']);
  const shaderId = ShaderLibrary.createShader({ name: 'MorphUV', type: 'standard' });
  ShaderLibrary.assignToMesh(shaderId, 'm_type_uv');
  ShaderLibrary.setUVOverride('m_type_uv', { offsetX: 0.4 });
  const oldClone = ShaderLibrary.getBabylonMaterial('m_type_uv');

  ShaderLibrary.updateShader(shaderId, 'type', 'pbr');
  const newClone = ShaderLibrary.getBabylonMaterial('m_type_uv');
  assert.notEqual(newClone, oldClone, 'clone rebuilt from the new base');
  assert.equal(m.material, newClone, 'override mesh holds the rebuilt clone');
  assert.equal(getState().scene.uvOverrides['m_type_uv'].offsetX, 0.4,
    'override values survive the rebuild');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
