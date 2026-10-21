// cia W-14: there is ONE dirty flag. `state.project.isDirty` was a dead field
// that never changed, so any reader (API, plugin, a future panel) got the
// wrong answer while the title showed the dirty dot. The state shape must not
// carry it; PersistenceManager.isDirty() is the truth.
//   node --import ./tests/register-hooks.mjs --test tests/dirty-single-truth-w14.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { getState, freshState, markDirty } = await import('../src/core/StateManager.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
PersistenceManager.init();

test('the state shape carries no dirty field that could disagree with the tracker', () => {
  assert.equal('isDirty' in getState().project, false, 'live state');
  assert.equal('isDirty' in freshState().project, false, 'fresh state');
});

test('the one dirty truth answers after a non-undoable change', () => {
  markDirty();
  assert.equal(PersistenceManager.isDirty(), true);
  assert.equal(getState().project.isDirty, undefined, 'nothing else to consult');
});
