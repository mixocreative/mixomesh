// Shared headless harness for the cia cluster-L load-path tests: Babylon/scene
// shims, a one-mesh container stub, and doc fixtures. Mirrors the shims in
// persistence-load-guards.test.mjs.

import { installEnv } from './env.mjs';
import { __reset as resetIdb } from './idb-stub.mjs';

installEnv();

export const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};

const { Toast } = await import('../src/ui/Toast.js');
export const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
export const errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
export const { AssetLoader } = await import('../src/core/AssetLoader.js');
export const { MeshValidator } = await import('../src/core/MeshValidator.js');
export const { PersistenceManager, __test: PM } = await import('../src/core/PersistenceManager.js');
export const { setState, getState, subscribe, replaceState, freshState, dispatch } = await import('../src/core/StateManager.js');
export const { EVENTS } = await import('../src/core/events.js');
const { sha256Hex } = await import('../src/core/hash.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');

MeshValidator.shouldAutoValidate = () => false;
PersistenceManager.init();

const fakeScene = { transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } };
SceneManager.getScene = () => fakeScene;
for (const k of ['rebuildBed', 'setGrid', 'setCursorFromState', 'setWireframeEdgeColor', 'setOverlay',
  'applyRenderSettings', 'setScaleLock', 'setFollowMode', 'setCursorVisible', 'setActive', 'setSelected',
  'attachToSelection', 'updateBedPreview']) {
  SceneManager[k] = () => {};
}
SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});
Selection.clear = () => {};
Selection.set = () => {};
Selection.refresh = () => {};

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
    clone() { return this; }, setTranslation() {}, getTranslation() { return v(); }, determinant() { return 1; },
    decompose(s, q, p) { s.set(1, 1, 1); q.x = 0; q.y = 0; q.z = 0; q.w = 1; p.set(0, 0, 0); return true; },
  };
}
export function makeMesh(name) {
  return {
    name, parent: null, metadata: {}, geometry: {}, material: null, isVisible: true,
    position: v(), scaling: v(1, 1, 1), rotation: v(), rotationQuaternion: null,
    setParent(p) { this.parent = p; },
    setEnabled(on) { this.enabled = on; },
    dispose() { this.disposed = true; },
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
export function makeContainer() {
  return {
    meshes: [makeMesh('Body')], transformNodes: [], materials: [], textures: [],
    addAllToScene() {}, removeAllFromScene() {}, dispose() {},
  };
}
B.MeshBuilder = { CreateBox: (name) => makeMesh(name) };
B.TransformNode = function (name, scene) {
  const n = makeMesh(name);
  scene?.transformNodes?.push?.(n);
  return n;
};
B.SceneLoader = { LoadAssetContainerAsync: async () => makeContainer() };

const GLB = new TextEncoder().encode('glb-bytes');
const GLB_B64 = encodeBase64(GLB.buffer);
const GLB_HASH = await sha256Hex(GLB.buffer);
export const XFORM = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };

export function meshAsset(id, over = {}) {
  return {
    id, name: id, filename: `${id}.glb`, extension: '.glb', kind: 'mesh',
    sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1,
    directoryHandleKey: null, fileHandleKey: null, originalPath: null,
    fileData: GLB_B64, contentHash: GLB_HASH, ...over,
  };
}
export function sceneObject(id, assetId, over = {}) {
  return {
    id, name: id, assetId, collectionId: null, parentId: null, shaderId: null,
    visible: true, locked: false, isGhost: false, isPrintPart: true,
    containerMeshIndex: 0, ratio: 1, transform: XFORM, ...over,
  };
}
export function goodDoc(name = 'Loaded') {
  return {
    version: '3.5', project: { name, id: `id-${name}` },
    assetLibrary: [meshAsset('a_ok')],
    sceneObjects: [sceneObject('o_ok', 'a_ok')],
  };
}
export function seedCurrentScene() {
  resetIdb();
  toasts.length = 0; errors.length = 0;
  replaceState(freshState());
  setState(s => ({
    ...s,
    project: { ...s.project, name: 'Current', id: 'cur-id' },
    scene: { ...s.scene, objects: { keep: { id: 'keep', name: 'keep', assetId: 'x', isGhost: false } } },
  }), { silent: true });
}
