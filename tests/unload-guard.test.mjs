// shouldGuardUnload predicate (task 0.4).
//   node --import ./tests/register-hooks.mjs --test tests/unload-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldGuardUnload } from '../src/core/UnloadGuard.js';

test('clean project never guards', () => {
  assert.equal(shouldGuardUnload({ isElectron: true, dirty: false }), false);
  assert.equal(shouldGuardUnload({ isElectron: false, dirty: false }), false);
});
test('dirty guards on web and electron', () => {
  assert.equal(shouldGuardUnload({ isElectron: true, dirty: true }), true);
  assert.equal(shouldGuardUnload({ isElectron: false, dirty: true }), true);
});
test('smoke bypasses outside production only', () => {
  assert.equal(shouldGuardUnload({ dirty: true, smoke: true, isProd: false }), false);
  assert.equal(shouldGuardUnload({ dirty: true, smoke: true, isProd: true }), true);
});
