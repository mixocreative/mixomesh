import assert from 'node:assert/strict';
import { test } from 'node:test';

const { WorkerTask } = await import('../src/core/workers/WorkerTask.js');

/** Fake Worker: records posts; tests answer with reply()/crash(). */
class FakeWorker {
  static all = [];
  constructor() { this.posts = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(data, transfer) { this.posts.push({ data, transfer }); }
  terminate() { this.terminated = true; }
  reply(msg) { this.onmessage?.({ data: msg }); }
  crash(message = 'boom') { this.onerror?.({ message }); }
  get last() { return this.posts.at(-1)?.data; }
}
const fresh = () => { FakeWorker.all = []; return () => new FakeWorker(); };
const tick = () => new Promise(r => setImmediate(r));

test('done resolves with the result and passes the transfer list', async () => {
  const task = new WorkerTask({ create: fresh() });
  const buf = new ArrayBuffer(8);
  const p = task.run({ a: 1 }, { transfer: [buf] });
  const w = FakeWorker.all[0];
  assert.deepEqual(w.posts[0].transfer, [buf]);
  assert.equal(w.last.type, 'run');
  assert.deepEqual(w.last.payload, { a: 1 });
  w.reply({ id: w.last.id, type: 'done', result: 42 });
  assert.equal(await p, 42);
});

test('progress is forwarded to onProgress', async () => {
  const task = new WorkerTask({ create: fresh() });
  const seen = [];
  const p = task.run({}, { onProgress: e => seen.push(e) });
  const w = FakeWorker.all[0];
  w.reply({ id: w.last.id, type: 'progress', completed: 1, total: 2 });
  w.reply({ id: w.last.id, type: 'done', result: 'ok' });
  await p;
  assert.deepEqual(seen, [{ completed: 1, total: 2 }]);
});

test('error reply rejects with its message', async () => {
  const task = new WorkerTask({ create: fresh() });
  const p = task.run({});
  const w = FakeWorker.all[0];
  w.reply({ id: w.last.id, type: 'error', message: 'nope' });
  await assert.rejects(p, /nope/);
});

test('abort rejects AbortError and a late done is ignored', async () => {
  const task = new WorkerTask({ create: fresh() });
  const ac = new AbortController();
  const p = task.run({}, { signal: ac.signal });
  const w = FakeWorker.all[0];
  const id = w.last.id;
  ac.abort();
  await assert.rejects(p, e => e.name === 'AbortError');
  w.reply({ id, type: 'done', result: 1 }); // must not throw or resolve anything
});

test('an already-aborted signal rejects without posting', async () => {
  const task = new WorkerTask({ create: fresh() });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(task.run({}, { signal: ac.signal }), e => e.name === 'AbortError');
  assert.equal(FakeWorker.all.length, 0);
});

test('timeout terminates the worker; other jobs reject restarted; next run gets a new worker', async () => {
  const task = new WorkerTask({ create: fresh(), timeoutMs: 20 });
  const slow = task.run({ n: 1 });
  const other = task.run({ n: 2 }, { timeoutMs: 10_000 });
  await assert.rejects(slow, e => e.code === 'timeout');
  await assert.rejects(other, e => e.code === 'restarted');
  assert.equal(FakeWorker.all[0].terminated, true);
  const next = task.run({ n: 3 });
  assert.equal(FakeWorker.all.length, 2);
  const w = FakeWorker.all[1];
  w.reply({ id: w.last.id, type: 'done', result: 3 });
  assert.equal(await next, 3);
});

test('worker crash rejects every in-flight job and recreates on next run', async () => {
  const task = new WorkerTask({ create: fresh() });
  const a = task.run({}); const b = task.run({});
  FakeWorker.all[0].crash('kaput');
  await assert.rejects(a, e => /kaput/.test(e.message) && e.code === 'crashed');
  await assert.rejects(b, /kaput/);
  const next = task.run({});
  assert.equal(FakeWorker.all.length, 2);
  task.terminate();
  await assert.rejects(next, e => e.code === 'restarted');
});

test('a stale revision rejects with code stale', async () => {
  const task = new WorkerTask({ create: fresh() });
  const p = task.run({}, { revision: 4 });
  const w = FakeWorker.all[0];
  assert.equal(w.last.revision, 4);
  w.reply({ id: w.last.id, type: 'done', result: 1, revision: 3 });
  await assert.rejects(p, e => e.code === 'stale');
});

test('serial concurrency posts the next job only after the previous settles', async () => {
  const task = new WorkerTask({ create: fresh(), concurrency: 'serial' });
  const a = task.run({ n: 1 }); const b = task.run({ n: 2 });
  await tick();
  const w = FakeWorker.all[0];
  assert.equal(w.posts.length, 1);
  w.reply({ id: w.last.id, type: 'done', result: 1 });
  assert.equal(await a, 1);
  await tick();
  assert.equal(w.posts.length, 2);
  assert.deepEqual(w.last.payload, { n: 2 });
  w.reply({ id: w.last.id, type: 'done', result: 2 });
  assert.equal(await b, 2);
});

test('serial: a failed job does not block the queue', async () => {
  const task = new WorkerTask({ create: fresh(), concurrency: 'serial' });
  const a = task.run({ n: 1 }); const b = task.run({ n: 2 });
  await tick();
  let w = FakeWorker.all[0];
  w.reply({ id: w.last.id, type: 'error', message: 'bad' });
  await assert.rejects(a, /bad/);
  await tick();
  w = FakeWorker.all.at(-1);
  w.reply({ id: w.last.id, type: 'done', result: 2 });
  assert.equal(await b, 2);
});

test('per-job mode uses a fresh worker per job and terminates it after settle', async () => {
  const task = new WorkerTask({ create: fresh(), mode: 'per-job' });
  const a = task.run({}); const b = task.run({});
  assert.equal(FakeWorker.all.length, 2);
  const [wa, wb] = FakeWorker.all;
  wa.reply({ id: wa.last.id, type: 'done', result: 'a' });
  assert.equal(await a, 'a');
  assert.equal(wa.terminated, true);
  assert.equal(wb.terminated, false);
  wb.crash();
  await assert.rejects(b);
});

test('fallback runs when Worker is unavailable', async () => {
  const task = new WorkerTask({ create: null, fallback: payload => payload.x * 2 });
  assert.equal(await task.run({ x: 21 }), 42);
});

test('fallback runs when creating the worker throws', async () => {
  const task = new WorkerTask({ create: () => { throw new Error('csp'); }, fallback: () => 'inline' });
  assert.equal(await task.run({}), 'inline');
});

test('no worker and no fallback rejects', async () => {
  const task = new WorkerTask({ create: null, name: 'thing' });
  await assert.rejects(task.run({}), /thing requires a Web Worker/);
});

test('messages for unknown ids are ignored', async () => {
  const task = new WorkerTask({ create: fresh() });
  const p = task.run({});
  const w = FakeWorker.all[0];
  w.reply({ id: 9999, type: 'done', result: 'x' });
  w.reply(null);
  w.reply({ id: w.last.id, type: 'done', result: 'mine' });
  assert.equal(await p, 'mine');
});

test('aborting the only job on a persistent worker restarts it, so leftover work cannot delay the next job', async () => {
  const task = new WorkerTask({ create: fresh() });
  const ac = new AbortController();
  const p = task.run({}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(FakeWorker.all[0].terminated, true, 'busy worker dropped');
  const next = task.run({});
  assert.equal(FakeWorker.all.length, 2, 'next job on a fresh worker');
  const w = FakeWorker.all[1];
  w.reply({ id: w.last.id, type: 'done', result: 'ok' });
  assert.equal(await next, 'ok');
});

test('aborting one of several jobs keeps the shared worker for the others', async () => {
  const task = new WorkerTask({ create: fresh() });
  const ac = new AbortController();
  const a = task.run({}, { signal: ac.signal });
  const b = task.run({});
  ac.abort();
  await assert.rejects(a, e => e.name === 'AbortError');
  const w = FakeWorker.all[0];
  assert.equal(w.terminated, false);
  w.reply({ id: w.posts[1].data.id, type: 'done', result: 'b' });
  assert.equal(await b, 'b');
});
