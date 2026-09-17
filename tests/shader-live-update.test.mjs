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
const { ShaderLibrary, srgbToLinear01, linearToSrgb01 } = await import('../src/core/ShaderLibrary.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { setState, getState } = await import('../src/core/StateManager.js');
const { ShaderConsolidateCommand } = await import('../src/core/commands/ShaderCommands.js');

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

await test('exact duplicate consolidation rewires all links and undo restores identities', () => {
  fakeMesh('m_con_a');
  fakeMesh('m_con_b');
  seedObjects(['m_con_a', 'm_con_b']);
  const canonical = ShaderLibrary.createShader({ name: 'Canonical', diffuseColor: '#123456' });
  const duplicate = ShaderLibrary.createShader({ name: 'Duplicate', diffuseColor: '#123456' });
  ShaderLibrary.assignToMesh(canonical, 'm_con_a');
  ShaderLibrary.assignToMesh(duplicate, 'm_con_b');

  const command = new ShaderConsolidateCommand([{ canonicalId: canonical, duplicateIds: [duplicate] }]);
  command.execute();
  assert.equal(getState().scene.objects.m_con_b.shaderId, canonical);
  assert.equal(getState().scene.shaders[duplicate], undefined);
  assert.deepEqual(new Set(getState().scene.shaders[canonical].linkedMeshIds), new Set(['m_con_a', 'm_con_b']));

  command.undo();
  assert.equal(getState().scene.objects.m_con_a.shaderId, canonical);
  assert.equal(getState().scene.objects.m_con_b.shaderId, duplicate);
  assert.ok(getState().scene.shaders[duplicate], 'undo recreates removed shader entry/material');
});

// ── Colour-space contract (Blueprint §10, 2026-09-17) ──────────────────────
// Record hex is ALWAYS sRGB; PBR albedoColor is LINEAR; Standard diffuseColor raw.

await test('colour: sRGB<->linear helpers round-trip every 8-bit value to 1/255', () => {
  for (let i = 0; i < 256; i++) {
    const back = Math.round(linearToSrgb01(srgbToLinear01(i / 255)) * 255);
    assert.equal(back, i, `channel ${i} must survive sRGB→linear→sRGB`);
  }
  assert.ok(Math.abs(srgbToLinear01(128 / 255) - 0.2159) < 5e-4, '#80 → ~0.216 linear');
});

await test('colour: picked #808080 on a PBR shader lands in albedoColor as ~0.216 (linear)', () => {
  fakeMesh('m_col_pbr');
  seedObjects(['m_col_pbr']);
  const shaderId = ShaderLibrary.createShader({ name: 'Grey', type: 'pbr', diffuseColor: '#808080' });
  const mat = ShaderLibrary.getMaterialById(shaderId);
  for (const ch of ['r', 'g', 'b']) {
    assert.ok(Math.abs(mat.albedoColor[ch] - 0.216) < 1e-3, `albedo.${ch} linear, got ${mat.albedoColor[ch]}`);
  }
  // Live update path converts too.
  ShaderLibrary.updateShader(shaderId, 'diffuseColor', '#ffffff');
  assert.ok(Math.abs(mat.albedoColor.r - 1) < 1e-6, 'white stays 1.0 in linear');
  ShaderLibrary.updateShader(shaderId, 'diffuseColor', '#808080');
  assert.ok(Math.abs(mat.albedoColor.g - 0.216) < 1e-3, 'updateShader re-encodes to linear');
  assert.equal(getState().scene.shaders[shaderId].diffuseColor, '#808080', 'record hex stays sRGB');
});

await test('colour: glTF-imported PBR albedo 0.216 registers as record hex #808080 (no double conversion)', async () => {
  // A real-Babylon PBRMaterial is detected via instanceof; mimic that shape.
  const mat = Object.assign(Object.create(window.BABYLON.PBRMaterial.prototype), {
    name: 'ImportedGrey', albedoColor: { r: 0.2159, g: 0.2159, b: 0.2159 },
    metallic: 0, roughness: 0.5, alpha: 1, albedoTexture: null, baseTexture: null,
    dispose() {},
  });
  const meshA = { name: 'gltfMesh', material: mat, metadata: {} };
  // NB: this may auto-dedupe against the picked-#808080 PBR shader above (same
  // signature) — which is itself proof the two paths agree — so read the id
  // via byMaterial rather than shaderIds.
  const { byMaterial } = await ShaderLibrary.registerFromContainer({ materials: [mat], meshes: [meshA] }, {});
  const entry = getState().scene.shaders[byMaterial.get(mat)];
  assert.ok(entry, 'entry registered');
  assert.equal(entry.type, 'pbr');
  assert.equal(entry.diffuseColor, '#808080', 'linear 0.216 encodes to sRGB #808080');
  // Round trip: applying the record back to a fresh PBR material yields the same linear value.
  const shaderId = ShaderLibrary.createShader({ name: 'RT', type: 'pbr', diffuseColor: entry.diffuseColor });
  const m2 = ShaderLibrary.getMaterialById(shaderId);
  assert.ok(Math.abs(m2.albedoColor.r - 0.2159) < 2e-3, 'hex → albedo → hex → albedo is stable');
});

await test('colour: StandardMaterial diffuseColor is written raw (gamma-space, unchanged)', () => {
  fakeMesh('m_col_std');
  seedObjects(['m_col_std']);
  const shaderId = ShaderLibrary.createShader({ name: 'StdGrey', type: 'standard', diffuseColor: '#808080' });
  const mat = ShaderLibrary.getMaterialById(shaderId);
  assert.ok(Math.abs(mat.diffuseColor.r - 128 / 255) < 1e-6, 'standard diffuse = raw 0.502');
  ShaderLibrary.updateShader(shaderId, 'diffuseColor', '#404040');
  assert.ok(Math.abs(mat.diffuseColor.r - 64 / 255) < 1e-6, 'live update stays raw too');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
