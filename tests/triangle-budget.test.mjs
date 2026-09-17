// Triangle-budget import warning (watertight-repair-and-cost task 7).
// Run: node --import ./tests/register-hooks.mjs tests/triangle-budget.test.mjs
//
// Verifies AssetImport.loadFromBlob's pre-add-to-scene budget check: scene
// triangles + incoming triangles compared against caps.triangleBudget. Over
// budget → a warning toast (import still proceeds); under budget → no toast.

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
const { Toast } = await import('../src/ui/Toast.js');
const { t } = await import('../src/i18n/index.js');
const { setCapabilities } = await import('../src/core/storage/capabilities.js');
const { formatTriCount } = await import('../src/ui/MeshStats.js');

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

function makeNode(name, parent = null) {
  return {
    name,
    parent,
    metadata: {},
    position: v(),
    scaling: v(1, 1, 1),
    rotation: v(),
    rotationQuaternion: null,
    setParent(p) { this.parent = p; },
    dispose() { this.disposed = true; },
  };
}

// `tris` drives getTotalIndices() = tris * 3, matching the real Babylon contract
// the budget counters (MeshStats.countSceneTriangles / countContainerTriangles) read.
function makeMesh(name, parent, tris) {
  return {
    ...makeNode(name, parent),
    geometry: {},
    material: null,
    isVisible: true,
    getTotalIndices: () => tris * 3,
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

function makeContainer(trisList) {
  const root = makeNode('__root__');
  const meshes = trisList.map((tris, i) => makeMesh(`part${i}`, root, tris));
  return {
    meshes,
    transformNodes: [root],
    materials: [],
    textures: [],
    addAllToScene() { this.added = true; },
    removeAllFromScene() {},
    dispose() { this.disposed = true; },
  };
}

// Pre-existing scene content (already has a meshId — a real print part).
function makeSceneMesh(meshId, tris) {
  return { metadata: { meshId }, geometry: {}, getTotalIndices: () => tris * 3 };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetState();
  setCapabilities({ triangleBudget: 100 }); // small, deterministic budget for every case
  const capturedToasts = [];
  Toast.show = (message, type) => { capturedToasts.push({ message, type }); return ''; };
  try { await fn({ capturedToasts }); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('scene + incoming triangles under budget → no toast, import proceeds', async ({ capturedToasts }) => {
  const scene = { meshes: [makeSceneMesh('existing1', 40)], defaultMaterial: { name: 'grey' } };
  SceneManager.getScene = () => scene;
  const container = makeContainer([30]); // 40 + 30 = 70 <= 100
  B.SceneLoader = { LoadAssetContainerAsync: async () => container };

  const meshIds = await AssetLoader.loadFromBlob(new Blob(['stl']), 'under.stl');

  // shouldAutoValidate is stubbed false file-wide, which fires its own
  // (unrelated) toast.validateSkipped info toast — filter to the budget
  // warning specifically.
  const budgetToasts = capturedToasts.filter(c => c.type === 'warning');
  assert.equal(budgetToasts.length, 0, 'no budget toast under budget');
  assert.equal(container.added, true, 'import still adds the container to the scene');
  assert.equal(meshIds.length, 1);
});

await test('scene + incoming triangles over budget → warning toast, import still proceeds', async ({ capturedToasts }) => {
  const scene = { meshes: [makeSceneMesh('existing1', 40)], defaultMaterial: { name: 'grey' } };
  SceneManager.getScene = () => scene;
  const container = makeContainer([70]); // 40 + 70 = 110 > 100
  B.SceneLoader = { LoadAssetContainerAsync: async () => container };

  const meshIds = await AssetLoader.loadFromBlob(new Blob(['stl']), 'over.stl');

  const budgetToasts = capturedToasts.filter(c => c.type === 'warning');
  assert.equal(budgetToasts.length, 1, 'exactly one budget toast fired');
  assert.equal(
    budgetToasts[0].message,
    t('toast.triangleBudget', { current: formatTriCount(110), budget: formatTriCount(100) }),
  );
  assert.equal(container.added, true, 'import proceeds despite the warning — the user was told, not blocked');
  assert.equal(meshIds.length, 1);
});

await test('toast fires BEFORE addAllToScene (incoming alone, container not yet counted as scene tris)', async ({ capturedToasts }) => {
  // Sanity check on ordering semantics: an empty scene + one over-budget
  // container still trips the warning purely from the incoming count.
  const scene = { meshes: [], defaultMaterial: { name: 'grey' } };
  SceneManager.getScene = () => scene;
  const container = makeContainer([150]); // 0 + 150 > 100
  B.SceneLoader = { LoadAssetContainerAsync: async () => container };

  await AssetLoader.loadFromBlob(new Blob(['stl']), 'incoming-only.stl');

  const budgetToasts = capturedToasts.filter(c => c.type === 'warning');
  assert.equal(budgetToasts.length, 1, 'incoming-only overage still warns');
});

// Fix round 1, finding 2: instantiateAsset() re-instantiates from a cached
// blob URL through its OWN container.addAllToScene() call site — the budget
// check must cover it too, not just loadFromBlob's.
await test('instantiateAsset (re-drop of an already-loaded asset) also warns over budget', async ({ capturedToasts }) => {
  const scene = { meshes: [makeSceneMesh('existing1', 40)], defaultMaterial: { name: 'grey' } };
  SceneManager.getScene = () => scene;

  // First load: small container, under budget, just to register the asset +
  // cache its blob URL (instantiateAsset re-reads from that cache).
  const smallContainer = makeContainer([10]); // 40 + 10 = 50 <= 100
  B.SceneLoader = { LoadAssetContainerAsync: async () => smallContainer };
  await AssetLoader.loadFromBlob(new Blob(['stl']), 'reusable.stl');
  assert.equal(capturedToasts.filter(c => c.type === 'warning').length, 0, 'initial load stayed under budget');

  const assetId = Object.keys(StateManager.getState().scene.assetLibrary)[0];
  assert.ok(assetId, 'asset registered after loadFromBlob');

  // Re-instantiate at a new drop position: this container alone pushes
  // scene(40) + incoming(70) over the 100 budget.
  const bigContainer = makeContainer([70]);
  B.SceneLoader = { LoadAssetContainerAsync: async () => bigContainer };
  const meshIds = await AssetLoader.instantiateAsset(assetId, new B.Vector3(0, 0, 0));

  const budgetToasts = capturedToasts.filter(c => c.type === 'warning');
  assert.equal(budgetToasts.length, 1, 'instantiateAsset path also warns over budget');
  assert.equal(
    budgetToasts[0].message,
    t('toast.triangleBudget', { current: formatTriCount(110), budget: formatTriCount(100) }),
  );
  assert.equal(bigContainer.added, true, 're-instantiate proceeds despite the warning');
  assert.equal(meshIds.length, 1);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
