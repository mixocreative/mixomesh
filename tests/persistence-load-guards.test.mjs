// Load-side guards (audit 2026-09-17 persist H1 / H3 / F20 / M2 / M5):
//   • schema/shape validation runs BEFORE the world is reset — a bad .mixo
//     leaves the current project untouched
//   • ghost assets are surfaced (ghostAssets modal) and the project stays
//     saveable (ghost: true marker, no fileData) and reopens with the same ghosts
//   • import ↔ project-load mutual exclusion
//   • autosave tick skips during load/import; a poisoned autosave is deleted
//     after a failed recovery instead of being re-offered every boot
//   • embedded bytes whose sha256 disagrees with contentHash resolve to ghost
//   node --import ./tests/register-hooks.mjs tests/persistence-load-guards.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { kvSet, kvGet, kvKeys, __reset as resetIdb } from './idb-stub.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};

const { Toast } = await import('../src/ui/Toast.js');
const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
const errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { PersistenceManager, __test } = await import('../src/core/PersistenceManager.js');
const { setState, getState, subscribe, replaceState, freshState } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { sha256Hex } = await import('../src/core/hash.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');
const { isLoading } = await import('../src/core/persist/ProjectLoader.js');

MeshValidator.shouldAutoValidate = () => false;
PersistenceManager.init();   // wire dirty tracking (autosave tick reads isDirty)

// ── Headless scene shims ──────────────────────────────────
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
    // buildDocument decomposes the world matrix of every live mesh.
    decompose(s, q, p) { s.set(1, 1, 1); q.x = 0; q.y = 0; q.z = 0; q.w = 1; p.set(0, 0, 0); return true; },
  };
}
function makeMesh(name) {
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
function makeContainer() {
  return {
    meshes: [makeMesh('Body')], transformNodes: [], materials: [], textures: [],
    addAllToScene() {}, removeAllFromScene() {}, dispose() {},
  };
}
B.MeshBuilder = { CreateBox: (name) => makeMesh(name) };
B.SceneLoader = { LoadAssetContainerAsync: async () => makeContainer() };

// Modal capture — the flows under test dispatch MODAL_OPEN.
const modals = [];
let recoverChoice = 'recover';
subscribe(EVENTS.MODAL_OPEN, (p) => {
  modals.push(p);
  if (p?.id === 'recoverAutosave') p.onClose?.(recoverChoice);
});

// ── Fixtures ─────────────────────────────────────────────
const GLB = new TextEncoder().encode('glb-bytes');
const GLB_B64 = encodeBase64(GLB.buffer);
const GLB_HASH = await sha256Hex(GLB.buffer);
const XFORM = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };

function meshAsset(id, over = {}) {
  return {
    id, name: id, filename: `${id}.glb`, extension: '.glb', kind: 'mesh',
    sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1,
    directoryHandleKey: null, fileHandleKey: null, originalPath: null,
    fileData: null, contentHash: null, ...over,
  };
}
function sceneObject(id, assetId) {
  return {
    id, name: id, assetId, collectionId: null, parentId: null, shaderId: null,
    visible: true, locked: false, isGhost: false, isPrintPart: true,
    containerMeshIndex: 0, ratio: 1, transform: XFORM,
  };
}
function goodDoc(name = 'Loaded') {
  return {
    version: '3.3', project: { name },
    assetLibrary: [meshAsset('a_ok', { fileData: GLB_B64, contentHash: GLB_HASH })],
    sceneObjects: [sceneObject('o_ok', 'a_ok')],
  };
}
function seedCurrentScene() {
  replaceState(freshState());
  setState(s => ({
    ...s,
    project: { ...s.project, name: 'Current' },
    scene: { ...s.scene, objects: { keep: { id: 'keep', name: 'keep', assetId: 'x', isGhost: false } } },
  }), { silent: true });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// loadFromBlob hashes the blob (crypto.subtle, real async) BEFORE it bumps
// the import depth — wait for the flag rather than for one macrotask.
async function waitFor(pred, label, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 1));
  }
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetIdb();
  toasts.length = 0; modals.length = 0; errors.length = 0;
  AssetLoader.getAssetBytes = async () => null;
  B.SceneLoader = { LoadAssetContainerAsync: async () => makeContainer() };
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// ── Sanity: the harness can complete a full load ──────────

