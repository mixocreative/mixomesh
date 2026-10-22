// RelinkAssetCommand (overhaul 4.5): relink / refresh are one undoable command.
//   node --import ./tests/register-hooks.mjs tests/relink-asset.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { __reset as resetIdb } from './idb-stub.mjs';

installEnv();
console.error = () => {};

// Real blob-URL round trip (env.mjs stubs every URL to 'blob:stub'): revoke
// really forgets the blob, so a wrongly revoked live set fails the byte checks.
const blobs = new Map();
let urlN = 0;
URL.createObjectURL = (b) => { const u = `blob:t${++urlN}`; blobs.set(u, b); return u; };
URL.revokeObjectURL = (u) => { blobs.delete(u); };
globalThis.fetch = async (u) => {
  const b = blobs.get(u);
  if (!b) throw new Error(`revoked ${u}`);
  return { arrayBuffer: () => b.arrayBuffer() };
};

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.open = () => ({ update() {}, close() {} });
const { Toast } = await import('../src/ui/Toast.js');
Toast.show = () => {};

const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { PersistenceManager, __test } = await import('../src/core/PersistenceManager.js');
const { getState } = await import('../src/core/StateManager.js');
const { sha256Hex } = await import('../src/core/hash.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');
const HM = await import('../src/core/HistoryManager.js');
const realGetAssetBytes = AssetLoader.getAssetBytes;

MeshValidator.shouldAutoValidate = () => false;
PersistenceManager.init();

