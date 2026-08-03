// Save-abort safety (review H9): a cancelled save picker during the
// "Save & New / Save & Open" dirty flow must ABORT the flow — the old code
// returned silently from saveAs and then reset the world, discarding the
// project the user explicitly asked to save.
//   node --import ./tests/register-hooks.mjs tests/persistence-abort.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager, __test } = await import('../src/core/PersistenceManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { setState, getState, dispatch, subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

// No live camera headless — the save path serialises camera state.
SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});

PersistenceManager.init();

// Dirty-confirm modal auto-responder — the flow under test dispatches
// MODAL_OPEN and awaits onClose.
let modalChoice = 'save';
subscribe(EVENTS.MODAL_OPEN, (p) => {
  if (p?.id === 'dirtyConfirm') p.onClose?.(modalChoice);
});

function cancelPicker() {
  globalThis.window.showSaveFilePicker = async () => {
    const e = new Error('user cancelled');
    e.name = 'AbortError';
    throw e;
  };
}
function acceptPicker() {
  globalThis.window.showSaveFilePicker = async () => ({
    name: 'Test.mixo',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  });
}

function seedWorld() {
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { keep: {
      id: 'keep', name: 'keep', assetId: 'a1', parentId: null, shaderId: null,
      visible: true, locked: false, isGhost: false, isPrintPart: true,
      collectionId: null, sourceGroupId: null,
    } } },
  }), { silent: true });
  dispatch(EVENTS.PROJECT_DIRTY, {});   // sticky dirty, like a real edit
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

// NOTE on ordering: a successful saveAs sets the module-private _fileHandle,
// after which save() bypasses the picker. All cancel-path tests therefore run
// BEFORE the single accepted-picker test at the end.

await test('saveAs: cancelled picker → returns false', async () => {
  cancelPicker();
  assert.equal(await PersistenceManager.saveAs(), false);
});

await test('newProject: dirty + "Save" + cancelled picker → flow ABORTS, world intact', async () => {
  cancelPicker();
  seedWorld();
  modalChoice = 'save';
  await PersistenceManager.newProject();
  assert.ok(getState().scene.objects.keep,
    'cancelled save during Save&New must NOT reset the world (H9 regression)');
});

await test('newProject: dirty + "Cancel" → flow aborts, world intact', async () => {
  seedWorld();
  modalChoice = 'cancel';
  await PersistenceManager.newProject();
  assert.ok(getState().scene.objects.keep, 'cancel must keep the world');
});

await test('close flow returns the shared cancel action', async () => {
  seedWorld();
  modalChoice = 'cancel';
  assert.deepEqual(await PersistenceManager.requestClose(), { action: 'cancel' });
});

await test('close flow never approves a failed or cancelled save', async () => {
  cancelPicker();
  seedWorld();
  modalChoice = 'save';
  assert.deepEqual(await PersistenceManager.requestClose(), { action: 'save', saved: false });
});

await test('close flow returns the shared discard action', async () => {
  seedWorld();
  modalChoice = 'discard';
  assert.deepEqual(await PersistenceManager.requestClose(), { action: 'discard' });
});

await test('saveAs → save: accepted picker → returns true', async () => {
  acceptPicker();
  assert.equal(await PersistenceManager.saveAs(), true);
});

await test('A9/M7: autosave skips embedding for handle-backed assets, embeds handle-less loose drops', async () => {
  const { AssetLoader } = await import('../src/core/AssetLoader.js');
  AssetLoader.getAssetBytes = async () => new Uint8Array([1, 2, 3, 4]).buffer;
  AssetLoader.getBabylonMesh = () => null;
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: {
      // Handle-backed: recovery can re-read the live file, so autosave skips bytes.
      a1: {
        id: 'a1', name: 'A', filename: 'a.glb', extension: '.glb', kind: 'mesh',
        sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1,
        directoryHandleKey: null, fileHandleKey: 'fh:a', contentHash: 'cafe01',
      },
      // Loose drag-drop: NO handle, embedded bytes are the only recovery tier.
      a2: {
        id: 'a2', name: 'B', filename: 'b.glb', extension: '.glb', kind: 'mesh',
        sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1,
        directoryHandleKey: null, fileHandleKey: null, contentHash: 'cafe02',
      },
    } },
  }), { silent: true });

  const full = await __test._buildDocument();
  const fById = Object.fromEntries(full.assetLibrary.map(a => [a.id, a]));
  assert.ok(fById.a1.fileData, 'explicit save embeds handle-backed asset');
  assert.ok(fById.a2.fileData, 'explicit save embeds loose-drop asset');
  assert.equal(fById.a1.contentHash, 'cafe01', 'cached hash reused');

  const auto = await __test._buildDocument({ skipEmbed: true });
  const aById = Object.fromEntries(auto.assetLibrary.map(a => [a.id, a]));
  assert.equal(aById.a1.fileData, null,
    'autosave must not re-encode a handle-backed asset every 60s (A9)');
  assert.equal(aById.a1.contentHash, 'cafe01',
    'hash kept so tier-2 relink still works on recovery');
  assert.ok(aById.a2.fileData,
    'autosave MUST embed a handle-less loose drop or recovery ghosts it (M7)');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