await test('harness: a well-formed doc loads headless', async () => {
  seedCurrentScene();
  await __test._loadProject(goodDoc());
  assert.equal(getState().project.name, 'Loaded');
  assert.ok(getState().scene.objects.o_ok);
  assert.equal(getState().scene.objects.o_ok.isGhost, false);
  assert.equal(isLoading(), false);
});

// ── Item 1: validation before reset (H1) ──────────────────

await test('H1: newer major version → throws with update message, current scene untouched', async () => {
  seedCurrentScene();
  await assert.rejects(__test._loadProject({ ...goodDoc(), version: '4.0' }),
    /saved by a newer MIXOMESH \(v4\)/);
  assert.ok(getState().scene.objects.keep, 'world was NOT reset');
  assert.equal(getState().project.name, 'Current');
});

await test('H1: array-typed field holding a string → malformed error, scene untouched', async () => {
  seedCurrentScene();
  await assert.rejects(__test._loadProject({ ...goodDoc(), assetLibrary: 'nope' }),
    /\.mixo is malformed: assetLibrary must be an array/);
  assert.ok(getState().scene.objects.keep);
  await assert.rejects(__test._loadProject({ ...goodDoc(), sceneObjects: 42 }),
    /sceneObjects must be an array/);
  await assert.rejects(__test._loadProject({ ...goodDoc(), shaders: { a: 1 } }),
    /shaders must be an array/);
  assert.ok(getState().scene.objects.keep);
});

await test('H1: non-object document / non-object scene / non-string version → malformed', async () => {
  seedCurrentScene();
  await assert.rejects(__test._loadProject('[]'), /malformed/);
  await assert.rejects(__test._loadProject([1]), /malformed/);
  await assert.rejects(__test._loadProject({ ...goodDoc(), scene: 'x' }), /scene must be an object/);
  await assert.rejects(__test._loadProject({ ...goodDoc(), version: 3.3 }), /version/);
  assert.ok(getState().scene.objects.keep);
});

await test('H1: missing version (legacy) and same-major minor bump still load', async () => {
  seedCurrentScene();
  const legacy = goodDoc('Legacy'); delete legacy.version;
  await __test._loadProject(legacy);
  assert.equal(getState().project.name, 'Legacy');
  await __test._loadProject({ ...goodDoc('Minor'), version: '3.9' });
  assert.equal(getState().project.name, 'Minor');
});

await test('H1: open() with corrupt JSON → clear error, scene untouched, no handle bound', async () => {
  seedCurrentScene();
  window.showOpenFilePicker = async () => [{
    name: 'bad.mixo', kind: 'file',
    async getFile() { return { text: async () => '{ not json' }; },
  }];
  await assert.rejects(PersistenceManager.open(), /Not a \.mixo file or the file is corrupt/);
  assert.ok(getState().scene.objects.keep);
});

// ── Item 2: ghosts surfaced + saveable (H3) ───────────────

