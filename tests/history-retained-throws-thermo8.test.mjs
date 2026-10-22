// thermo #8: a history entry whose retained size cannot be read must not count
// as holding nothing, or its meshes stay pinned for the whole session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const HM = await import('../src/core/HistoryManager.js');

function cmd(label, retained) {
  const c = { label, released: [], execute() {}, undo() {} };
  c.retainedTriangles = retained;
  c.release = (s) => c.released.push(s);
  return c;
}

test('an entry whose retainedTriangles throws is released once it is no longer the newest', (t) => {
  const error = console.error;
  t.after(() => { console.error = error; HM.setRetainCap(null); HM.clear(); });
  console.error = () => {};
  HM.clear(); HM.setRetainCap(1_000);
  const older = cmd('older', () => 10);
  const broken = cmd('broken', () => { throw new Error('mesh gone'); });
  HM.push(older);
  HM.push(broken);
  assert.deepEqual(broken.released, [], 'the newest entry stays undoable');
  const next = cmd('next', () => 0);
  HM.push(next);
  assert.deepEqual(broken.released, ['undo'], 'its meshes are freed instead of pinned');
  assert.deepEqual(older.released, ['undo'], 'steps older than a released one go with it');
  assert.deepEqual(next.released, []);
  assert.equal(HM.getUndoLabel(), 'next');
});
