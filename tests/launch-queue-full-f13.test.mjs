// cia F-13: a launch request that arrives while 16 are already waiting is not opened, and
// the user is told so in the next batch the window receives.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLaunchQueue } = require('../electron/LaunchQueue.cjs');

const batch = (id, name) => ({ id, items: [{ kind: 'import', ref: `r-${name}`, name }], library: null, errors: [] });

test('a dropped launch request is reported in the pulled batch', () => {
  const q = createLaunchQueue({ maxPending: 2 });
  q.enqueue(batch('1', 'a.stl'));
  q.enqueue(batch('2', 'b.stl'));
  q.enqueue(batch('3', 'c.stl'));
  q.enqueue(batch('4', 'd.stl'));
  const pulled = q.pull();
  assert.deepEqual(pulled.items.map(i => i.name), ['a.stl', 'b.stl']);
  assert.equal(pulled.errors.length, 1, 'one error entry tells the user requests were not opened');
  assert.match(pulled.errors[0].reason, /\b2\b/);
});

test('after the report, the count starts over', () => {
  const q = createLaunchQueue({ maxPending: 1 });
  q.enqueue(batch('1', 'a.stl'));
  q.enqueue(batch('2', 'b.stl'));
  q.pull();
  q.reset();
  q.enqueue(batch('3', 'c.stl'));
  assert.deepEqual(q.pull().errors, []);
});
