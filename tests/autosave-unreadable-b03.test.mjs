// cia B-03: "could not read the autosave store" is not "nothing to recover".
// After a crash with a blocked IndexedDB the boot banner must say the check
// failed and offer Retry, instead of the same clean screen as no unsaved work.
//   node --import ./tests/register-hooks.mjs --test tests/autosave-unreadable-b03.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

// Minimal DOM for the banner: one element whose markup and click handler we can reach.
let banner = null;
const classes = new Set();
const fakeEl = () => {
  const el = {
    id: '', className: '', innerHTML: '', attrs: {}, handlers: {},
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener(type, fn) { el.handlers[type] = fn; },
    remove() { banner = null; },
  };
  return el;
};
globalThis.document = {
  ...globalThis.document,
  createElement: () => { banner = fakeEl(); return banner; },
  getElementById: () => null,
  body: { prepend() {}, classList: { add: c => classes.add(c), remove: c => classes.delete(c) } },
};

const { findRecoverableAutosave, recoverAutosave } = await import('../src/core/persist/Autosave.js');
const { BootBanner } = await import('../src/ui/BootBanner.js');
const { AssetPanel } = await import('../src/ui/AssetPanel.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');

AssetPanel.findRemountOffer = async () => null;
const kv = new Map();
let storeBroken = true;
storage.kvKeys = async () => { if (storeBroken) throw new Error('IndexedDB is blocked'); return [...kv.keys()]; };
storage.kvGet = async k => { if (storeBroken) throw new Error('IndexedDB is blocked'); return kv.get(k); };
storage.kvDelete = async k => { kv.delete(k); };

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const click = (act) => banner.handlers.click({ target: { closest: () => ({ dataset: { act } }) } });

test('an unreadable store is reported as such, not as "nothing to recover"', async () => {
  const result = await findRecoverableAutosave();
  assert.ok(result && result.unreadable instanceof Error, 'the lookup returns the fault, distinct from null');
  assert.match(result.unreadable.message, /IndexedDB is blocked/);
});

test('recoverAutosave without an offer propagates the fault instead of returning false', async () => {
  await assert.rejects(recoverAutosave(), /IndexedDB is blocked/);
});

test('the boot banner says the check failed and Retry re-runs it', async () => {
  kv.set('autosave_p1', { savedAt: '2026-10-22T04:07:00.000Z', name: 'walk-ladder', doc: { project: { id: 'p1', lastSavedAt: null } } });
  await BootBanner.runBootChecks();
  assert.ok(banner, 'a banner is shown');
  assert.match(banner.innerHTML, /boot\.recoverUnreadable|Could not check/, 'it names the failed check');
  assert.match(banner.innerHTML, /data-act="retry"/, 'with a Retry action');
  assert.doesNotMatch(banner.innerHTML, /data-act="recover"/, 'no recover offer is faked');

  storeBroken = false;
  click('retry');
  await tick(30);
  assert.match(banner.innerHTML, /data-act="recover"/, 'after Retry the real offer appears');
  assert.match(banner.innerHTML, /walk-ladder/, 'for the project the store holds');
  assert.doesNotMatch(banner.innerHTML, /data-act="retry"/);
});
