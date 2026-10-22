// cia W-13: a single-mesh STL object is named after its file, not the
// loader's `stlmesh`, and the per-object export filename follows that name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.open = () => ({ update() {}, close() {} });
const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { collectPrintUnits } = await import('../src/core/print/ExportContext.js');
const { perMeshBaseName } = await import('../src/core/print/PrintNaming.js');

MeshValidator.shouldAutoValidate = () => false;
SceneManager.getScene = () => ({ defaultMaterial: { name: 'resin' } });
const stl = new Blob([Buffer.concat([...binaryStlChunks(4)])]);

function v(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    addInPlace(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; },
    scaleInPlace(f) { this.x *= f; this.y *= f; this.z *= f; return this; },
    scale(f) { return v(this.x * f, this.y * f, this.z * f); },
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copyFrom(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; },
    clone() { return v(this.x, this.y, this.z); },
  };
}
const matrix = () => ({ clone() { return this; }, setTranslation() {}, getTranslation: () => v(), determinant: () => 1 });
function stlMesh(name) {
  return {
    name, parent: null, metadata: {}, position: v(), scaling: v(1, 1, 1), rotation: v(), rotationQuaternion: null,
    setParent(p) { this.parent = p; }, dispose() {},
    geometry: {}, material: null, isVisible: true,
    getTotalVertices: () => 3,
    getVerticesData: () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    setVerticesData() {}, getIndices: () => [0, 1, 2], setIndices() {}, createNormals() {},
    computeWorldMatrix() {}, getWorldMatrix: matrix, bakeTransformIntoVertices() {}, refreshBoundingInfo() {}, flipFaces() {},
  };
}
function stlContainer(...names) {
  return {
    meshes: names.map(stlMesh), transformNodes: [], materials: [], textures: [],
    addAllToScene() {}, removeAllFromScene() {}, dispose() {},
  };
}
const objectNames = () => Object.values(StateManager.getState().scene.objects).map(o => o.name).sort();

test('a single-mesh STL is named after its file and the export filename uses that name', async () => {
  StateManager.replaceState(StateManager.freshState());
  B.SceneLoader = { LoadAssetContainerAsync: async () => stlContainer('stlmesh') };
  await AssetLoader.loadFromBlob(stl, 'My Part.stl');
  assert.deepEqual(objectNames(), ['My Part']);
  const [unit] = collectPrintUnits(StateManager.getState(), false);
  const ctx = { projectName: 'proj', referenceRatio: 1, targetRatio: 1 };
  assert.match(perMeshBaseName(ctx, unit.name), /^proj_My Part_/);
});

test('a second import of the same STL file gets the unique-name suffix', async () => {
  StateManager.replaceState(StateManager.freshState());
  B.SceneLoader = { LoadAssetContainerAsync: async () => stlContainer('stlmesh') };
  await AssetLoader.loadFromBlob(stl, 'My Part.stl');
  B.SceneLoader = { LoadAssetContainerAsync: async () => stlContainer('stlmesh') };
  await AssetLoader.loadFromBlob(new Blob([stl, new Uint8Array(1)]), 'My Part.stl');
  assert.deepEqual(objectNames(), ['My Part', 'My Part.001']);
});

test('a multi-solid ASCII STL keeps its solid names', async () => {
  StateManager.replaceState(StateManager.freshState());
  B.SceneLoader = { LoadAssetContainerAsync: async () => stlContainer('left', 'right') };
  await AssetLoader.loadFromBlob(stl, 'pair.stl');
  assert.deepEqual(objectNames(), ['left', 'right']);
});
