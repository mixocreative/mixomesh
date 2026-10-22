// One progress model (thermo step 4): an import is a blocking job in
// JobActivity, its worker steps are filed under it by their shared cancel
// signal, and the overlay renders the registry's blocking job. No `hidden`
// flag anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEnv } from './env.mjs';

installEnv();
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JA = await import('../src/core/workers/JobActivity.js');
const { WorkerTask } = await import('../src/core/workers/WorkerTask.js');

let now = 0;
JA.setClock(() => now);

class FakeWorker {
  static all = [];
  constructor() { this.posts = []; FakeWorker.all.push(this); }
  postMessage(data) { this.posts.push(data); }
  terminate() {}
  reply(msg) { this.onmessage?.({ data: msg }); }
}
const tick = () => new Promise(r => setImmediate(r));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('a worker job on a blocking job\'s signal is its step: never a row, gone when it ends', async () => {
  JA.resetJobs(); now = 0;
  FakeWorker.all = [];
  const abort = new AbortController();
  const importJob = JA.beginJob({ label: 'job.importModel', detail: 'model.stl', blocking: true, signal: abort.signal, cancel: () => abort.abort() });
  const task = new WorkerTask({ create: () => new FakeWorker(), label: 'job.hashFile' });
  const p = task.run({}, { signal: abort.signal });
  now = 1000;
  assert.deepEqual(JA.viewModel(now), [], 'the hash is not a row of its own');
  assert.equal(JA.blockingJob().detail, 'model.stl');
  assert.equal(JA.isRunning('job.importModel'), true);
  const w = FakeWorker.all[0];
  w.reply({ id: w.posts[0].id, type: 'done', result: 'abc' });
  assert.equal(await p, 'abc');
  await tick();
  assert.deepEqual(JA.viewModel(now + 10_000), [], 'nor afterwards');
  importJob.end();
  assert.equal(JA.blockingJob(), null);
  assert.equal(JA.isRunning('job.importModel'), false);
  assert.equal(JA.hasJobs(), false, 'blocking jobs and their steps do not linger');
});

test('the same worker job with its own signal is a row with Cancel', () => {
  JA.resetJobs(); now = 0;
  const abort = new AbortController();
  const task = new WorkerTask({ create: () => new FakeWorker(), label: 'job.hashFile' });
  const p = task.run({}, { signal: abort.signal });
  now = 1000;
  const rows = JA.viewModel(now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'job.hashFile');
  assert.equal(rows[0].cancellable, true);
  assert.equal(JA.blockingJob(), null);
  abort.abort();
  return assert.rejects(p, { name: 'AbortError' });
});

test('the overlay follows the blocking job: opens with its Cancel, shows detail and stage, closes with it', async () => {
  JA.resetJobs(); now = 0;
  const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
  const sessions = [];
  const realOpen = ProgressOverlay.open;
  ProgressOverlay.open = (title, opts) => {
    const s = { title, opts, updates: [], closed: false };
    sessions.push(s);
    return { update(frac, msg) { s.updates.push([frac, msg]); }, close() { s.closed = true; } };
  };
  try {
    const abort = new AbortController();
    const job = JA.beginJob({ label: 'job.importModel', detail: 'a.3mf', blocking: true, signal: abort.signal, cancel: () => abort.abort() });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].opts.delayMs, JA.SHOW_DELAY_MS);
    assert.equal(sessions[0].opts.minVisibleMs, JA.MIN_VISIBLE_MS);
    job.progress({ stage: 'weld', fraction: 0.5 });
    assert.deepEqual(sessions[0].updates.at(-1), [0.5, 'a.3mf — welding vertices']);
    sessions[0].opts.onCancel();
    assert.equal(abort.signal.aborted, true, 'the overlay Cancel cancels the blocking job');
    job.end(new DOMException('cancelled', 'AbortError'));
    assert.equal(sessions[0].closed, true);
    assert.equal(sessions.length, 1, 'one session for the whole blocking job');
  } finally {
    ProgressOverlay.open = realOpen;
    JA.resetJobs();
  }
});

test('no caller threads a hidden flag any more', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src/core'))) {
    const text = readFileSync(file, 'utf8');
    if (/\bhidden:\s*(true|!!|hidden)/.test(text) || /\{[^}]*\bhidden\b[^}]*\}\s*=\s*opts/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
