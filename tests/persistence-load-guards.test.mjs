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
const { setState, getState, subscribe, replaceState, freshState, markDirty } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { sha256Hex } = await import('../src/core/hash.js');
const { encodeBase64 } = await import('../src/core/workers/base64Codec.js');
const { isLoading } = await import('../src/core/persist/ProjectLoader.js');
const { findRecoverableAutosave, discardAutosave } = await import('../src/core/persist/Autosave.js');

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
subscribe(EVENTS.MODAL_OPEN, (p) => { modals.push(p); });

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
    project: { ...s.project, name: 'Current', id: 'cur-id' },
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

// ── Task 1.17: typed print sizes migration + one-minor mirror ──

await test('1.17: legacy exportRatios:[144] loads as exportTargets [{kind:ratio,value:144}]', async () => {
  seedCurrentScene();
  await __test._loadProject({ ...goodDoc('Legacy ratios'), print: { exportRatios: [144] } });
  assert.deepEqual(getState().print.exportTargets, [{ kind: 'ratio', value: 144 }]);
  assert.equal('exportRatios' in getState().print, false, 'the ratio mirror never lives in state');
  // typed list wins over a stale mirror; pre-redesign single targetRatio still migrates
  assert.deepEqual(__test._resolveLoadedExportTargets({ exportTargets: [{ kind: 'factor', value: 2 }], exportRatios: [9] }),
    [{ kind: 'factor', value: 2 }]);
  assert.deepEqual(__test._resolveLoadedExportTargets({ targetRatio: 35 }), [{ kind: 'ratio', value: 35 }]);
  assert.deepEqual(__test._resolveLoadedExportTargets({}), []);
});

await test('1.17: save writes exportTargets + a ratio-only exportRatios mirror; reload round-trips', async () => {
  seedCurrentScene();
  await __test._loadProject(goodDoc('Typed'));
  const targets = [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }, { kind: 'height', mm: 120 }];
  setState(s => ({ ...s, print: { ...s.print, exportTargets: targets } }), { silent: true });
  AssetLoader.getAssetBytes = async () => GLB.buffer;
  const doc = await __test._buildDocument({ skipTextureImages: true });
  assert.deepEqual(doc.print.exportTargets, targets);
  assert.deepEqual(doc.print.exportRatios, [144], 'mirror carries ratio targets only (3.3 readers)');
  await __test._loadProject({ ...goodDoc('Typed'), print: JSON.parse(JSON.stringify(doc.print)) });
  assert.deepEqual(getState().print.exportTargets, targets);
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

  const ghostModal = modals.find(m => m.id === 'assetSources');
  assert.ok(ghostModal, 'Sources modal dispatched for ghosts');
  assert.deepEqual(ghostModal.ghosts.map(a => a.filename), ['a_lost.glb']);
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
  assert.ok(modals.find(m => m.id === 'assetSources'));
});

await test('H3: no ghosts → plain Loaded toast, no ghost modal', async () => {
  seedCurrentScene();
  await __test._loadProject(goodDoc('Clean'));
  assert.ok(!modals.find(m => m.id === 'assetSources'));
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
  assert.ok(modals.find(m => m.id === 'assetSources'));
});

// ── geometryFixes replay fault isolation (review 2026-09-17) ──
// A persisted 'holes'/'nonManifold' fix replays through the MeshRepair
// engine on load (MeshValidator.replayGeometryFixes); if that engine call
// fails (down, or the triangle cap), the failure must be isolated to the one
// object — its ORIGINAL geometry is already bound and stays loaded (not
// ghosted: the geometry is present, only the fix didn't re-apply) — and must
// not abort the rest of the .mixo load.

