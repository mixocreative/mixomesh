// Portable .mixo project integrity. A saved project must not depend on the
// same mounted asset library to reopen usable geometry/textures later.
//   node --import ./tests/register-hooks.mjs tests/portable-project.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const { __test } = await import('../src/core/PersistenceManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { freshState, replaceState, setState } = await import('../src/core/StateManager.js');
const { clearTextureImages, storeTextureImage } = await import('../src/core/assets/TextureImageStore.js');

SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});

function resetProject() {
  replaceState(freshState());
  clearTextureImages();
  AssetLoader.getBabylonMesh = () => null;
  AssetLoader.getAssetBytes = async () => null;
}

function bytesOf(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function meshAsset(id, over = {}) {
  return {
    id,
    name: id,
    filename: `${id}.glb`,
    originalPath: `${id}.glb`,
    extension: '.glb',
    kind: 'mesh',
    sourceUnit: 'millimeters',
    unitConfirmed: true,
    modelRatio: 1,
    directoryHandleKey: null,
    fileHandleKey: null,
    contentHash: null,
    ...over,
  };
}

function sceneObject(id, assetId, over = {}) {
  return {
    id,
    name: id,
    assetId,
    collectionId: null,
    parentId: null,
    shaderId: null,
    visible: true,
    locked: false,
    isGhost: false,
    isPrintPart: true,
    sourceGroupId: null,
    ...over,
  };
}

async function blobBytes(blob) {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

let passed = 0;
let failed = 0;
const out = [];
async function test(name, fn) {
  resetProject();
  try {
    await fn();
    out.push(`PASS  ${name}`);
    passed++;
  } catch (err) {
    out.push(`FAIL  ${name}\n      ${err.stack || err.message}`);
    failed++;
  }
}

await test('manual .mixo save rejects a used mesh asset with no embedded bytes', async () => {
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      assetLibrary: { asset_a: meshAsset('asset_a') },
      objects: { mesh_a: sceneObject('mesh_a', 'asset_a') },
    },
  }), { silent: true });

  await assert.rejects(__test._buildDocument(), (err) => {
    assert.match(err.message, /Cannot save portable \.mixo/);
    assert.equal(err.portableIssues?.[0]?.code, 'missing-asset-bytes');
    assert.equal(err.portableIssues?.[0]?.assetId, 'asset_a');
    assert.deepEqual(err.portableIssues?.[0]?.requiredBy, ['mesh_a']);
    return true;
  });
});

await test('manual .mixo save embeds a used mounted-library mesh for clean-profile reopen', async () => {
  const src = Uint8Array.from([1, 2, 3, 4, 255]);
  AssetLoader.getAssetBytes = async assetId => (assetId === 'asset_a' ? bytesOf(src) : null);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      assetLibrary: {
        asset_a: meshAsset('asset_a', {
          directoryHandleKey: 'mount_old',
          originalPath: 'library/asset_a.glb',
          contentHash: 'known-hash',
        }),
      },
      objects: { mesh_a: sceneObject('mesh_a', 'asset_a') },
    },
  }), { silent: true });

  const doc = await __test._buildDocument();
  const saved = doc.assetLibrary.find(a => a.id === 'asset_a');
  assert.ok(saved.fileData, 'explicit save must embed the used asset bytes');

  const cleanProfileEntry = {
    ...saved,
    directoryHandleKey: null,
    fileHandleKey: null,
    originalPath: null,
  };
  const resolved = await __test._resolveAssetBlob(cleanProfileEntry);
  assert.equal(resolved.live, false);
  assert.deepEqual(await blobBytes(resolved.blob), [...src]);
});

await test('manual .mixo save accepts a used texture when its content-addressed image is present', async () => {
  const meshBytes = Uint8Array.from([10, 20, 30]);
  const texBytes = Uint8Array.from([80, 78, 71]);
  const imageHash = await storeTextureImage(new Blob([texBytes], { type: 'image/png' }), 1, 1);
  AssetLoader.getAssetBytes = async assetId => (assetId === 'asset_a' ? bytesOf(meshBytes) : null);

  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      assetLibrary: {
        asset_a: meshAsset('asset_a'),
        tex_a: {
          id: 'tex_a',
          name: 'tex_a',
          filename: 'tex_a.png',
          originalPath: 'tex_a.png',
          extension: '.png',
          kind: 'texture',
          directoryHandleKey: null,
          imageContentHash: imageHash,
          textureView: { imageContentHash: imageHash, colorSpace: 'srgb', invertY: false, wrapU: 1, wrapV: 1, samplingMode: 3 },
        },
      },
      objects: { mesh_a: sceneObject('mesh_a', 'asset_a', { shaderId: 'shader_a' }) },
      shaders: { shader_a: { id: 'shader_a', diffuseTextureAssetId: 'tex_a' } },
    },
  }), { silent: true });

  const doc = await __test._buildDocument();
  assert.equal(doc.textureImages.length, 1);
  assert.equal(doc.textureImages[0].hash, imageHash);
  assert.equal(doc.assetLibrary.find(a => a.id === 'tex_a').contentHash, imageHash);
});

await test('autosave may skip handle-backed used assets, but not handleless loose drops', async () => {
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      assetLibrary: {
        linked: meshAsset('linked', { fileHandleKey: 'fh_linked', contentHash: 'linked-hash' }),
        loose: meshAsset('loose'),
      },
      objects: {
        mesh_linked: sceneObject('mesh_linked', 'linked'),
        mesh_loose: sceneObject('mesh_loose', 'loose'),
      },
    },
  }), { silent: true });

  await assert.rejects(__test._buildDocument({ skipEmbed: true }), (err) => {
    assert.equal(err.portableIssues?.length, 1);
    assert.equal(err.portableIssues[0].assetId, 'loose');
    return true;
  });
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
