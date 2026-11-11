// cia MX-02: a failed recovery must not destroy the user's only unsaved copy.
// The old catch called deleteAutosave() on ANY throw out of loadProject — a
// heavy-scene OOM, a worker crash, a schema from a newer build — so the one
// remedy the user had was spent by trying it once.
//   node --import ./tests/register-hooks.mjs --test tests/autosave-recover-keeps-snapshot-mx02.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const { recoverAutosave, findRecoverableAutosave, findFailedAutosave, discardAutosave } = await import('../src/core/persist/Autosave.js');
const { autosaveKey, failedAutosaveKey } = await import('../src/core/persist/AutosaveKeys.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { Toast } = await import('../src/ui/Toast.js');

const toasts = [];
Toast.show = (msg) => { toasts.push(String(msg)); };

const kv = new Map();
storage.kvGet = async k => kv.get(k);
storage.kvSet = async (k, v) => { kv.set(k, v); };
storage.kvKeys = async () => [...kv.keys()];
storage.kvDelete = async k => { kv.delete(k); };

// A snapshot this build cannot read: validateDocument rejects a newer major
// version, so loadProject throws before it touches the world. Exactly the
// "schema from another build" case the deleted code named — and the case where
// the bytes are worth MORE than the running build, not less.
const SNAPSHOT = {
  savedAt: '2026-11-12T10:00:00.000Z',
  name: 'two hours of work',
  doc: { version: '99.0', project: { id: 'p1', name: 'two hours of work' } },
};
const IMAGE_KEY = 'autosaveimg_p1_abc';

function seed() {
  kv.clear();
  toasts.length = 0;
  kv.set(autosaveKey('p1'), SNAPSHOT);
  kv.set(IMAGE_KEY, { hash: 'abc', fileData: 'AA==' });
}

test('a failed recovery keeps the snapshot and its texture images', async () => {
  seed();
  assert.equal(await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' }), false);
  const kept = await storage.kvGet(failedAutosaveKey('p1'));
  assert.deepEqual(kept, SNAPSHOT, 'the bytes survive under the failed-recovery key');
  assert.ok(kv.has(IMAGE_KEY), 'its texture images survive too — a snapshot without them is not recoverable');
});

test('the kept snapshot is not re-offered on the next boot (no recovery loop)', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  assert.equal(kv.has(autosaveKey('p1')), false, 'the live key is gone, so the banner stops offering it');
  assert.equal(await findRecoverableAutosave(), null, 'and the boot scan does not see the failed one');
});

test('the failure toast says the snapshot was kept', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  assert.equal(toasts.length, 1, `one failure toast, got: ${JSON.stringify(toasts)}`);
  assert.match(toasts[0], /snapshot was kept/, `the toast must say the bytes survive: ${toasts[0]}`);
  assert.doesNotMatch(toasts[0], /discarded/, `and must not claim they were thrown away: ${toasts[0]}`);
});

test('a second failed recovery of the same project does not lose the first kept copy', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  kv.set(autosaveKey('p1'), SNAPSHOT);   // a later tick wrote a fresh snapshot
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  assert.deepEqual(await storage.kvGet(failedAutosaveKey('p1')), SNAPSHOT);
});

// ── MX-02 debt, built: the kept snapshot is OFFERED back ─────────────────────
//
// Keeping the bytes was half the fix. Until the UI offers them, "recoverable" means "recoverable
// by someone with a debugger", which is not recoverable. The offer reuses the boot banner rather
// than growing a Project-menu entry: the banner is already where the user looks after a crash,
// and it already owns the dirty-check, the folder re-mount and the recover gesture.
//
// It is presented as what it is — a snapshot whose last recovery FAILED — never as a normal
// autosave. Two differences carry that: the offer is marked `failed`, and it comes with its own
// Discard, because a snapshot that cannot be loaded needs a way out that is not "try forever".

test('a kept snapshot is found as a salvage offer, marked as one', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  const offer = await findFailedAutosave();
  assert.ok(offer, 'the salvaged snapshot must be findable, or the bytes are only a debugger away');
  assert.equal(offer.failed, true, 'it is marked a failed recovery, never shown as a normal autosave');
  assert.equal(offer.projectId, 'p1');
  assert.equal(offer.key, failedAutosaveKey('p1'));
  assert.equal(offer.savedAt, SNAPSHOT.savedAt);
  assert.equal(offer.name, SNAPSHOT.name);
});

test('no kept snapshot, no salvage offer', async () => {
  seed();
  assert.equal(await findFailedAutosave(), null, 'a live snapshot is the normal offer, not a salvage one');
  kv.clear();
  assert.equal(await findFailedAutosave(), null);
});

test('an unreadable store is reported, never mistaken for "nothing kept" (B-03)', async () => {
  seed();
  const real = storage.kvKeys;
  storage.kvKeys = async () => { throw new Error('IndexedDB blocked'); };
  try {
    const offer = await findFailedAutosave();
    assert.ok(offer?.unreadable, `blind must not read as clean, got ${JSON.stringify(offer)}`);
  } finally { storage.kvKeys = real; }
});

test('retrying a salvage offer loads the SAME bytes, and keeps them when it fails again', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  const offer = await findFailedAutosave();
  assert.equal(await recoverAutosave(offer), false, 'this snapshot still cannot be read by this build');
  assert.deepEqual(await storage.kvGet(failedAutosaveKey('p1')), SNAPSHOT, 'and the bytes are still there to try again');
  assert.ok(kv.has(IMAGE_KEY), 'with their images');
});

test('discarding a salvage offer is the one thing that clears it, images and all', async () => {
  seed();
  await recoverAutosave({ key: autosaveKey('p1'), projectId: 'p1' });
  await discardAutosave(await findFailedAutosave());
  assert.equal(await storage.kvGet(failedAutosaveKey('p1')), undefined);
  assert.equal(kv.has(IMAGE_KEY), false, 'the images go with it — nothing references them any more');
  assert.equal(await findFailedAutosave(), null);
});
