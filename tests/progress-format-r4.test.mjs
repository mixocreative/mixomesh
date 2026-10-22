// One worker progress shape: `{ stage, fraction? }` (serveTask.ProgressFields).
// The old `{ loaded, total }`, `{ completed, total }` and `{ phase }` forms are
// gone from every producer, and the registry no longer reads them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKERS = `${ROOT}src/core/workers/`;

test('every worker progress() call carries a stage and never a legacy count field', () => {
  const files = readdirSync(WORKERS).filter(f => f.endsWith('.worker.js'));
  assert.ok(files.length >= 8, `workers found: ${files.length}`);
  for (const file of files) {
    const src = readFileSync(WORKERS + file, 'utf8');
    for (const call of src.matchAll(/progress\?*\(\{([^}]*)\}/g)) {
      const fields = call[1];
      assert.match(fields, /\bstage\b/, `${file}: progress(${fields}) has no stage`);
      assert.doesNotMatch(fields, /(^|,)\s*(loaded|completed|done|phase|lengthComputable|total)\s*:/, `${file}: legacy progress field in ${fields}`);
    }
  }
});

test('JobActivity reads fraction only: a count pair no longer makes a job determinate', async () => {
  const JA = await import('../src/core/workers/JobActivity.js');
  let now = 0;
  JA.setClock(() => now);
  JA.resetJobs();
  const job = JA.beginJob({ label: 'job.checkMesh' });
  now = 500;
  job.progress({ stage: 'edges', loaded: 50, total: 100 });
  assert.equal(JA.viewModel(now)[0].state, 'indeterminate');
  job.progress({ stage: 'edges', fraction: 0.5 });
  assert.equal(JA.viewModel(now)[0].percent, 50);
  job.progress({ fraction: 7 });
  assert.equal(JA.viewModel(now)[0].percent, 100, 'clamped');
  job.end();
  JA.resetJobs();
});

test('the refinement client rejects a legacy-shaped progress message', async () => {
  const workers = [];
  class FakeWorker {
    constructor() { this.posted = []; workers.push(this); }
    postMessage(message) { this.posted.push(message); }
    terminate() {}
    reply(message) { this.onmessage?.({ data: message }); }
  }
  const prev = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const { refineInWorker } = await import('../src/core/MixoRefinementWorker.js');
    const source = { positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]), indices: new Uint32Array([0,1,2]) };
    const seen = [];
    const p = refineInWorker(source, 0, { onProgress: e => seen.push(e) });
    const w = workers.at(-1);
    w.reply({ id: w.posted[0].id, type: 'progress', stage: 'reading', fraction: 0.5 });
    assert.deepEqual(seen.map(({ phase, completed, total }) => ({ phase, completed, total })), [{ phase: 'reading', completed: 0.5, total: 1 }]);
    w.reply({ id: w.posted[0].id, type: 'progress', phase: 'Refining', completed: 1, total: 1 });
    await assert.rejects(p, /invalid refinement progress/);
  } finally {
    globalThis.Worker = prev;
  }
});