await test('H3: one resolvable + one unresolvable → ghostAssets modal, warning toast, saveable, reopens with ghost', async () => {
  seedCurrentScene();
  const doc = goodDoc('Ghosty');
  doc.assetLibrary.push(meshAsset('a_lost', { contentHash: 'abc' }));
  doc.sceneObjects.push(sceneObject('o_lost', 'a_lost'));
  await __test._loadProject(doc);

  assert.equal(getState().scene.objects.o_ok.isGhost, false);
  assert.equal(getState().scene.objects.o_lost.isGhost, true);
  assert.equal(getState().scene.assetLibrary.a_lost.isGhost, true);

  const ghostModal = modals.find(m => m.id === 'ghostAssets');
  assert.ok(ghostModal, 'ghostAssets modal dispatched');
  assert.deepEqual(ghostModal.assets.map(a => a.filename), ['a_lost.glb']);
  assert.ok(!toasts.some(x => x.msg === 'Loaded Ghosty'), 'plain Loaded toast suppressed');
  assert.ok(toasts.some(x => x.type === 'warning'), 'warning toast shown');

  // Saveable: ghost carries the marker, no fileData, no portable error.
  AssetLoader.getAssetBytes = async id => (id === 'a_ok' ? GLB.buffer.slice(0) : null);
  const saved = await __test._buildDocument();
  const lost = saved.assetLibrary.find(a => a.id === 'a_lost');
  assert.equal(lost.ghost, true);
  assert.equal(lost.fileData, null);
  assert.equal(lost.contentHash, 'abc', 'hash kept for a later relink');
  assert.equal(saved.assetLibrary.find(a => a.id === 'a_ok').ghost, undefined);

  // Reopen the saved doc → same ghost again, still surfaced.
  modals.length = 0;
  await __test._loadProject(saved);
  assert.equal(getState().scene.objects.o_lost.isGhost, true);
  assert.equal(getState().scene.objects.o_ok.isGhost, false);
  assert.ok(modals.find(m => m.id === 'ghostAssets'));
});

await test('H3: no ghosts → plain Loaded toast, no ghost modal', async () => {
  seedCurrentScene();
  await __test._loadProject(goodDoc('Clean'));
  assert.ok(!modals.find(m => m.id === 'ghostAssets'));
  assert.ok(toasts.some(x => x.type === 'success' && /Clean/.test(x.msg)));
});

// ── Item 6: contentHash mismatch → ghost, console.error (M5) ──

await test('M5: tampered embedded bytes → ghost + console.error, load completes', async () => {
  seedCurrentScene();
  const tampered = encodeBase64(new TextEncoder().encode('tampered!').buffer);
  const doc = goodDoc('Tampered');
  doc.assetLibrary[0].fileData = tampered;     // hash still GLB_HASH
  await __test._loadProject(doc);
  assert.equal(getState().scene.objects.o_ok.isGhost, true, 'mismatch is unresolvable → ghost');
  assert.ok(errors.some(e => /contentHash/i.test(e)), 'mismatch logged');
  assert.ok(modals.find(m => m.id === 'ghostAssets'));
});

// ── Item 4: import ↔ load mutual exclusion (F20) ──────────

await test('F20: loadProject refuses while an import is in flight', async () => {
  seedCurrentScene();
  const d = deferred();
  B.SceneLoader = { LoadAssetContainerAsync: () => d.promise };
  const importing = AssetLoader.loadFromBlob(new Blob(['glb']), 'slow.glb');
  await waitFor(() => AssetLoader.isImporting(), 'import in flight');
  assert.equal(AssetLoader.isImporting(), true);
  await assert.rejects(__test._loadProject(goodDoc()), /import is still running/);
  assert.ok(getState().scene.objects.keep, 'world untouched');
  await assert.rejects(PersistenceManager.newProject(), /import is still running/);
  assert.ok(getState().scene.objects.keep, 'world untouched');
  d.resolve(makeContainer());
  await importing;
  assert.equal(AssetLoader.isImporting(), false);
});

await test('F20: import refuses while a project is loading', async () => {
  seedCurrentScene();
  const d = deferred();
  const realRestore = AssetLoader.restoreContainer;
  AssetLoader.restoreContainer = () => d.promise;
  try {
    const loading = __test._loadProject(goodDoc());
    await waitFor(() => isLoading(), 'load in flight');
    assert.equal(isLoading(), true);
    await assert.rejects(AssetLoader.loadFromBlob(new Blob(['glb']), 'x.glb'), /project is still loading/);
    d.resolve([makeMesh('Body')]);
    await loading;
  } finally {
    AssetLoader.restoreContainer = realRestore;
  }
  assert.equal(isLoading(), false);
});

