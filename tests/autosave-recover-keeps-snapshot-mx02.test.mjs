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

const { recoverAutosave, findRecoverableAutosave } = await import('../src/core/persist/Autosave.js');
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
