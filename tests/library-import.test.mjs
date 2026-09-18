import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};

const { StateManager, setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const MeshRepair = await import('../src/core/repair/MeshRepair.js');
const { queueValidation } = await import('../src/core/assets/AssetRegistration.js');

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
    setVerticesData() {},
    getIndices: () => [0, 1, 2],
    setIndices() {},
    createNormals() {},
    computeWorldMatrix() {},
    getWorldMatrix: matrix,
    bakeTransformIntoVertices() {},
    refreshBoundingInfo() {},
    flipFaces() {},
  };
}

function makeLibraryContainer() {
  const root = makeNode('__root__');
  const library = makeNode('BeverageLibrary', root, { library: 1 });
  const cola = makeNode('Cola', library);
  const juice = makeNode('Juice', library);
  const helper = makeNode('ReferenceScaleCube', root);
  return {
    meshes: [makeMesh('ColaMesh', cola), makeMesh('JuiceMesh', juice), makeMesh('HelperMesh', helper)],
    transformNodes: [root, library, cola, juice, helper],
    materials: [],
    textures: [],
    addAllToScene() { this.added = true; },
    removeAllFromScene() {},
    dispose() { this.disposed = true; },
  };
}

function makeHierarchyContainer() {
  const root = makeNode('__root__');
  const beverages = makeNode('Beverages', root);
  const mug = makeNode('Mug', beverages);
  return {
    meshes: [makeMesh('Body', mug), makeMesh('Handle', mug)],
    transformNodes: [root, beverages, mug],
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

await test('normal GLB import keeps the assembly group and collapses the single-child wrapper above it', async () => {
  // Beverages → Mug → { Body, Handle }. Mug holds two objects → a real
  // assembly, kept as a group. Beverages holds only Mug → a single-child
  // wrapper, collapsed (owner decision 2026-09-18: hierarchy only where it
  // means something; a scan used to show as file → node → mesh).
  const container = makeHierarchyContainer();
  B.SceneLoader = { LoadAssetContainerAsync: async () => container };

  const meshIds = await AssetLoader.loadFromBlob(new Blob(['glb']), 'beverage.glb');

  assert.equal(meshIds.length, 2);
  const state = StateManager.getState();
  const groups = Object.values(state.scene.groups);
  const beverages = groups.find(g => g.name === 'Beverages');
  const mug = groups.find(g => g.name === 'Mug');
  assert.equal(beverages, undefined, 'single-child wrapper does not become a group');
  assert.ok(mug, 'the assembly node becomes a group');
  assert.equal(mug.parentId, null, 'the assembly sits at the top');
  assert.deepEqual(
    Object.values(state.scene.objects).map(o => [o.name, o.parentId]).sort(),
    [['Body', mug.id], ['Handle', mug.id]],
  );
});


await test('importing a model marks the project dirty (close-without-save must prompt)', async () => {
  resetState();
  PersistenceManager.init();
  dispatch(EVENTS.PROJECT_SAVED, {});            // baseline: clean
  assert.equal(PersistenceManager.isDirty(), false, 'clean before import');
  B.SceneLoader = { LoadAssetContainerAsync: async () => makeHierarchyContainer() };
  await AssetLoader.loadFromBlob(new Blob(['glb']), 'beverage.glb');
  assert.equal(PersistenceManager.isDirty(), true, 'import is unsaved work');
});

// Shared fake engine: an "open" mesh (fixed fake geometry above) with a
// boundary of 3 edges, repaired by appending one triangle — same shape as
// tests/mesh-repair.test.mjs's fake.
// The hole fill appends a NEW vertex plus a triangle referencing it, so the
// output is well-formed for any input size — MeshRepair now rejects engine
// output whose indices fall outside the vertex list (CIA F2), and the old
// hard-coded `[1, 2, 3]` was out of range for this 3-vertex fixture.
const FAKE_REPAIR_ENGINE = {
  diagnose: () => ({ boundary: 3, nonManifold: 0, windingInconsistencies: 0, oppositeWindingPairs: 0, components: 1, isWatertight: false }),
  repairObject: async (V, T) => ({
    V: [...V, [0, 0, 0]],
    T: [...T, [0, 1, V.length]],
    report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 },
  }),
};

async function _importThenValidate(repairOnImport) {
  resetState();
  setState(s => ({ ...s, print: { ...s.print, repairOnImport } }), { silent: true });
  MeshRepair.__test.setEngine(FAKE_REPAIR_ENGINE);
  try {
    B.SceneLoader = { LoadAssetContainerAsync: async () => makeHierarchyContainer() };
    // shouldAutoValidate is mocked false file-wide (see top) so loadFromBlob's
    // own internal queueValidation call is a no-op here (toast.validateSkipped) —
    // avoids a second, uncontrolled validation+repair pass racing this one.
    const meshIds = await AssetLoader.loadFromBlob(new Blob(['glb']), 'beverage.glb');
    MeshValidator.shouldAutoValidate = () => true;
    await Promise.all(meshIds.map(id => queueValidation(id)));
    return { meshIds, state: StateManager.getState() };
  } finally {
    MeshValidator.shouldAutoValidate = () => false;
    MeshRepair.__test.setEngine(null);
  }
}

await test('print.repairOnImport ON auto-repairs a fixable import (Task 5)', async () => {
  const { meshIds, state } = await _importThenValidate(true);
  for (const meshId of meshIds) {
    assert.ok(state.scene.objects[meshId].geometryFixes?.includes('holes'),
      `${meshId} should be auto-repaired with repairOnImport on`);
  }
});

await test('print.repairOnImport OFF leaves a fixable import unrepaired (Task 5)', async () => {
  const { meshIds, state } = await _importThenValidate(false);
  for (const meshId of meshIds) {
    assert.equal(state.scene.objects[meshId].geometryFixes, undefined,
      `${meshId} must not be auto-repaired with repairOnImport off`);
  }
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
