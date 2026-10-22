// cia A-06: the heavy-mesh undo trim keeps every step that fits and never
// drops one without telling the user.
//   node --import ./tests/register-hooks.mjs --test tests/undo-trim-a06.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { HistoryManager: HM } = await import('../src/core/HistoryManager.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

let toasts = 0;
subscribe(EVENTS.TOAST, () => { toasts++; });

const light = label => ({ label, execute() {}, undo() {} });
const heavy = (label, tris) => ({ label, execute() {}, undo() {},
  retainedTriangles: side => (side === 'undo' ? tris : 0), release() {} });

function undoableSteps() {
  let n = 0;
  while (HM.getUndoLabel()) { n++; HM.undo(); }
  return n;
}

test('a newest step above the cap alone keeps all 25 lighter steps before it', () => {
  HM.clear(); HM.setRetainCap(1_000_000); toasts = 0;
  for (let i = 0; i < 25; i++) HM.push(light(`move ${i}`));
  HM.push(heavy('delete heavy', 2_500_000));
  assert.equal(undoableSteps(), 26, 'dropping triangle-free steps frees no memory');
  assert.equal(toasts, 0, 'nothing was dropped, so nothing to announce');
  HM.setRetainCap(null);
});

test('steps that must go to free memory are announced, and the steps after them stay', () => {
  HM.clear(); HM.setRetainCap(1_000_000); toasts = 0;
  HM.push(light('before'));
  HM.push(heavy('delete A', 800_000));
  for (let i = 0; i < 5; i++) HM.push(light(`move ${i}`));
  HM.push(heavy('delete B', 800_000));
  assert.equal(toasts, 1, 'the user is told older steps were cleared');
  assert.equal(undoableSteps(), 6, 'the five moves after delete A and delete B are still undoable');
  HM.setRetainCap(null);
});
