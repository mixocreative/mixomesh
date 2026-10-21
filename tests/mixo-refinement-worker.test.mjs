import test from 'node:test';
import assert from 'node:assert/strict';

const workers = [];
class FakeWorker {
  constructor() { this.posted = []; this.terminated = false; workers.push(this); }
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(message) { this.onmessage?.({ data: message }); }
}
globalThis.Worker = FakeWorker;
const { refineInWorker, refinePartsInWorker } = await import('../src/core/MixoRefinementWorker.js');

const source = { positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]), indices: new Uint32Array([0,1,2]) };
const valid = () => ({ positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]), indices: new Uint32Array([0,1,2]), normals: new Float32Array([0,0,1, 0,0,1, 0,0,1]) });

test('forwards progress and accepts a validated result without detaching source', async () => {
  const progress = [];
  const promise = refineInWorker(source, 0, { sourceRevision: 3, onProgress: event => progress.push(event) });
  const worker = workers.at(-1), posted = worker.posted[0];
  assert.equal(posted.type, 'run');
  assert.equal(posted.revision, 3);
  assert.notEqual(posted.payload.geometry.positions, source.positions);
  worker.reply({ id: posted.id, type: 'progress', phase: 'Refining', completed: 1, total: 1 });
  worker.reply({ id: posted.id, type: 'done', revision: 3, result: { geometry: valid() } });
  const result = await promise;
  assert.equal(result.sourceRevision, 3);
  assert.equal(progress.length, 1);
  assert.equal(source.positions.length, 9);
  assert.equal(worker.terminated, true);
});

test('abort terminates worker and late messages cannot settle replacement job', async () => {
  const abort = new AbortController();
  const first = refineInWorker(source, 0, { signal: abort.signal });
  const old = workers.at(-1), oldId = old.posted[0].id;
  abort.abort();
  await assert.rejects(first, /abort/i);
  assert.equal(old.terminated, true);
  const next = refineInWorker(source, 0);
  const fresh = workers.at(-1), freshId = fresh.posted[0].id;
  assert.ok(freshId > oldId);
  old.reply({ id: oldId, type: 'done', revision: 0, result: { geometry: valid() } });
  fresh.reply({ id: freshId, type: 'done', revision: 0, result: { geometry: valid() } });
  await next;
});

test('timeout, worker error, stale revision, and malformed results reject clearly', async () => {
  await assert.rejects(refineInWorker(source, 0, { timeoutMs: 5 }), /timed out/);
  assert.equal(workers.at(-1).terminated, true);
  const crashed = refineInWorker(source, 0);
  workers.at(-1).onerror({ message: 'worker crash' });
  await assert.rejects(crashed, /worker crash/);
  const stale = refineInWorker(source, 0, { sourceRevision: 9 });
  let worker = workers.at(-1), jobId = worker.posted[0].id;
  worker.reply({ id: jobId, type: 'done', revision: 8, result: { geometry: valid() } });
  await assert.rejects(stale, /stale/);
  const malformed = refineInWorker(source, 0);
  worker = workers.at(-1); jobId = worker.posted[0].id;
  worker.reply({ id: jobId, type: 'done', revision: 0, result: { geometry: { ...valid(), indices: new Uint32Array([0,1,99]) } } });
  await assert.rejects(malformed, /invalid.*index/i);
});

test('material batch posts one joint job and validates every returned part', async () => {
  const promise = refinePartsInWorker([source, source], 0, { sourceRevision: 2 });
  const worker = workers.at(-1), posted = worker.posted[0];
  assert.equal(posted.payload.kind, 'refine-parts');
  assert.equal(posted.payload.geometry.length, 2);
  worker.reply({ id: posted.id, type: 'done', revision: 2, result: { geometries: [valid(), valid()] } });
  const result = await promise;
  assert.equal(result.geometries.length, 2);
  const failed = refinePartsInWorker([source, source], 0);
  const badWorker = workers.at(-1), badPost = badWorker.posted[0];
  badWorker.reply({ id: badPost.id, type: 'done', revision: 0, result: { geometries: [valid()] } });
  await assert.rejects(failed, /count/);
});
