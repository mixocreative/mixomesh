/*
 * MX-02 debt, built: the boot banner offers a salvaged snapshot back.
 *
 *   node --import ./tests/register-hooks.mjs --test tests/autosave-salvage-offer-mx02.test.mjs
 *
 * MX-02 stopped the app destroying the user's only unsaved copy when a recovery threw: the
 * snapshot moves to `autosavefailed_<projectId>` instead of being deleted. That kept the bytes
 * and left them reachable only with a debugger, which the audit recorded as open debt. This is
 * the other half — the click that reaches them.
 *
 * What the banner must get right, and what each test here pins:
 *   - a LIVE snapshot still wins. The salvage offer is the fallback, never the first thing shown.
 *   - it is said as what it is: a recovery that FAILED, not a normal autosave. Promising a load
 *     that is already known to have thrown once is how a user loses the afternoon twice.
 *   - it comes with a Discard, because a snapshot this build cannot read needs a way out that is
 *     not "try forever" — and that Discard asks first, since it is the one path in the app
 *     allowed to destroy unsaved work.
 *
 * The DOM is the same minimal fake tests/autosave-unreadable-b03.test.mjs uses on this banner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

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

let confirmed = true;
const confirmCalls = [];
globalThis.window = { ...globalThis.window, confirm: (msg) => { confirmCalls.push(String(msg)); return confirmed; } };

const { BootBanner } = await import('../src/ui/BootBanner.js');
const { AssetPanel } = await import('../src/ui/AssetPanel.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');
const { autosaveKey, failedAutosaveKey } = await import('../src/core/persist/AutosaveKeys.js');

AssetPanel.findRemountOffer = async () => null;

const kv = new Map();
storage.kvKeys = async () => [...kv.keys()];
storage.kvGet = async k => kv.get(k);
storage.kvSet = async (k, v) => { kv.set(k, v); };
storage.kvDelete = async k => { kv.delete(k); };

const SNAPSHOT = {
  savedAt: '2026-11-12T10:00:00.000Z',
  name: 'two hours of work',
  doc: { version: '99.0', project: { id: 'p1', name: 'two hours of work', lastSavedAt: null } },
};
const IMAGE_KEY = 'autosaveimg_p1_abc';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const click = (act) => banner.handlers.click({ target: { closest: () => ({ dataset: { act } }) } });

function seedSalvaged() {
  // The banner keeps its element in module state and only creates one when it has none, so a
  // test that does not drop it never sees a fresh `banner` and reads the previous test's markup.
  BootBanner.hide();
  kv.clear();
  confirmCalls.length = 0;
  confirmed = true;
  banner = null;
  kv.set(failedAutosaveKey('p1'), SNAPSHOT);
  kv.set(IMAGE_KEY, { hash: 'abc', fileData: 'AA==' });
}

test('with only a salvaged snapshot, the banner offers it — and says the recovery failed', async () => {
  seedSalvaged();
  await BootBanner.runBootChecks();
  assert.ok(banner, 'a banner is shown: the bytes exist, so the user must be told');
  assert.match(banner.innerHTML, /data-bb="salvage"/, 'marked as a salvage offer, not a normal one');
  assert.doesNotMatch(banner.innerHTML, /data-bb="recover"/, 'and never dressed up as a normal autosave');
  assert.match(banner.innerHTML, /two hours of work/, 'it names the project');
  assert.match(banner.innerHTML, /data-act="recover"/, 'with a retry');
  assert.match(banner.innerHTML, /data-act="discard"/, 'and a way out');
  // A failed load is not the confident action on the strip.
  assert.doesNotMatch(banner.innerHTML, /btn-primary/, 'retrying a known failure is not the primary action');
});

test('a live snapshot wins: the salvage offer is the fallback, never the first thing shown', async () => {
  seedSalvaged();
  kv.set(autosaveKey('p2'), { ...SNAPSHOT, name: 'the newer one', doc: { ...SNAPSHOT.doc, project: { id: 'p2', name: 'the newer one', lastSavedAt: null } } });
  await BootBanner.runBootChecks();
  assert.match(banner.innerHTML, /data-bb="recover"/, 'the live snapshot is the offer');
  assert.doesNotMatch(banner.innerHTML, /data-bb="salvage"/);
  assert.match(banner.innerHTML, /the newer one/);
});

test('nothing kept and nothing live: no banner at all', async () => {
  kv.clear();
  banner = null;
  await BootBanner.runBootChecks();
  assert.equal(banner, null, 'an empty store must not produce a banner');
});

test('Discard asks first, naming the snapshot, and a No keeps the bytes', async () => {
  seedSalvaged();
  await BootBanner.runBootChecks();
  confirmed = false;
  click('discard');
  await tick();
  assert.equal(confirmCalls.length, 1, 'the one destructive path in the banner must ask');
  assert.match(confirmCalls[0], /two hours of work/, 'and name what goes');
  assert.match(confirmCalls[0], /cannot be undone/i);
  assert.ok(kv.has(failedAutosaveKey('p1')), 'a No keeps the snapshot');
  assert.ok(kv.has(IMAGE_KEY), 'and its images');
});

test('a confirmed Discard clears the snapshot, its images, and the offer', async () => {
  seedSalvaged();
  await BootBanner.runBootChecks();
  confirmed = true;
  click('discard');
  await tick();
  assert.equal(kv.has(failedAutosaveKey('p1')), false, 'the snapshot goes');
  assert.equal(kv.has(IMAGE_KEY), false, 'and the images with it — nothing references them now');
  assert.equal(banner, null, 'and the banner leaves, since there is nothing left to offer');
});
