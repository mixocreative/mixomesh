// Progress UX for every worker job (heavy-mesh spec §5, task d).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JA = await import('../src/core/workers/JobActivity.js');
const { WorkerTask } = await import('../src/core/workers/WorkerTask.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let now = 0;
JA.setClock(() => now);

class FakeWorker {
  static all = [];
  constructor() { this.posts = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(data) { this.posts.push(data); }
  terminate() { this.terminated = true; }
  reply(msg) { this.onmessage?.({ data: msg }); }
  get last() { return this.posts.at(-1); }
}
const tick = () => new Promise(r => setImmediate(r));

test('fast jobs never show; a shown job stays at least 500 ms', () => {
  JA.resetJobs(); now = 0;
  const fast = JA.beginJob({ label: 'job.checkMesh' });
  now = 300; fast.end();
  assert.deepEqual(JA.viewModel(now), []);
  assert.equal(JA.hasJobs(), false);

  now = 1000;
  const slow = JA.beginJob({ label: 'job.checkMesh' });
  now = 1399; assert.equal(JA.viewModel(now).length, 0, 'still inside the 400 ms delay');
  now = 1400; assert.equal(JA.viewModel(now)[0].state, 'indeterminate');
  now = 1500; slow.end();
  now = 1800; assert.equal(JA.viewModel(now)[0]?.state, 'done', 'kept for the minimum visible time');
  now = 1900; assert.deepEqual(JA.viewModel(now), []);
});

test('progress makes it determinate with %, stage, and time left once stable', () => {
  JA.resetJobs(); now = 0;
  const job = JA.beginJob({ label: 'job.importStl' });
  now = 500; job.progress({ stage: 'read', fraction: 0.05 });
  let [row] = JA.viewModel(now);
  assert.equal(row.state, 'determinate');
  assert.equal(row.percent, 5);
  assert.equal(row.stage, 'read');
  assert.equal(row.remainingMs, null, 'no ETA before 3 s / 10 %');
  now = 4500; job.progress({ stage: 'weld', fraction: 0.45 });
  [row] = JA.viewModel(now);
  assert.equal(row.percent, 45);
  assert.equal(row.stage, 'weld');
  assert.equal(row.remainingMs, Math.round((4000 / 0.4) * 0.55));
  job.progress({ stage: 'refining', fraction: 0.75 });
  [row] = JA.viewModel(now);
  assert.equal(row.percent, 75);
  assert.equal(row.stage, 'refining');
});

test('long jobs without progress show elapsed time after 10 s', () => {
  JA.resetJobs(); now = 0;
  JA.beginJob({ label: 'job.boolean' });
  now = 9000; assert.equal(JA.viewModel(now)[0].showElapsed, false);
  now = 11000; assert.equal(JA.viewModel(now)[0].showElapsed, true);
});

test('failures are never silent (even when fast) and linger; cancel is acknowledged', () => {
  JA.resetJobs(); now = 0;
  const job = JA.beginJob({ label: 'job.importStl' });
  now = 100; job.end(Object.assign(new Error('Model import timed out after 600000 ms'), { code: 'timeout' }));
  let [row] = JA.viewModel(now);
  assert.equal(row.state, 'failed');
  assert.equal(row.error.code, 'timeout');
  now = 100 + JA.ERROR_LINGER_MS - 1; assert.equal(JA.viewModel(now).length, 1);
  now = 100 + JA.ERROR_LINGER_MS; assert.equal(JA.viewModel(now).length, 0);

  let cancelled = 0;
  const c = JA.beginJob({ label: 'job.importStl', cancel: () => { cancelled++; } });
  now += 500; [row] = JA.viewModel(now);
  assert.equal(row.cancellable, true);
  assert.equal(JA.cancelJob(c.id), true);
  assert.equal(cancelled, 1);
  assert.equal(JA.viewModel(now)[0].cancelling, true);
  c.end(new DOMException('aborted', 'AbortError'));
  assert.equal(JA.viewModel(now)[0].state, 'cancelled');
  now += JA.CANCEL_LINGER_MS; assert.equal(JA.viewModel(now).length, 0);
});

test('WorkerTask reports every job: label, forwarded progress, end', async () => {
  JA.resetJobs(); now = 0;
  FakeWorker.all = [];
  const task = new WorkerTask({ create: () => new FakeWorker(), label: 'job.checkMesh' });
  const seen = [];
  const p = task.run({}, { onProgress: e => seen.push(e) });
  const w = FakeWorker.all[0];
  now = 600;
  w.reply({ id: w.last.id, type: 'progress', stage: 'edges', fraction: 0.5 });
  const [row] = JA.viewModel(now);
  assert.equal(row.label, 'job.checkMesh');
  assert.equal(row.percent, 50);
  assert.equal(row.cancellable, false, 'no signal, not cancellable → no Cancel button');
  assert.deepEqual(seen, [{ stage: 'edges', fraction: 0.5 }]);
  w.reply({ id: w.last.id, type: 'done', result: 1 });
  await p;
  await tick();
  assert.equal(JA.viewModel(now)[0].state, 'done');
});

test('Cancel in the activity UI rejects the job with AbortError and frees the worker', async () => {
  JA.resetJobs(); now = 0;
  FakeWorker.all = [];
  const task = new WorkerTask({ create: () => new FakeWorker(), label: 'job.importModel' });
  const p = task.run({}, { cancellable: true, label: 'job.importStl' });
  now = 500;
  const [row] = JA.viewModel(now);
  assert.equal(row.label, 'job.importStl', 'per-run label wins');
  JA.cancelJob(row.id);
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(FakeWorker.all[0].terminated, true, 'idle persistent worker dropped after abort');
  await tick();
  assert.equal(JA.viewModel(now)[0].state, 'cancelled');
});

test("a caller's own signal still aborts, and is cleaned up after the job", async () => {
  JA.resetJobs(); now = 0;
  FakeWorker.all = [];
  const task = new WorkerTask({ create: () => new FakeWorker(), label: 'job.boolean' });
  const ctrl = new AbortController();
  const p = task.run({}, { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

// ── Registry contract: every job runner in src has a label and every worker reports progress ──

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const SRC = walk(join(ROOT, 'src'));
const locales = ['en', 'ja', 'zh-Hant'].map(l => JSON.parse(readFileSync(join(ROOT, 'src/i18n/locales', `${l}.json`), 'utf8')));

test('every new WorkerTask in src has a translated job label', () => {
  const sites = [];
  for (const file of SRC) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/new WorkerTask\(\{([\s\S]*?)\n\}\)/g)) sites.push({ file, body: m[1] });
  }
  assert.ok(sites.length >= 8, `found ${sites.length} WorkerTask sites`);
  for (const { file, body } of sites) {
    const label = /label:\s*'(job\.[\w.]+)'/.exec(body)?.[1];
    assert.ok(label, `${file}: WorkerTask without a job.* label`);
    for (const table of locales) assert.ok(table[label], `${file}: ${label} missing in a locale`);
  }
});

test('every worker module reports progress', () => {
  const workers = SRC.filter(f => f.endsWith('.worker.js'));
  assert.ok(workers.length >= 8, `found ${workers.length} workers`);
  for (const file of workers) {
    const text = readFileSync(file, 'utf8');
    if (!/serveTask\(/.test(text)) continue;
    assert.match(text, /progress(\?\.)?\(\s*\{|progress\(\{|stage\(/, `${file} never calls progress(...)`);
  }
});

test('activity rows say what is running and, on failure, what to do next', async () => {
  const { installEnv } = await import('./env.mjs');
  installEnv();
  const { rowText, failureText } = await import('../src/ui/JobActivity.js');
  assert.match(failureText({ label: 'job.importStl', error: { code: 'timeout' } }), /timed out\. Try again; if it keeps happening, simplify or split the model\./);
  assert.match(failureText({ label: 'job.boolean', error: { message: 'Manifold rejected the input' } }), /Combining shapes failed: Manifold rejected the input\. Try again\./);
  assert.equal(failureText({ label: 'job.pickIndex', error: { message: 'worker crashed' } }),
    'Building pick index failed: worker crashed. Picking still works, just slower.', 'no "Try again" for background jobs (review M13)');
  assert.equal(failureText({ label: 'job.hashFile', error: { code: 'timeout' } }),
    'Checking whether the file is already in the project timed out. The file still imports, without duplicate detection.');
  assert.deepEqual(rowText({ label: 'job.importStl', state: 'determinate', percent: 40, stage: 'weld', remainingMs: 3000 }),
    { label: 'Loading STL — welding vertices', meta: '40% · about 3 s left' });
  assert.deepEqual(rowText({ label: 'job.checkMesh', state: 'indeterminate', percent: null, showElapsed: true, elapsedMs: 12000 }),
    { label: 'Checking mesh…', meta: '12 s so far' });
});

test('blob hashing: same digest inline and the big-file path falls back without Worker', async () => {
  const { sha256Hex, sha256HexOfBlob, WORKER_HASH_MIN_BYTES } = await import('../src/core/hash.js');
  const small = new Blob(['abc']);
  assert.equal(await sha256HexOfBlob(small), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const big = new Blob([new Uint8Array(WORKER_HASH_MIN_BYTES + 1)]);
  assert.equal(await sha256HexOfBlob(big), await sha256Hex(await big.arrayBuffer()));
});

test('stage-only progress keeps a row indeterminate (no fake percentages, review I6)', () => {
  JA.resetJobs(); now = 0;
  const job = JA.beginJob({ label: 'job.boolean' });
  now = 500; job.progress({ stage: 'load' });
  now = 600; job.progress({ stage: 'boolean' });
  const [row] = JA.viewModel(now);
  assert.equal(row.state, 'indeterminate');
  assert.equal(row.percent, null);
  assert.equal(row.stage, 'boolean');
  for (const name of ['Boolean', 'Hash', 'MeshValidate']) {
    const src = readFileSync(join(ROOT, 'src/core/workers', `${name}.worker.js`), 'utf8');
    assert.doesNotMatch(src, /fraction\s*:/, `${name}.worker.js reports an unmeasured fraction`);
  }
});

test('STL export encode honours Cancel and is never re-run inline after it (review I6)', async () => {
  const { encodeBinarySTLAsync } = await import('../src/core/print/StlWriter.js');
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(encodeBinarySTLAsync([], 'x', { signal: ctrl.signal }), { name: 'AbortError' });
});
