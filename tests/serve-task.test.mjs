import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveTask, transferable } from '../src/core/workers/serveTask.js';

function scope() {
  const posts = [];
  return { posts, postMessage(data, transfer) { posts.push({ data, transfer }); } };
}
const send = (s, data) => s.onmessage({ data });
const settle = () => new Promise(r => setImmediate(r));

test('replies done with the result and echoes the revision', async () => {
  const s = scope();
  serveTask((p) => p.x + 1, s);
  send(s, { id: 3, type: 'run', payload: { x: 1 }, revision: 7 });
  await settle();
  assert.deepEqual(s.posts[0].data, { id: 3, type: 'done', result: 2, revision: 7 });
});

test('progress messages carry the job id', async () => {
  const s = scope();
  serveTask((p, { progress }) => { progress({ completed: 1, total: 2 }); return 'ok'; }, s);
  send(s, { id: 1, type: 'run', payload: {} });
  await settle();
  assert.deepEqual(s.posts[0].data, { completed: 1, total: 2, id: 1, type: 'progress' });
  assert.equal(s.posts[1].data.type, 'done');
});

test('thrown errors become error replies', async () => {
  const s = scope();
  serveTask(() => { throw new Error('bad input'); }, s);
  send(s, { id: 2, type: 'run', payload: {} });
  await settle();
  assert.deepEqual(s.posts[0].data, { id: 2, type: 'error', message: 'bad input' });
});

test('transferable() results pass their transfer list', async () => {
  const s = scope();
  const buf = new ArrayBuffer(4);
  serveTask(() => transferable({ buf }, [buf]), s);
  send(s, { id: 5, type: 'run', payload: {} });
  await settle();
  assert.deepEqual(s.posts[0].transfer, [buf]);
  assert.equal(s.posts[0].data.result.buf, buf);
});

test('non-run messages are ignored', async () => {
  const s = scope();
  serveTask(() => 1, s);
  send(s, null); send(s, { type: 'other' });
  await settle();
  assert.equal(s.posts.length, 0);
});
