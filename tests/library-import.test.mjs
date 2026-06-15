import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};

const { StateManager } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');

MeshValidator.shouldAutoValidate = () => false;

function resetState() {
  StateManager.replaceState(StateManager.freshState());
}

function v(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    addInPlace(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; },
    scaleInPlace(f) { this.x *= f; this.y *= f; this.z *= f; return this; },
    scale(f) { return v(this.x * f, this.y * f, this.z * f); },
    set(x2, y2, z2) { this.x = x2; this.y = y2; this.z = z2; return this; },
    copyFrom(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; },
    clone() { return v(this.x, this.y, this.z); },
  };
}

function matrix() {
  return {
    clone() { return this; },
    setTranslation() {},
    getTranslation() { return v(0, 0, 0); },
    determinant() { return 1; },
  };
}

function makeNode(name, parent = null, extras = null) {
  return {
    name,
    parent,
    metadata: extras ? { gltf: { extras } } : {},
    position: v(),
    scaling: v(1, 1, 1),
    rotation: v(),
    rotationQuaternion: null,
    setParent(p) { this.parent = p; },
    dispose() { this.disposed = true; },
  };
}

function makeMesh(name, parent = null) {
  return {
    ...makeNode(name, parent),
    geometry: {},
    material: null,
    isVisible: true,
    getTotalVertices: () => 3,
    getVerticesData: () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    getIndices: () => [0, 1, 2],
    computeWorldMatrix() {},
    getWorldMatrix: matrix,
    bakeTransformIntoVertices() {},
    refreshBoundingInfo() {},
    flipFaces() {},
  };
}

function makeLibraryContainer() {
  const root = makeNode('__root__', null, { mixomeshImportMode: 'library' });
  const cola = makeNode('Cola', root);
  const juice = makeNode('Juice', root);
  return {
    meshes: [makeMesh('ColaMesh', cola), makeMesh('JuiceMesh', juice)],
    transformNodes: [root, cola, juice],
    materials: [],
    textures: [],
    addAllToScene() { this.added = true; },
    removeAllFromScene() {},
    dispose() { this.disposed = true; },
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetState();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('marked GLB registers each top-level object as an asset without scene objects', async () => {
  const container = makeLibraryContainer();
  B.SceneLoader = { LoadAssetContainerAsync: async () => container };

  const meshIds = await AssetLoader.loadFromBlob(new Blob(['glb']), 'beverage.glb');

  assert.deepEqual(meshIds, []);
  assert.equal(container.added, undefined, 'library import must not add pack to scene');
  const state = StateManager.getState();
  assert.equal(Object.keys(state.scene.objects).length, 0);
  const assets = Object.values(state.scene.assetLibrary);
  assert.equal(assets.length, 2);
  assert.deepEqual(assets.map(a => a.name).sort(), ['Cola', 'Juice']);
  assert.ok(assets.every(a => a.libraryItem?.sourceFilename === 'beverage.glb'));
});

await test('double-clicking a library child instantiates only that child object', async () => {
  const scene = { defaultMaterial: { name: 'grey' } };
  SceneManager.getScene = () => scene;

  B.SceneLoader = { LoadAssetContainerAsync: async () => makeLibraryContainer() };
  await AssetLoader.loadFromBlob(new Blob(['glb']), 'beverage.glb');
  const cola = Object.values(StateManager.getState().scene.assetLibrary)
    .find(a => a.name === 'Cola');

  const meshIds = await AssetLoader.instantiateAsset(cola.id, new B.Vector3(0, 0, 0));

  assert.equal(meshIds.length, 1);
  const state = StateManager.getState();
  assert.equal(Object.keys(state.scene.objects).length, 1);
  const obj = state.scene.objects[meshIds[0]];
  assert.equal(obj.assetId, cola.id);
  assert.match(obj.name, /ColaMesh/);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
