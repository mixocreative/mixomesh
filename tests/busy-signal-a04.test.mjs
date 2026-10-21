// cia A-04 / A-08 / F-06: an Explorer double-click or an automation request
// waits while the user's own save, export, repair, boolean, unsaved-changes
// dialog or File > Open is in flight. They all report to one signal, the one
// LaunchRequests and the API dispatcher poll.
//   node --import ./tests/register-hooks.mjs --test tests/busy-signal-a04.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { isBusy } = await import('../src/core/BusyRegistry.js');
const { runExclusiveSave, confirmDirty } = await import('../src/core/persist/DirtyTracker.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { exportOBJ } = await import('../src/core/print/PrintPipeline.js');
const { repairObjects } = await import('../src/core/repair/RepairSession.js');
const { computeBooleanAsync } = await import('../src/core/BooleanService.js');
const { Toast } = await import('../src/ui/Toast.js');
Toast.show = () => {};

const parked = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const tick = () => new Promise(r => setTimeout(r, 0));

test('a save is busy from start to settle, also when it fails', async () => {
  const gate = parked();
  const run = runExclusiveSave(() => gate.p.then(() => { throw new Error('disk full'); }));
  assert.equal(isBusy(), true, 'busy while the save writes');
  gate.release();
  await assert.rejects(run, /disk full/);
  await tick();
  assert.equal(isBusy(), false, 'idle again after a failed save');
});

test('the unsaved-changes dialog is busy until the user answers', async () => {
  let payload;
  const off = subscribe(EVENTS.MODAL_OPEN, p => { if (p?.id === 'dirtyConfirm') payload = p; });
  const answer = confirmDirty();
  assert.equal(isBusy(), true, 'busy while the dialog is open');
  payload.onClose('discard');
  assert.equal(await answer, 'discard');
  assert.equal(isBusy(), false);
  off?.();
});

test('File > Open is busy while its picker is up', async () => {
  const gate = parked();
  window.showOpenFilePicker = () => gate.p.then(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  const opening = PersistenceManager.open().catch(() => {});
  await tick();
  assert.equal(isBusy(), true, 'an API import must not land under the open the user is choosing');
  gate.release();
  await opening;
  assert.equal(isBusy(), false);
});

test('export, repair and boolean are busy while they run', async () => {
  const seen = {};
  await exportOBJ({ get selectedOnly() { seen.export = isBusy(); return false; } }).catch(() => {});
  await repairObjects([], { onProgress() {} });
  await repairObjects(['missing'], { onProgress() { seen.repair = isBusy(); } });
  await computeBooleanAsync('union', [{}, {}], { signal: { get aborted() { seen.boolean = isBusy(); return true; } } }).catch(() => {});
  assert.deepEqual(seen, { export: true, repair: true, boolean: true });
  assert.equal(isBusy(), false, 'every one ends, success or failure');
});
