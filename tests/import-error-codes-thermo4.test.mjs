import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();

const { classifyImportFailure } = await import('../src/core/import/ImportFailure.js');
const { assertTriangleCapacity, assertPreParseCapacity } = await import('../src/core/import/ImportLimits.js');
const { serveTask } = await import('../src/core/workers/serveTask.js');
const { WorkerTask } = await import('../src/core/workers/WorkerTask.js');
const { mayFallBackToMainThread } = await import('../src/core/assets/AssetImport.js');

const refusal = (fn) => { try { fn(); } catch (err) { return err; } return null; };

test('a refusal keeps its category however its English text is worded', () => {
  const err = refusal(() => assertTriangleCapacity(500, 100));
  assert.equal(err?.code, 'over-budget');
  const reworded = Object.assign(new Error('Too many faces for this build.'), { code: err.code });
  assert.equal(classifyImportFailure(reworded).category, 'polygons');
  const pre = refusal(() => assertPreParseCapacity({ triangles: 900, confidence: 'exact', exact: true }, { budget: 100, filename: 'a.stl' }));
  assert.equal(pre?.code, 'over-budget');
});

test('a worker failure that merely mentions triangles may still retry on the main thread', () => {
  assert.equal(mayFallBackToMainThread(new Error('mesh has 3 degenerate triangles'), 1000), true);
  assert.equal(mayFallBackToMainThread(Object.assign(new Error('x'), { code: 'over-budget' }), 1000), false);
});

test('a refusal thrown inside a worker reaches the caller with its code', async () => {
  const task = new WorkerTask({ create: () => {
    const worker = { postMessage: (data) => scope.onmessage({ data }), terminate() {} };
    const scope = { postMessage: (data) => worker.onmessage?.({ data }) };
    serveTask(() => assertTriangleCapacity(500, 100), scope);
    return worker;
  } });
  await assert.rejects(task.run({}, { label: 'job.importModel' }), (err) => err.code === 'over-budget');
});