await test('F20: isLoading() resets after a failed load', async () => {
  seedCurrentScene();
  const realRestore = AssetLoader.restoreContainer;
  AssetLoader.restoreContainer = async () => { throw new Error('boom'); };
  try {
    // restore failure → ghost (caught), so use a texture-image hash mismatch to throw mid-load
    const doc = goodDoc();
    doc.textureImages = [{ hash: 'deadbeef', fileData: 'AAAA', width: 1, height: 1, mimeType: 'image/png' }];
    await assert.rejects(__test._loadProject(doc));
  } finally {
    AssetLoader.restoreContainer = realRestore;
  }
  assert.equal(isLoading(), false);
});

// ── Item 5: autosave races (M2) ───────────────────────────

await test('M2: autosave tick skips while loading / importing', async () => {
  replaceState(freshState());   // empty project: buildDocument({skipEmbed}) succeeds
  const { setLoading } = await import('../src/core/persist/LoadGate.js');
  const { dispatch } = await import('../src/core/StateManager.js');
  let ticks = 0;
  const off = subscribe(EVENTS.AUTOSAVE_WRITTEN, () => { ticks++; });
  // Capture the interval callback and drive it by hand — deterministic under
  // parallel test load (a 5 ms timer is not).
  const realSetInterval = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return realSetInterval(() => {}, 1 << 30); };
  try {
    PersistenceManager.startAutosave(5);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  dispatch(EVENTS.PROJECT_DIRTY, {});
  assert.equal(PersistenceManager.isDirty(), true, 'precondition: dirty, so the tick would write');
  try {
    setLoading(true);
    await tick();
    assert.equal(ticks, 0, 'no autosave while loading');
    setLoading(false);
    const d = deferred();
    B.SceneLoader = { LoadAssetContainerAsync: () => d.promise };
    const importing = AssetLoader.loadFromBlob(new Blob(['glb']), 'slow.glb');
    await waitFor(() => AssetLoader.isImporting(), 'import in flight');
    await tick();
    assert.equal(ticks, 0, 'no autosave while importing');
    d.resolve(makeContainer());
    await importing;
    AssetLoader.getAssetBytes = async () => GLB.buffer.slice(0);   // loose drop embeds on autosave (M7)
    await tick();
    assert.equal(ticks, 1, `autosave resumes once neither is in flight (errors: ${errors.join(' | ')})`);
  } finally {
    PersistenceManager.stopAutosave();
    off();
    setLoading(false);
  }
});

await test('M2: successful load clears the OLD project name autosave key; failed load keeps it', async () => {
  seedCurrentScene();   // name 'Current'
  await kvSet('autosave_Current', { savedAt: 'x', doc: {} });
  await assert.rejects(__test._loadProject({ ...goodDoc(), version: '9.0' }));
  assert.ok(await kvGet('autosave_Current'), 'failed load leaves the old key');
  await __test._loadProject(goodDoc('Next'));
  assert.equal(await kvGet('autosave_Current'), undefined, 'old key gone after success');
});

await test('M2: recoverAutosave with a poisoned doc → deletes the key, returns false, error surfaced', async () => {
  seedCurrentScene();
  await kvSet('autosave_Poison', { savedAt: '2026-01-01T00:00:00Z', doc: { version: '9.0', project: { name: 'Poison' } } });
  recoverChoice = 'recover';
  const ok = await PersistenceManager.recoverAutosave();
  assert.equal(ok, false);
  assert.ok(!(await kvKeys()).includes('autosave_Poison'), 'poisoned key deleted');
  assert.ok(errors.some(e => /newer MIXOMESH/.test(e)), 'failure reported');
  assert.ok(getState().scene.objects.keep, 'current scene untouched');
});

await test('M2: recoverAutosave refuses while importing', async () => {
  const d = deferred();
  B.SceneLoader = { LoadAssetContainerAsync: () => d.promise };
  const importing = AssetLoader.loadFromBlob(new Blob(['glb']), 'slow.glb');
  await waitFor(() => AssetLoader.isImporting(), 'import in flight');
  await assert.rejects(PersistenceManager.recoverAutosave(), /import is still running/);
  d.resolve(makeContainer());
  await importing;
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
