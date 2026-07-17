// Position-based dirty tracking (Blueprint §5 dirty contract, review A5).
// save → edit → undo must read CLEAN (back at saved position); undoing PAST
// the saved position must read DIRTY; non-history mutations stay sticky-dirty
// until the next save.
//   node --import ./tests/register-hooks.mjs tests/dirty-tracking.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { dispatch, setState, getState } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

PersistenceManager.init();

function cmd(label = 'noop') {
  return { label, execute() {}, undo() {} };
}
function markSaved() {
  // PROJECT_SAVED is the save/load/new baseline signal — the handler records
  // the current history position and clears the sticky flag.
  dispatch(EVENTS.PROJECT_SAVED, {});
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('getPosition: 0 when empty, advances per push, retraces on undo/redo', () => {
  HistoryManager.clear();
  assert.equal(HistoryManager.getPosition(), 0);
  HistoryManager.push(cmd());
  const p1 = HistoryManager.getPosition();
  assert.ok(p1 > 0, 'push assigns a serial');
  HistoryManager.push(cmd());
  const p2 = HistoryManager.getPosition();
  assert.ok(p2 > p1, 'serials are monotonic');
  HistoryManager.undo();
  assert.equal(HistoryManager.getPosition(), p1, 'undo retraces to prior position');
  HistoryManager.redo();
  assert.equal(HistoryManager.getPosition(), p2, 'redo restores position');
  HistoryManager.undo();
  HistoryManager.undo();
  assert.equal(HistoryManager.getPosition(), 0, 'undo to empty reads 0');
});

await test('save → edit → undo reads CLEAN; redo reads dirty again', () => {
  HistoryManager.clear();
  markSaved();
  assert.equal(PersistenceManager.isDirty(), false, 'clean at baseline');
  HistoryManager.push(cmd());
  assert.equal(PersistenceManager.isDirty(), true, 'dirty after push');
  HistoryManager.undo();
  assert.equal(PersistenceManager.isDirty(), false, 'undo back to saved position → clean');
  HistoryManager.redo();
  assert.equal(PersistenceManager.isDirty(), true, 'redo away from saved position → dirty');
});

await test('edit → save → undo PAST the save reads DIRTY', () => {
  HistoryManager.clear();
  markSaved();
  HistoryManager.push(cmd());
  markSaved();                                  // saved at position p1
  assert.equal(PersistenceManager.isDirty(), false);
  HistoryManager.undo();                        // now BEFORE the saved state
  assert.equal(PersistenceManager.isDirty(), true,
    'state differs from disk even though we only undid');
  HistoryManager.redo();
  assert.equal(PersistenceManager.isDirty(), false, 'redo back to saved → clean');
});

await test('non-history mutation is sticky: undo does not clean it', () => {
  HistoryManager.clear();
  markSaved();
  dispatch(EVENTS.PROJECT_DIRTY, {});           // e.g. bed-dims setState (no command)
  assert.equal(PersistenceManager.isDirty(), true, 'sticky dirty');
  HistoryManager.push(cmd());
  HistoryManager.undo();
  assert.equal(PersistenceManager.isDirty(), true,
    'position is back at saved but the sticky mutation is not undoable');
  markSaved();
  assert.equal(PersistenceManager.isDirty(), false, 'save clears sticky');
});

await test('scene.renderOut edit dirties (project-persisted slice, Stage 7 fix)', () => {
  // Blueprint §5 rule: slices persisted only in .mixo MUST dirty. renderOut
  // (incl. pose) is written to the .mixo by ProjectSerializer, so an edit
  // through ScenePanel._setRenderOut has to fire PROJECT_DIRTY — the old
  // SILENT flag silently discarded the composition change on save-prompt.
  HistoryManager.clear();
  markSaved();
  const before = getState().scene.renderOut ?? {};
  setState(s => ({
    ...s,
    scene: { ...s.scene, renderOut: { ...(s.scene.renderOut ?? {}), width: (before.width ?? 1920) + 1 } },
  }));   // NO { silent: true } — must dirty
  assert.equal(PersistenceManager.isDirty(), true,
    'renderOut edit fires PROJECT_DIRTY (sticky against undo since not command-driven)');
  markSaved();
  assert.equal(PersistenceManager.isDirty(), false, 'save clears');
});

await test('command-driven PROJECT_DIRTY is NOT sticky (covered by position)', () => {
  HistoryManager.clear();
  markSaved();
  // Real commands call markDirty() inside execute(); push() wraps execute in
  // the isApplying() window, so the dirty event must not set the sticky flag.
  HistoryManager.push({ label: 'mut', execute() { dispatch(EVENTS.PROJECT_DIRTY, {}); }, undo() {} });
  assert.equal(PersistenceManager.isDirty(), true, 'dirty after command');
  HistoryManager.undo();
  assert.equal(PersistenceManager.isDirty(), false,
    'undo cleans command-driven dirty — it must not have stuck');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
