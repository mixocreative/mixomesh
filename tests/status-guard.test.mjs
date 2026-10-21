import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { guard } = await import('../src/ui/Status.js');
const { Modal } = await import('../src/ui/Modal.js');

test('guard: a cancelled job (AbortError) is silent, a real failure opens the modal', async (t) => {
  const opened = [];
  const open = Modal.open;
  const err = console.error;
  t.after(() => { Modal.open = open; console.error = err; });
  Modal.open = (id, data) => opened.push([id, data?.message]);
  console.error = () => {};
  assert.equal(await guard(async () => { throw new DOMException('Loading model aborted', 'AbortError'); }, { modal: true }), undefined);
  assert.equal(opened.length, 0);
  await guard(async () => { throw new Error('Loading model timed out after 300000 ms'); }, { modal: true, filename: 'a.stl' });
  assert.deepEqual(opened, [['importError', 'Loading model timed out after 300000 ms']]);
});
