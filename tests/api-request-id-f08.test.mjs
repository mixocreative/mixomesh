// cia F-08 (owner decision 2026-10-22): an automation request may carry a
// `requestId`. A repeat of the same id within the window is answered with the
// first outcome and does not run again, so a job re-run after a timeout never
// imports the same files twice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher, REQUEST_ID_WINDOW_MS } from '../src/core/api/ApiDispatcher.js';

function setup() {
  let clock = 0;
  let n = 0;
  const imports = [];
  const objects = {};
  const dispatcher = createDispatcher({
    now: () => clock,
    state: { getState: () => ({ scene: { objects } }), subscribe: () => () => {} },
    persistence: { isDirty: () => false },
    importPicked: async picked => {
      imports.push(picked.map(p => p.name));
      const id = `o${++n}`;
      objects[id] = { id, name: picked[0].name, logicalObjectId: id };
    },
  });
  const importOnce = (requestId, name = 'part.stl') =>
    dispatcher.dispatch('scene.import', { files: [{ ref: `tok-${name}`, name }], ...(requestId ? { requestId } : {}) });
  return { dispatcher, imports, importOnce, advance: ms => { clock += ms; } };
}

test('the same import sent twice with one requestId imports once and answers the first result', async () => {
  const { imports, importOnce } = setup();
  const first = await importOnce('job-42');
  const again = await importOnce('job-42');
  assert.equal(imports.length, 1);
  assert.deepEqual(again, first);
});

test('a repeat that arrives while the first is still running waits for it', async () => {
  const { imports, importOnce } = setup();
  const [a, b] = await Promise.all([importOnce('job-7'), importOnce('job-7')]);
  assert.equal(imports.length, 1);
  assert.deepEqual(a, b);
});

test('different ids, no id, or an expired window run again', async () => {
  const { imports, importOnce, advance } = setup();
  await importOnce('a');
  await importOnce('b');
  await importOnce();
  await importOnce();
  advance(REQUEST_ID_WINDOW_MS + 1);
  await importOnce('a');
  assert.equal(imports.length, 5);
});

test('a requestId reused for another method is refused', async () => {
  const { dispatcher, importOnce } = setup();
  await importOnce('x');
  await assert.rejects(dispatcher.dispatch('scene.list', { requestId: 'x' }), e => e.data.code === 'E_INVALID_PARAMS');
});

test('a failed request is not remembered, so its retry runs', async () => {
  let calls = 0;
  const d = createDispatcher({
    state: { getState: () => ({ scene: { objects: {} } }), subscribe: () => () => {} },
    persistence: { isDirty: () => false },
    importPicked: async () => { calls++; },
  });
  const run = () => d.dispatch('scene.import', { files: [{ ref: 't', name: 'empty.stl' }], requestId: 'r' });
  await assert.rejects(run());
  await assert.rejects(run());
  assert.equal(calls, 2);
});

test('requestId must be a short non-empty string', async () => {
  const { dispatcher } = setup();
  for (const requestId of ['', 5, 'x'.repeat(129)]) {
    await assert.rejects(dispatcher.dispatch('scene.list', { requestId }), e => e.data.code === 'E_INVALID_PARAMS');
  }
});