await test('geometryFixes replay failure (engine down) does not abort the load — both objects stay loaded', async () => {
  seedCurrentScene();
  const { __test: repairTest } = await import('../src/core/repair/MeshRepair.js');
  repairTest.setEngine(null);
  const doc = goodDoc('Repaired');
  doc.sceneObjects[0] = { ...doc.sceneObjects[0], geometryFixes: ['holes'] };
  doc.assetLibrary.push(meshAsset('a_ok2', { fileData: GLB_B64, contentHash: GLB_HASH }));
  doc.sceneObjects.push({ ...sceneObject('o_ok2', 'a_ok2'), geometryFixes: ['holes'] });
  await __test._loadProject(doc);
  assert.ok(getState().scene.objects.o_ok, 'first object stays loaded');
  assert.ok(getState().scene.objects.o_ok2, 'second object stays loaded');
  assert.equal(getState().scene.objects.o_ok.isGhost, false, 'not ghosted — geometry is present');
  assert.equal(getState().scene.objects.o_ok2.isGhost, false, 'not ghosted — geometry is present');
  assert.ok(errors.some(e => /geometry-fix replay failed/i.test(e)), 'replay failure logged, not swallowed silently');
});

await test('0.5: failed geometryFixes replay removes the fix from state + toasts the object name; load continues', async () => {
  seedCurrentScene();
  toasts.length = 0;
  const { __test: repairTest } = await import('../src/core/repair/MeshRepair.js');
  repairTest.setEngine(null);
  const doc = goodDoc('Repaired');
  doc.sceneObjects[0] = { ...doc.sceneObjects[0], name: 'Dragon', geometryFixes: ['holes'] };
  doc.assetLibrary.push(meshAsset('a_ok3', { fileData: GLB_B64, contentHash: GLB_HASH }));
  doc.sceneObjects.push(sceneObject('o_ok3', 'a_ok3'));   // no fixes — unaffected
  await __test._loadProject(doc);
  const objs = getState().scene.objects;
  assert.ok(objs.o_ok && objs.o_ok3, 'load continued');
  assert.equal(objs.o_ok.geometryFixes, undefined, 'failed fix not kept as if applied');
  assert.ok(toasts.some(x => /Dragon/.test(x.msg) && x.type === 'warning'), 'toast names the object');
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

await test('F20 window: import is flagged synchronously, before the first await; open() refuses before the dirty confirm', async () => {
  seedCurrentScene();
  const d = deferred();
  B.SceneLoader = { LoadAssetContainerAsync: () => d.promise };
  const importing = AssetLoader.loadFromBlob(new Blob(['glb']), 'slow2.glb');
  // No await between the call and this check: the hash await has not resolved yet.
  assert.equal(AssetLoader.isImporting(), true, 'flagged before any await');
  const before = modals.length;
  markDirty();   // dirty project: the confirm would show if the guard ran after it
  try {
    await assert.rejects(PersistenceManager.open(), /import is still running/);
    await assert.rejects(PersistenceManager.openRecent({ handleKey: 'k' }), /import is still running/);
    assert.equal(modals.length, before, 'no dirty confirm shown');
  } finally {
    d.resolve(makeContainer());
    await importing;
  }
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

await test('M2/0.11: successful load clears the OLD project id autosave (+ its images); failed load keeps it', async () => {
  seedCurrentScene();   // id 'cur-id'
  await kvSet('autosave_cur-id', { savedAt: 'x', doc: {} });
  await kvSet('autosaveimg_cur-id_abc', { hash: 'abc' });
  await assert.rejects(__test._loadProject({ ...goodDoc(), version: '9.0' }));
  assert.ok(await kvGet('autosave_cur-id'), 'failed load leaves the old key');
  await __test._loadProject(goodDoc('Next'));
  assert.equal(await kvGet('autosave_cur-id'), undefined, 'old key gone after success');
  assert.equal(await kvGet('autosaveimg_cur-id_abc'), undefined, 'old image keys gone too');
});

// ── 0.11: autosave keyed by project.id, images stored once, boot offer ──
await test('0.11: load keeps a document id, mints one for a legacy doc, restores lastSavedAt', async () => {
  seedCurrentScene();
  await __test._loadProject({ ...goodDoc('WithId'), savedAt: '2026-10-01T00:00:00.000Z', project: { name: 'WithId', id: 'doc-id' } });
  assert.equal(getState().project.id, 'doc-id');
  assert.equal(getState().project.lastSavedAt, '2026-10-01T00:00:00.000Z');
  await __test._loadProject(goodDoc('Legacy'));
  const minted = getState().project.id;
  assert.ok(typeof minted === 'string' && minted.length > 0 && minted !== 'doc-id', 'legacy doc gets a fresh id');
});

await test('0.11: tick writes autosave_<id> with no inline images; each texture image stored ONCE', async () => {
  replaceState(freshState());
  const { storeTextureImage } = await import('../src/core/assets/TextureImageStore.js');
  const { autosaveTick } = await import('../src/core/persist/Autosave.js');
  const { dispatch } = await import('../src/core/StateManager.js');
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = await sha256Hex(bytes.buffer);
  await storeTextureImage(new Blob([bytes], { type: 'image/png' }), 2, 2, hash);
  setState(st => ({
    ...st,
    project: { ...st.project, id: 'tick-id', name: 'TickProj' },
    scene: { ...st.scene, assetLibrary: { t1: { id: 't1', kind: 'texture', filename: 't.png', imageContentHash: hash } } },
  }), { silent: true });
  dispatch(EVENTS.PROJECT_DIRTY, {});
  assert.equal(await autosaveTick(), true, `tick wrote (errors: ${errors.join(' | ')})`);
  const snap = await kvGet('autosave_tick-id');
  assert.ok(snap?.doc, 'snapshot under autosave_<id>');
  assert.deepEqual(snap.doc.textureImages, [], 'images not inlined in the snapshot');
  assert.equal(snap.doc.project.id, 'tick-id');
  const img = await kvGet(`autosaveimg_tick-id_${hash}`);
  assert.equal(img?.hash, hash, 'image stored under its own key');
  await kvSet(`autosaveimg_tick-id_${hash}`, { hash, sentinel: true });
  dispatch(EVENTS.PROJECT_DIRTY, {});
  assert.equal(await autosaveTick(), true);
  assert.equal((await kvGet(`autosaveimg_tick-id_${hash}`))?.sentinel, true, 'second tick did not re-encode the image');
});

await test('0.11/4.7: boot offer skipped (and key dropped) when the autosave is not newer than the last save', async () => {
  seedCurrentScene();
  resetIdb();
  await kvSet('autosave_old-id', { savedAt: '2026-01-01T00:00:00.000Z', doc: { ...goodDoc('Old'), project: { name: 'Old', id: 'old-id', lastSavedAt: '2026-02-01T00:00:00.000Z' } } });
  const before = modals.length;
  assert.equal(await findRecoverableAutosave(), null, 'no banner offer for a stale autosave');
  assert.equal(await kvGet('autosave_old-id'), undefined, 'stale autosave removed');
  assert.equal(await PersistenceManager.recoverAutosave(), false);
  assert.equal(modals.length, before, 'boot recovery never opens a modal (Decision 4)');
});

await test('4.7: findRecoverableAutosave returns the newest newer-than-saved snapshot without loading it', async () => {
  seedCurrentScene();
  resetIdb();
  await kvSet('autosave_a-id', { savedAt: '2026-03-01T10:00:00.000Z', name: 'A', doc: { ...goodDoc('A'), project: { name: 'A', id: 'a-id', lastSavedAt: '2026-01-01T00:00:00.000Z' } } });
  await kvSet('autosave_b-id', { savedAt: '2026-03-02T14:02:00.000Z', name: 'B', doc: { ...goodDoc('B'), project: { name: 'B', id: 'b-id' } } });
  const before = modals.length;
  const offer = await findRecoverableAutosave();
  assert.equal(offer?.projectId, 'b-id', 'newest snapshot offered');
  assert.equal(offer?.savedAt, '2026-03-02T14:02:00.000Z');
  assert.equal(offer?.name, 'B');
  assert.equal(getState().project.id, 'cur-id', 'the offer does not touch the open project');
  assert.equal(modals.length, before, 'no modal');
  await discardAutosave(offer);
  assert.equal(await kvGet('autosave_b-id'), undefined, 'Discard drops the offered snapshot');
  assert.ok(await kvGet('autosave_a-id'), 'other projects untouched');
  resetIdb();
});

await test('0.11: recover re-attaches stored images and leaves the project dirty', async () => {
  seedCurrentScene();
  resetIdb();
  const imgHash = await sha256Hex(new Uint8Array([4, 5, 6]).buffer);
  const doc = { ...goodDoc('Rec'), project: { name: 'Rec', id: 'rec-id', lastSavedAt: '2026-01-01T00:00:00.000Z' }, textureImages: [] };
  await kvSet('autosave_rec-id', { savedAt: '2026-03-01T00:00:00.000Z', doc });
  await kvSet(`autosaveimg_rec-id_${imgHash}`, { hash: imgHash, width: 1, height: 1, mimeType: 'image/png', fileData: 'BAUG' });
  const offer = await findRecoverableAutosave();
  assert.equal(offer?.projectId, 'rec-id');
  assert.equal(await PersistenceManager.recoverAutosave(offer), true, `recovered (errors: ${errors.join(' | ')})`);
  assert.equal(getState().project.id, 'rec-id');
  assert.equal(PersistenceManager.isDirty(), true, 'recovered work is unsaved');
  const { getTextureImage } = await import('../src/core/assets/TextureImageStore.js');
  assert.ok(getTextureImage(imgHash), 'stored image restored into the image store');
});

await test('M2: recoverAutosave with a poisoned doc → deletes the key, returns false, error surfaced', async () => {
  seedCurrentScene();
  await kvSet('autosave_Poison', { savedAt: '2026-01-01T00:00:00Z', doc: { version: '9.0', project: { name: 'Poison' } } });
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

await test('2.7: a legacy save with only sourceGroupId loads with shared logicalObjectId links', async () => {
  seedCurrentScene();
  const doc = goodDoc('Legacy');
  doc.sceneObjects = [
    { ...sceneObject('lead', 'a_ok'), sourceGroupId: 'sg1' },
    { ...sceneObject('part', 'a_ok'), sourceGroupId: 'sg1', isInternalPart: true },
  ];
  await __test._loadProject(doc);
  const objs = getState().scene.objects;
  assert.equal(objs.lead?.logicalObjectId, 'lead');
  assert.equal(objs.part?.logicalObjectId, 'lead', 'part linked to the lead');
  assert.equal(objs.part?.isInternalPart, true);
});

// ── Task 4.6: Source status values (card chip + Sources modal) ──
await test('4.6: load records Source status — embedded copy, missing link, ghost → embedded/missing/missing', async () => {
  seedCurrentScene();
  const { getAssetStatus } = await import('../src/core/persist/AssetResolver.js');
  const { sourceStatus, SOURCE_STATUSES } = await import('../src/ui/SourcesModal.js');
  assert.deepEqual([...SOURCE_STATUSES], ['embedded', 'linked', 'changed', 'missing']);
  const doc = goodDoc('Status');
  doc.assetLibrary.push(meshAsset('a_link', {
    fileData: GLB_B64, contentHash: GLB_HASH, fileHandleKey: 'file_gone_0000',
  }));
  doc.assetLibrary.push(meshAsset('a_ghost'));
  doc.sceneObjects.push(sceneObject('o_link', 'a_link'), sceneObject('o_ghost', 'a_ghost'));
  await __test._loadProject(doc);
  const lib = getState().scene.assetLibrary;
  assert.equal(getAssetStatus('a_ok'), 'embedded');
  assert.equal(sourceStatus(lib.a_ok), 'embedded', 'no link → Embedded copy');
  assert.equal(getAssetStatus('a_link'), 'missing', 'unreachable link falls back to the embedded bytes');
  assert.equal(sourceStatus(lib.a_link), 'missing');
  assert.equal(lib.a_ghost?.isGhost, true);
  assert.equal(sourceStatus(lib.a_ghost), 'missing', 'ghost (no bytes) reads Missing');
  // Never resolved this session (fresh import): link ⇒ Linked, none ⇒ Embedded copy.
  assert.equal(sourceStatus({ id: 'fresh1', source: { kind: 'file', refKey: 'k', path: 'x.glb', label: 'x.glb' } }), 'linked');
  assert.equal(sourceStatus({ id: 'fresh2' }), 'embedded');
});

// ── Task 4.1: schema 3.4 through the real load/save path ──

// savedAt is a wall-clock stamp; project.lastSavedAt is set FROM it on load.
function _stableDoc(doc) {
  const { savedAt, ...rest } = doc;
  const out = JSON.parse(JSON.stringify(rest));
  delete out.project.lastSavedAt;
  return out;
}

await test('4.1: 3.3 doc loads → saves as 3.4 with source/displayName; 3.4 round trip identical', async () => {
  seedCurrentScene();
  const doc = goodDoc('Schema');
  doc.project.id = 'pid-schema';
  doc.assetLibrary[0] = { ...doc.assetLibrary[0], directoryHandleKey: 'dir_Parts_1700000000000', originalPath: 'sub/a_ok.glb' };
  await __test._loadProject(doc);
  const lib = getState().scene.assetLibrary.a_ok;
  assert.deepEqual(lib.source, { kind: 'folder', refKey: 'dir_Parts_1700000000000', path: 'sub/a_ok.glb', label: 'Parts' });
  assert.equal(lib.displayName, 'a_ok.glb');
  AssetLoader.getAssetBytes = async () => GLB.buffer.slice(0);
  const saved = await __test._buildDocument({ skipTextureImages: true });
  assert.equal(saved.version, '3.5');
  assert.equal(saved.project.id, 'pid-schema');
  assert.deepEqual(saved.assetLibrary[0].source, lib.source);
  assert.equal(saved.assetLibrary[0].displayName, 'a_ok.glb');
  assert.equal(saved.assetLibrary[0].directoryHandleKey, 'dir_Parts_1700000000000', 'legacy key kept for one minor');
  // Re-open the 3.4 document and save again: identical apart from savedAt.
  await __test._loadProject(JSON.parse(JSON.stringify(saved)));
  const again = await __test._buildDocument({ skipTextureImages: true });
  assert.deepEqual(_stableDoc(again), _stableDoc(saved));
});

await test('PB.8: project.listings save -> load -> save is identical; old docs load with []', async () => {
  seedCurrentScene();
  AssetLoader.getAssetBytes = async () => GLB.buffer.slice(0);
  const doc = goodDoc('Listed');
  doc.project.id = 'pid-listed';
  doc.project.listings = [{ platform: 'cults3d', accountId: 'a1', title: 'T', status: 'published', remoteId: 'R1', price: 3, apiKey: 'LEAK', tags: ['x'] }];
  await __test._loadProject(doc);
  assert.equal(getState().project.listings.length, 1);
  const saved = await __test._buildDocument({ skipTextureImages: true });
  assert.equal(saved.project.listings[0].remoteId, 'R1');
  assert.equal(JSON.stringify(saved).includes('LEAK'), false, 'secret-like key never written');
  await __test._loadProject(JSON.parse(JSON.stringify(saved)));
  const again = await __test._buildDocument({ skipTextureImages: true });
  assert.deepEqual(_stableDoc(again), _stableDoc(saved));
  await __test._loadProject(goodDoc('NoListings'));
  assert.deepEqual(getState().project.listings, []);
});

await test('4.1: newer-minor unknown top-level keys round-trip; a later older-doc load drops them', async () => {
  seedCurrentScene();
  AssetLoader.getAssetBytes = async () => GLB.buffer.slice(0);
  await __test._loadProject({ ...goodDoc('Future'), version: '3.6', futureThing: { a: [1, 2] } });
  const saved = await __test._buildDocument({ skipTextureImages: true });
  assert.deepEqual(saved.futureThing, { a: [1, 2] }, 'unknown key written back');
  assert.equal(saved.version, '3.5');
  await __test._loadProject({ ...goodDoc('Plain'), futureThing: 'stale' });   // 3.3: noise, not preserved
  const plain = await __test._buildDocument({ skipTextureImages: true });
  assert.equal('futureThing' in plain, false);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
