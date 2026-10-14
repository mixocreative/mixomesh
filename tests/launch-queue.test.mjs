// LI.2: pure launch-batch building + per-window queue semantics (electron/LaunchQueue.cjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildLaunchBatch, createLaunchQueue } = require('../electron/LaunchQueue.cjs');
const { parseLaunchArgv, validateLaunchPath } = require('../electron/LaunchArgs.cjs');

const file = size => ({ isFile: () => true, isDirectory: () => false, size });
const dir = { isFile: () => false, isDirectory: () => true, size: 0 };

function harness(files = {}) {
  const calls = [];
  const fs = {
    realpath: async p => { if (!(p in files)) throw new Error('ENOENT'); return p; },
    stat: async p => files[p],
  };
  return {
    calls,
    deps: {
      id: 'b1',
      validate: (raw, kind) => validateLaunchPath(raw, { kind, cwd: 'C:\\work', ...fs }),
      registerFile: (p, name, opts) => { calls.push(['file', p, !!opts.writable]); return { ref: `ref_${calls.length}`, name }; },
      registerMount: (p, name) => { calls.push(['mount', p]); return { ref: `mount_${calls.length}`, name }; },
    },
  };
}

test('mixed valid/invalid args: tokens for good ones, basename-only errors for bad ones', async () => {
  const h = harness({
    'C:\\work\\p.mixo': file(10), 'C:\\work\\a.glb': file(10), 'C:\\work\\sub\\b.stl': file(10), 'C:\\lib': dir,
  });
  const parsed = parseLaunchArgv(
    ['x.exe', '--open', 'p.mixo', '--open', 'a.glb', 'sub\\b.stl', '--open', 'C:\\secret\\dir\\missing.glb',
      '--open', '\\\\srv\\share\\n.glb', 'notes.txt', '--library', 'C:\\lib'],
    { isPackaged: true });
  const batch = await buildLaunchBatch(parsed, h.deps);
  assert.equal(batch.id, 'b1');
  assert.deepEqual(batch.items.map(i => [i.kind, i.name]), [['project', 'p.mixo'], ['import', 'a.glb'], ['import', 'b.stl']]);
  assert.equal(batch.library.name, 'lib');
  assert.deepEqual(batch.errors.map(e => e.name).sort(), ['missing.glb', 'n.glb', 'notes.txt']);
  assert.ok(batch.errors.every(e => typeof e.reason === 'string' && e.reason));
});

test('.mixo is registered writable, imports read-only, library via registerMount', async () => {
  const h = harness({ 'C:\\work\\p.mixo': file(1), 'C:\\work\\o.OBJ': file(1), 'C:\\lib': dir });
  const batch = await buildLaunchBatch({ opens: ['p.mixo', 'o.OBJ'], library: 'C:\\lib', ignored: [], truncated: 0 }, h.deps);
  assert.deepEqual(h.calls, [['file', 'C:\\work\\p.mixo', true], ['file', 'C:\\work\\o.OBJ', false], ['mount', 'C:\\lib']]);
  assert.equal(batch.items.length, 2);
});

test('no absolute path anywhere in the batch (items, library, errors)', async () => {
  const h = harness({ 'C:\\work\\a.glb': file(1) });
  const batch = await buildLaunchBatch({
    opens: ['a.glb', 'C:\\secret\\dir\\gone.glb'], library: 'C:\\secret\\nolib', ignored: ['C:\\secret\\x.txt'], truncated: 3,
  }, h.deps);
  const text = JSON.stringify(batch);
  assert.ok(!/secret|C:\\|work/i.test(text), text);
});

test('validator throwing or registry throwing never rejects the whole batch', async () => {
  const batch = await buildLaunchBatch({ opens: ['C:\\w\\a.glb'], library: 'C:\\lib', ignored: [], truncated: 0 }, {
    id: 'x',
    validate: async () => { throw new Error('C:\\leak\\boom'); },
    registerFile: () => { throw new Error('nope'); },
    registerMount: () => { throw new Error('nope'); },
  });
  assert.deepEqual(batch.items, []);
  assert.equal(batch.library, null);
  assert.equal(batch.errors.length, 2);
  assert.ok(!JSON.stringify(batch).includes('leak'));

  const reg = await buildLaunchBatch({ opens: ['a.glb'], library: null, ignored: [], truncated: 0 }, {
    ...harness({ 'C:\\work\\a.glb': file(1) }).deps,
    registerFile: () => { throw new Error('C:\\leak\\x'); },
  });
  assert.equal(reg.errors.length, 1);
  assert.ok(!JSON.stringify(reg).includes('leak'));
});

test('truncation is reported once', async () => {
  const b = await buildLaunchBatch({ opens: [], library: null, ignored: [], truncated: 5 }, harness().deps);
  assert.equal(b.errors.length, 1);
  assert.match(b.errors[0].reason, /32.*5 skipped/);
});

test('queue: held until pull; pull merges and flips ready; later batches push; reset re-holds', () => {
  const q = createLaunchQueue();
  const b = (id, n, lib) => ({ id, items: [{ kind: 'import', ref: id, name: n }], library: lib ?? null, errors: [] });
  assert.equal(q.isReady(), false);
  assert.equal(q.enqueue(b('1', 'a')), null);
  assert.equal(q.enqueue(b('2', 'b', { ref: 'm1', name: 'L1' })), null);
  assert.equal(q.enqueue(b('3', 'c', { ref: 'm2', name: 'L2' })), null);
  const pulled = q.pull();
  assert.equal(q.isReady(), true);
  assert.deepEqual(pulled.items.map(i => i.name), ['a', 'b', 'c']);
  assert.equal(pulled.library.ref, 'm2', 'last library wins');
  assert.equal(q.pull(), null, 'drained');
  const live = b('4', 'd');
  assert.equal(q.enqueue(live), live, 'ready: pushed straight through');
  q.reset();
  assert.equal(q.isReady(), false);
  assert.equal(q.enqueue(b('5', 'e')), null);
  assert.equal(q.pull().items[0].name, 'e');
});

test('queue: a single pending batch is returned as-is; overflow is bounded; ids unique', () => {
  const q = createLaunchQueue({ maxPending: 2 });
  const one = { id: 'z', items: [], library: null, errors: [] };
  q.enqueue(one);
  assert.equal(q.pull(), one);
  q.reset();
  q.enqueue(one); q.enqueue(one);
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(q.enqueue(one), null); } finally { console.warn = warn; }
  assert.equal(q.pull().items.length, 0);
  assert.notEqual(q.nextId(), q.nextId());
});
