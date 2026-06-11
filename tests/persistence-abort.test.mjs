// Save-abort safety (review H9): a cancelled save picker during the
// "Save & New / Save & Open" dirty flow must ABORT the flow — the old code
// returned silently from saveAs and then reset the world, discarding the
// project the user explicitly asked to save.
//   node --import ./tests/register-hooks.mjs tests/persistence-abort.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
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

await test('saveAs → save: accepted picker → returns true', async () => {
  acceptPicker();
  assert.equal(await PersistenceManager.saveAs(), true);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
