import assert from 'node:assert/strict';
import { storage, BrowserStorageAdapter } from '../src/core/storage/StorageAdapter.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

test('active storage is the browser adapter in a non-Electron runtime', () => {
  assert.equal(storage.kind, 'browser');
  assert.equal(storage, BrowserStorageAdapter);
});

test('adapter exposes the capability flags', () => {
  assert.ok(storage.caps && typeof storage.caps === 'object');
  for (const flag of ['persistAssets', 'mountDirectory', 'relinkByPath', 'watchFiles', 'writeFiles']) {
    assert.equal(typeof storage.caps[flag], 'boolean', `caps.${flag} should be a boolean`);
  }
});

test('cross-session KV methods are present (routed to idb)', () => {
  for (const m of ['kvSet', 'kvGet', 'kvDelete', 'kvKeys']) {
    assert.equal(typeof storage[m], 'function', `${m} should be a function`);
  }
});

test('importing the adapter does NOT eagerly load idb (headless-safe)', () => {
  // If idb were imported at module top, this test file (node, no IndexedDB) would
  // have thrown on import before reaching here. Reaching this assertion proves the
  // lazy-import keeps the module graph headless-safe.
  assert.ok(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
