import assert from 'node:assert/strict';
import test from 'node:test';
import { createLaunchRunner } from '../src/core/LaunchRequests.js';

function setup(over = {}) {
  const log = [];
  const toasts = [];
  const file = n => ({ name: n });
  const storage = {
    readFile: async ref => { log.push(`read:${ref}`); return file(ref); },
    ...(over.storage ?? {}),
  };
  const deps = {
    storage,
    openProject: async p => { log.push(`open:${p.ref}`); },
    mountLibrary: async p => { log.push(`mount:${p.ref}`); },
    importAssets: async p => { log.push(`import:${p.map(x => x.ref).join('+')}`); },
    toast: (m, type) => toasts.push({ m, type }),
    t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k),
    isBusy: () => false,
    sleep: async () => {},
    ...over.deps,
  };
  return { log, toasts, runner: createLaunchRunner(deps), deps };
}
const item = (kind, ref, name = ref) => ({ kind, ref, name });

test('order: project -> library -> imports', async () => {
  const { log, runner, toasts } = setup();
  await runner.handle({ id: 1, items: [item('import', 'a.stl'), item('project', 'p.mixo'), item('import', 'b.glb')], library: { ref: 'lib', name: 'lib' }, errors: [] });
  assert.deepEqual(log, ['read:p.mixo', 'open:p.mixo', 'mount:lib', 'import:a.stl+b.glb']);
  assert.equal(toasts.length, 0);
});

test('last .mixo wins, earlier ones reported skipped', async () => {
  const { log, runner, toasts } = setup();
  await runner.handle({ id: 1, items: [item('project', 'one.mixo'), item('project', 'two.mixo')], library: null, errors: [] });
  assert.deepEqual(log, ['read:two.mixo', 'open:two.mixo']);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].m, /one\.mixo/);
});

test('dirty cancel (openPicked returns) skips only the open; library + imports still run', async () => {
  const { log, runner, toasts } = setup({ deps: { openProject: async () => { log2.push('cancelled'); } } });
  const log2 = [];
  await runner.handle({ id: 1, items: [item('project', 'p.mixo'), item('import', 'a.stl')], library: { ref: 'lib', name: 'lib' }, errors: [] });
  assert.deepEqual(log, ['read:p.mixo', 'mount:lib', 'import:a.stl']);
  assert.deepEqual(log2, ['cancelled']);
  assert.equal(toasts.length, 0);
});

test('errors toast once with basenames and reasons (main errors + step failures)', async () => {
  const { runner, toasts, log } = setup({ deps: { mountLibrary: async () => { throw new Error('nope'); } } });
  await runner.handle({ id: 1, items: [item('import', 'a.stl')], library: { ref: 'lib', name: 'libdir' }, errors: [{ name: 'bad.xyz', reason: 'unsupported type' }] });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].m, /bad\.xyz: unsupported type/);
  assert.match(toasts[0].m, /libdir: nope/);
  assert.ok(log.includes('import:a.stl'));
});

test('batch mid-import waits until idle', async () => {
  let busy = 3;
  const { log, runner } = setup({ deps: { isBusy: () => busy-- > 0 } });
  await runner.handle({ id: 1, items: [item('import', 'a.stl')], library: null, errors: [] });
  assert.deepEqual(log, ['import:a.stl']);
  assert.ok(busy < 0);
});

test('still busy after 30 s: batch dropped with one toast', async () => {
  let t = 0;
  const { log, runner, toasts } = setup({ deps: { isBusy: () => true, now: () => t, sleep: async ms => { t += ms; } } });
  await runner.handle({ id: 1, items: [item('import', 'a.stl')], library: null, errors: [] });
  assert.deepEqual(log, []);
  assert.equal(toasts.length, 1);
  assert.ok(t >= 30000);
});

test('no-op without the bridge methods', async () => {
  const { log, runner, toasts } = setup();
  const off = await runner.init();
  assert.equal(typeof off, 'function');
  assert.deepEqual(log, []);
  assert.equal(toasts.length, 0);
});

test('init pulls queued batch, subscribes, and ignores a duplicate batch id', async () => {
  let push;
  const batch = { id: 'x', items: [item('import', 'a.stl')], library: null, errors: [] };
  const { log, runner } = setup({ storage: {
    pullLaunchRequests: async () => batch,
    onLaunchRequests: cb => { push = cb; return () => {}; },
  } });
  await runner.init();
  assert.deepEqual(log, ['import:a.stl']);
  await push(batch);                       // same id (pull/push race) -> ignored
  await runner.handle(batch);
  assert.deepEqual(log, ['import:a.stl']);
  await runner.handle({ ...batch, id: 'y' });
  assert.deepEqual(log, ['import:a.stl', 'import:a.stl']);
});
