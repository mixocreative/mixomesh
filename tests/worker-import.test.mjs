// WorkerImport per-job timeout (audit F17): a worker job that never posts
// back must reject, kill the worker, and let the next job start on a fresh
// worker instead of queueing forever behind the stall.
//   node --import ./tests/register-hooks.mjs tests/worker-import.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

// Fake Worker: captures postMessage, exposes onmessage/onerror, records terminate().
const workers = [];
class FakeWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    this.terminated = 0;
    this.onmessage = null;
    this.onerror = null;
    workers.push(this);
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated++; }
  // Test helper: reply to the last posted job as the worker would.
  reply(msg) { this.onmessage?.({ data: { id: this.posted.at(-1).id, ...msg } }); }
}
globalThis.Worker = FakeWorker;

// env.mjs has no mesh-building surface; give _buildContainer the minimum it
// touches so a 'done' payload rebuilds into a container.
const B = window.BABYLON;
B.AssetContainer = class { constructor() { this.meshes = []; this.materials = []; this.textures = []; } removeAllFromScene() {} };
B.Mesh = class { constructor(name) { this.name = name; } };
B.VertexData = class { applyToMesh(mesh) { mesh.__vd = this; } };
B.VertexBuffer = { ...B.VertexBuffer, NormalKind: 'normal', ColorKind: 'color' };

const { loadObjContainerViaWorker, isWorkerImportSupported, WORKER_JOB_TIMEOUT_MS } =
  await import('../src/core/WorkerImport.js');

const scene = {};
const DONE = {
  type: 'done',
  materials: [],
  meshes: [{
    name: 'm', position: [0, 0, 0], rotation: [0, 0, 0], rotationQuaternion: null,
    scaling: [1, 1, 1], sideOrientation: null, materialIndex: -1,
    kinds: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    indices: new Uint32Array([0, 1, 2]),
  }],
};

// Jobs are posted from a promise chain, never synchronously — drain a
// macrotask so the post has happened before poking the fake worker.
const tick = () => new Promise(r => setTimeout(r, 0));

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('worker path is considered supported with a Worker global', () => {
  assert.equal(isWorkerImportSupported(), true);
  assert.equal(WORKER_JOB_TIMEOUT_MS, 120_000, 'default is 120 s');
});

await test('(a) job that never replies rejects with /timed out/ and terminates the worker', async () => {
  const p = loadObjContainerViaWorker(scene, 'blob:stall', null, undefined, { timeoutMs: 20 });
  p.catch(() => {});   // asserted below; keep a late assertion failure from surfacing as unhandled
  await tick();
  assert.equal(workers.length, 1, 'one worker spawned');
  assert.equal(workers[0].posted.length, 1, 'job posted');
  await assert.rejects(p, /timed out after 0 s — falling back to main-thread parse/);
  assert.equal(workers[0].terminated, 1, 'terminate() called on the stalled worker');
});

await test('(b) after the timeout a new job gets a NEW worker instance', async () => {
  const before = workers.length;
  const p = loadObjContainerViaWorker(scene, 'blob:next', null, undefined, { timeoutMs: 1000 });
  await tick();
  assert.equal(workers.length, before + 1, 'fresh worker spawned');
  const w = workers.at(-1);
  assert.notEqual(w, workers[0], 'not the terminated instance');
  assert.equal(w.posted.length, 1, 'job posted to the new worker');
  w.reply(DONE);
  const container = await p;
  assert.equal(container.meshes.length, 1, 'normal completion on the new worker');
  assert.equal(w.terminated, 0, 'healthy worker kept alive');
});

await test('(c) a normal job still resolves and does not leave a timer/pending behind', async () => {
  const w = workers.at(-1);
  const p = loadObjContainerViaWorker(scene, 'blob:ok', new Map([['a.mtl', 'blob:mtl']]), undefined, { timeoutMs: 20 });
  await tick();
  assert.equal(workers.at(-1), w, 'reuses the live worker');
  assert.deepEqual(w.posted.at(-1).siblings, [['a.mtl', 'blob:mtl']]);
  w.reply(DONE);
  const container = await p;
  assert.equal(container.meshes.length, 1);
  // Wait past the timeout window: a settled job must not fire the timer.
  await new Promise(r => setTimeout(r, 40));
  assert.equal(w.terminated, 0, 'no late timeout on a completed job');
});

await test('worker-reported parse error still rejects without killing the worker (unchanged path)', async () => {
  const w = workers.at(-1);
  const p = loadObjContainerViaWorker(scene, 'blob:err', null, undefined, { timeoutMs: 1000 });
  p.catch(() => {});
  await tick();
  w.reply({ type: 'error', message: 'boom' });
  await assert.rejects(p, /boom/);
  assert.equal(w.terminated, 0, 'a parse error does not kill the worker');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