// Headless scene shims (same shape as persistence-load-guards.test.mjs)
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
Selection.clear = () => {}; Selection.set = () => {}; Selection.refresh = () => {};

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
function makeMesh(name) {
  return {
    name, parent: null, metadata: {}, geometry: {}, material: null, isVisible: true, enabled: true,
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
function makeContainer() {
  return {
    meshes: [makeMesh('Body')], transformNodes: [], materials: [], textures: [],
    addAllToScene() {}, removeAllFromScene() {}, dispose() {},
  };
}
B.MeshBuilder = { CreateBox: (name) => makeMesh(name) };
B.SceneLoader = { LoadAssetContainerAsync: async () => makeContainer() };

// Fixtures
const OLD = new TextEncoder().encode('glb-old-bytes');
const NEW = new TextEncoder().encode('glb-NEW-bytes-longer');
const OLD_HASH = await sha256Hex(OLD.buffer);
const NEW_HASH = await sha256Hex(NEW.buffer);
const XFORM = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };

function doc({ ghost }) {
  return {
    version: '3.4', project: { name: 'Relink' },
    assetLibrary: [{
      id: 'a1', name: 'a1', filename: 'a1.glb', extension: '.glb', kind: 'mesh',
      sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1,
      directoryHandleKey: null, fileHandleKey: null, originalPath: null,
      fileData: null, contentHash: OLD_HASH,
      ...(ghost ? {} : { fileData: encodeBase64(OLD.buffer), directoryHandleKey: 'dir_x', originalPath: 'sub/a1.glb' }),
    }],
    sceneObjects: [{
      id: 'o1', name: 'o1', assetId: 'a1', collectionId: null, parentId: null, shaderId: null,
      visible: true, locked: false, isGhost: false, isPrintPart: true,
      containerMeshIndex: 0, ratio: 2, transform: XFORM,
    }],
  };
}
async function load(opts) {
  resetIdb();
  HM.clear();
  AssetLoader.getAssetBytes = realGetAssetBytes;
  await __test._loadProject(doc(opts));
}
async function saved() {
  const d = await __test._buildDocument();
  const a = d.assetLibrary.find(x => x.id === 'a1');
  return { a, bytes: a.fileData ? [...new Uint8Array(Buffer.from(a.fileData, 'base64'))] : null };
}
const bytesOf = (u8) => [...u8];
const mk = (u8) => new Blob([u8]);

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('ghost relink: new hash + new bytes embedded; undo -> ghost again; redo re-applies', async () => {
  await load({ ghost: true });
  assert.equal(getState().scene.objects.o1.isGhost, true);
  const ghostMesh = AssetLoader.getBabylonMesh('o1');
  const entry0 = { ...getState().scene.assetLibrary.a1 };
  assert.equal(entry0.isGhost, true);

  const cmd = await HM.RelinkAssetCommand.create('a1', {
    blob: mk(NEW), filename: 'picked.glb',
    link: { fileHandleKey: 'file_abc', source: { kind: 'file', refKey: 'file_abc', path: 'picked.glb', label: 'picked.glb' } },
  });
  HM.push(cmd);
  const e = getState().scene.assetLibrary.a1;
  assert.equal(e.contentHash, NEW_HASH);
  assert.equal(e.isGhost, false);
  assert.equal(e.filename, 'picked.glb');
  assert.equal(e.fileHandleKey, 'file_abc');
  const o1 = getState().scene.objects.o1;
  assert.equal(o1.isGhost, false);
  assert.equal(o1.ratio, 2, 'ratio kept');
  const newMesh = AssetLoader.getBabylonMesh('o1');
  assert.notEqual(newMesh, ghostMesh);
  assert.equal(newMesh.enabled, true);
  let s = await saved();
  assert.equal(s.a.contentHash, NEW_HASH);
  assert.equal(s.a.ghost, undefined);
  assert.deepEqual(s.bytes, bytesOf(NEW), 'save embeds the NEW bytes');
  assert.equal(s.a.source?.refKey, 'file_abc');

  HM.undo();
  assert.deepEqual(getState().scene.assetLibrary.a1, entry0, 'entry restored exactly');
  assert.equal(getState().scene.objects.o1.isGhost, true);
  assert.equal(AssetLoader.getBabylonMesh('o1'), ghostMesh);
  assert.equal(newMesh.enabled, false);
  s = await saved();
  assert.equal(s.a.ghost, true);
  assert.equal(s.a.contentHash, OLD_HASH);
  assert.equal(s.bytes, null);

  HM.redo();
  assert.equal(getState().scene.assetLibrary.a1.contentHash, NEW_HASH);
  assert.equal(AssetLoader.getBabylonMesh('o1'), newMesh, 'redo re-binds the same prepared mesh');
  assert.equal(getState().scene.objects.o1.isGhost, false);
  s = await saved();
  assert.deepEqual(s.bytes, bytesOf(NEW));
  assert.equal(s.a.contentHash, NEW_HASH);
});

await test('refresh of a changed asset picks up new bytes, keeps the link; undo restores old bytes', async () => {
  await load({ ghost: false });
  assert.equal(getState().scene.objects.o1.isGhost, false);
  const entry0 = { ...getState().scene.assetLibrary.a1 };
  const mesh0 = AssetLoader.getBabylonMesh('o1');
  let s = await saved();
  assert.deepEqual(s.bytes, bytesOf(OLD));

  HM.push(await HM.RelinkAssetCommand.create('a1', { blob: mk(NEW), filename: entry0.filename, label: 'Refresh Asset' }));
  const e = getState().scene.assetLibrary.a1;
  assert.equal(e.contentHash, NEW_HASH);
  assert.equal(e.directoryHandleKey, 'dir_x', 'link kept on refresh');
  assert.equal(e.originalPath, 'sub/a1.glb');
  assert.notEqual(AssetLoader.getBabylonMesh('o1'), mesh0);
  assert.equal(HM.getUndoLabel(), 'Refresh Asset');
  s = await saved();
  assert.deepEqual(s.bytes, bytesOf(NEW));
  assert.equal(s.a.contentHash, NEW_HASH);

  HM.undo();
  assert.deepEqual(getState().scene.assetLibrary.a1, entry0);
  assert.equal(AssetLoader.getBabylonMesh('o1'), mesh0);
  assert.equal(mesh0.enabled, true);
  s = await saved();
  assert.deepEqual(s.bytes, bytesOf(OLD), 'undo re-embeds the OLD bytes');
  assert.equal(s.a.contentHash, OLD_HASH);
});

await test('failed load leaves the live asset untouched (no command created)', async () => {
  await load({ ghost: false });
  const entry0 = { ...getState().scene.assetLibrary.a1 };
  const mesh0 = AssetLoader.getBabylonMesh('o1');
  const prev = B.SceneLoader;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { throw new Error('bad file'); } };
  try {
    await assert.rejects(HM.RelinkAssetCommand.create('a1', { blob: mk(NEW), filename: 'x.glb' }), /bad file/);
  } finally { B.SceneLoader = prev; }
  assert.deepEqual(getState().scene.assetLibrary.a1, entry0);
  assert.equal(AssetLoader.getBabylonMesh('o1'), mesh0);
  const s = await saved();
  assert.deepEqual(s.bytes, bytesOf(OLD), 'live bytes still resolvable');
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
