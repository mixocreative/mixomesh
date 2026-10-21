import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher, scrubPaths } from '../src/core/api/ApiDispatcher.js';
import { METHODS } from '../src/core/api/ApiSchema.js';
import { API_VERSION } from '../src/core/api/ApiErrors.js';

const EVENTS = {
  ASSET_INSTANTIATED: 'asset:instantiated', OBJECT_REMOVED: 'object:removed',
  SELECTION_CHANGED: 'selection:changed', VALIDATION_COMPLETE: 'validation:complete',
  PROJECT_LOADED: 'project:loaded', PROJECT_NEW: 'project:new', PROJECT_SAVED: 'project:saved',
};
const ref = (name, r = `tok-${name}`) => ({ ref: r, name });

function setup(over = {}) {
  const log = [];
  const listeners = new Map();
  const notes = [];
  let dirty = false;
  let sel = [];
  let busy = false;
  let clock = 0;
  const st = {
    scene: {
      objects: {
        a: { id: 'a', name: 'Alpha', logicalObjectId: 'a', collectionId: 'c1', isPrintPart: true },
        a2: { id: 'a2', name: 'Alpha part', logicalObjectId: 'a', isInternalPart: true, isPrintPart: true },
        b: { id: 'b', name: 'Beta', logicalObjectId: 'b', isPrintPart: true },
      },
      groups: { g1: { id: 'g1', name: 'Group' } },
      validation: { a: { results: [{ severity: 'error' }, { severity: 'warning' }], stale: false } },
    },
    project: { name: 'Proj', id: 'p1', lastSavedAt: null },
    cost: { materialId: 'pla', pricePerGram: 0.1 },
  };
  const deps = {
    appVersion: '9.9.9', runtime: 'desktop',
    now: () => clock, sleep: async ms => { clock += ms; log.push(`sleep:${ms}`); },
    isBusy: () => busy, busyTimeoutMs: 1000, busyPollMs: 250,
    notify: e => notes.push(e),
    state: {
      getState: () => st,
      subscribe: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => listeners.get(name).delete(fn);
      },
    },
    EVENTS,
    selection: {
      set: (ids) => { log.push(`select:${ids.join(',')}`); sel = ids; },
      getSelectedIds: () => sel,
    },
    history: { push: c => { log.push(`push:${c.label}`); c.execute(); } },
    commands: {
      transform: (id, patch) => (patch.position_mm ? { label: `xf:${id}`, execute() { log.push('xf-exec'); } } : null),
      remove: ids => ({ label: `del:${ids.join(',')}`, execute() {} }),
      applyPrinter: id => ({ label: `printer:${id}`, execute() {} }),
    },
    persistence: {
      isDirty: () => dirty, discardChanges: () => { dirty = false; log.push('discard'); },
      hasSaveTarget: () => over.hasTarget ?? true,
      newProject: async () => { log.push('new'); },
      openPicked: async p => { log.push(`open:${p.ref}:${p.file.name}`); },
      save: async () => { log.push('save'); return true; },
      saveAs: async t => { log.push(`saveAs:${t.ref}`); return over.saveAsResult ?? true; },
    },
    readFile: async r => (over.unreadable ? null : { name: `${r}.mixo` }),
    importPicked: async picked => {
      log.push(`import:${picked.map(p => p.ref).join('+')}`);
      if (!over.importNothing) st.scene.objects.n1 = { id: 'n1', name: 'New', logicalObjectId: 'n1' };
    },
    mountLibrary: async p => { log.push(`mount:${p.ref}`); },
    listLibrary: async sub => (sub === 'missing' ? null : [{ name: 'x.stl', kind: 'file', path: 'C:\\secret\\x.stl', ref: 'r' }]),
    metrics: ids => ({ bounds_mm: { min: [0, 0, 0], max: [1, 2, 3], size: [1, 2, 3] }, triangles: 10 * ids.length }),
    printers: {
      list: () => [{ id: 'p1', displayName: 'P1' }], get: () => ({ id: 'p1' }),
      exists: id => id === 'p1', currentId: () => 'p1',
    },
    validator: {
      validateAll: async () => new Map([['a', [{ type: 'holes', severity: 'error', message: 'm' }]]]),
      validateOne: async id => (over.validateOne ? over.validateOne(id) : [{ type: 'x', severity: 'warning', message: id }]),
    },
    repair: { run: async ids => { log.push(`repair:${ids.join(',')}`); return { repaired: 1, holesFilled: 2, nmFixed: 0, failed: [{ meshId: 'b', name: 'Beta', error: new Error('boom at C:\\Users\\me\\b.stl') }] }; } },
    readiness: { get: () => ({ canExport: true, issues: [] }) },
    cost: {
      material: id => (id === 'pla' ? { id: 'pla' } : null),
      contexts: async ({ ids }) => { log.push(`ctx:${ids ? ids.join(',') : 'all'}`); return [{ label: 'as shown', ctx: { c: 1 } }]; },
      quote: (ctx, s, m) => ({ total: s.pricePerGram * 100, material: m?.id ?? null }),
    },
    exporter: {
      formats: ['stl', '3mf'],
      collectExportFiles: async (formats, options) => {
        log.push(`export:${formats.join(',')}:${JSON.stringify(options)}`);
        return over.exportResult ?? { blocked: false, files: [{ name: 'a.stl', mime: 'model/stl', bytes: over.bytes ?? new Uint8Array([1, 2, 3]) }] };
      },
    },
    capture: {
      capturePng: async o => { log.push(`png:${JSON.stringify(o)}`); return new Blob([new Uint8Array([137, 80, 78, 71])]); },
      captureListingShot: async o => { log.push(`thumb:${JSON.stringify(o)}`); return new Uint8Array([137, 80]); },
    },
    ...over.deps,
  };
  const d = createDispatcher(deps);
  return {
    d, log, notes, st, deps,
    setDirty: v => { dirty = v; }, setBusy: v => { busy = v; },
    fire: (name, p) => [...(listeners.get(name) ?? [])].forEach(f => f(p)),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    tick: ms => { clock += ms; },
  };
}
const code = async p => { try { await p; } catch (e) { return e.data?.code; } return null; };

test('every ApiSchema method has a handler (no E_METHOD_NOT_FOUND for v1 methods)', async () => {
  const { d } = setup();
  for (const m of METHODS) {
    const c = await code(d.dispatch(m.name, {}));
    assert.notEqual(c, 'E_METHOD_NOT_FOUND', m.name);
  }
  assert.equal(await code(d.dispatch('nope.nothing', {})), 'E_METHOD_NOT_FOUND');
});

test('validateParams runs first: unknown field / bad type -> E_INVALID_PARAMS', async () => {
  const { d, log } = setup();
  assert.equal(await code(d.dispatch('scene.get', { id: 'a', bogus: 1 })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('scene.get', {})), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('printer.set', { id: 5 })), 'E_INVALID_PARAMS');
  assert.deepEqual(log, []);
});

test('app.info / capabilities / ping', async () => {
  const { d } = setup();
  const info = await d.dispatch('app.info', {});
  assert.equal(info.apiVersion, API_VERSION);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.runtime, 'desktop');
  const caps = await d.dispatch('app.capabilities', {});
  assert.equal(caps.apiVersion, API_VERSION);
  assert.deepEqual(caps.methods.map(m => m.name), METHODS.map(m => m.name));
  assert.ok(caps.events.includes('exportDone'));
  assert.equal((await d.dispatch('app.ping', {})).pong, true);
});

test('app.* answers immediately while a request is waiting on busy', async () => {
  const { d, setBusy } = setup();
  setBusy(true);
  const slow = d.dispatch('project.info', {});
  assert.equal((await d.dispatch('app.ping', {})).pong, true);
  assert.equal((await d.dispatch('app.info', {})).busy, true);
  assert.equal(await code(slow), 'E_BUSY');
});

test('serial queue: requests run strictly in order, one at a time', async () => {
  const order = [];
  let active = 0; let maxActive = 0;
  const { d } = setup({
    deps: {
      validator: {
        validateAll: async () => new Map(),
        validateOne: async id => {
          active++; maxActive = Math.max(maxActive, active);
          order.push(`start:${id}`);
          await new Promise(r => setTimeout(r, id === 'a' ? 20 : 1));
          order.push(`end:${id}`);
          active--; return [];
        },
      },
    },
  });
  await Promise.all([d.dispatch('validate.run', { ids: ['a'] }), d.dispatch('validate.run', { ids: ['b'] })]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  assert.equal(maxActive, 1);
});

test('a failing request does not wedge the queue', async () => {
  const { d } = setup();
  assert.equal(await code(d.dispatch('scene.get', { id: 'zzz' })), 'E_NOT_FOUND');
  assert.equal((await d.dispatch('project.info', {})).name, 'Proj');
});

test('busy: waits (polls) until idle, then runs', async () => {
  let n = 0;
  const s2 = setup({ deps: { sleep: async ms => { s2.log.push(`sleep:${ms}`); if (++n === 2) s2.setBusy(false); } } });
  s2.setBusy(true);
  const r = await s2.d.dispatch('project.info', {});
  assert.equal(r.name, 'Proj');
  assert.deepEqual(s2.log.filter(l => l.startsWith('sleep:')), ['sleep:250', 'sleep:250']);
});

test('busy: stays busy past the timeout -> E_BUSY, handler never ran', async () => {
  const s = setup();
  s.setBusy(true);
  assert.equal(await code(s.d.dispatch('project.new', {})), 'E_BUSY');
  assert.ok(!s.log.includes('new'));
});

test('path params: raw strings are refused, tokens accepted, never echoed as paths', async () => {
  const { d, log } = setup();
  const e = await d.dispatch('scene.import', { files: ['C:\\x\\a.stl'] }).catch(x => x);
  assert.equal(e.data.code, 'E_PATH_REJECTED');
  assert.ok(!JSON.stringify(e).includes('C:\\x'));
  assert.equal(await code(d.dispatch('scene.import', { files: [{ nope: 1 }] })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('library.mount', { dir: '/tmp/x' })), 'E_PATH_REJECTED');
  await d.dispatch('scene.import', { files: [ref('a.stl', 'T1'), ref('b.glb', 'T2')] });
  assert.ok(log.includes('import:T1+T2'));
});

test('scene.import: limit of 32 files, returns added objects only (no refs/paths)', async () => {
  const { d } = setup();
  const many = Array.from({ length: 33 }, (_, i) => ref(`f${i}.stl`));
  assert.equal(await code(d.dispatch('scene.import', { files: many })), 'E_LIMIT');
  const r = await d.dispatch('scene.import', { files: [ref('a.stl')] });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].id, 'n1');
  assert.ok(!JSON.stringify(r).includes('tok-'));
});

test('scene.import: nothing produced -> E_INTERNAL', async () => {
  const { d } = setup({ importNothing: true });
  assert.equal(await code(d.dispatch('scene.import', { files: [ref('a.stl')] })), 'E_INTERNAL');
});

test('runtime without refs: every needsPath method -> E_UNSUPPORTED', async () => {
  const { d } = setup({ deps: { supportsRefs: false } });
  for (const m of METHODS.filter(x => x.needsPath)) {
    assert.equal(await code(d.dispatch(m.name, {})), 'E_UNSUPPORTED', m.name);
  }
  assert.equal((await d.dispatch('project.info', {})).name, 'Proj');
});

test('scene.list: lead objects only, no refs/paths, optional validation', async () => {
  const { d } = setup();
  const { objects } = await d.dispatch('scene.list', {});
  assert.deepEqual(objects.map(o => o.id), ['a', 'b']);
  const a = objects[0];
  assert.deepEqual(Object.keys(a).sort(), ['bounds_mm', 'collectionId', 'id', 'kind', 'logicalObjectId', 'name', 'triangles']);
  assert.equal(a.triangles, 20);   // a + a2 parts
  const withV = (await d.dispatch('scene.list', { includeValidation: true })).objects[0];
  assert.deepEqual(withV.validation, { checked: true, stale: false, errors: 1, warnings: 1 });
});

test('scene.get: ids validated, internal part resolves to its lead, group allowed', async () => {
  const { d } = setup();
  assert.equal((await d.dispatch('scene.get', { id: 'a2' })).id, 'a');
  assert.equal((await d.dispatch('scene.get', { id: 'g1' })).kind, 'group');
  assert.equal(await code(d.dispatch('scene.get', { id: 'nope' })), 'E_NOT_FOUND');
});

test('scene.select: ids validated (E_NOT_FOUND), additive merges', async () => {
  const { d, log } = setup();
  assert.equal(await code(d.dispatch('scene.select', { ids: ['a', 'ghost'] })), 'E_NOT_FOUND');
  assert.ok(!log.some(l => l.startsWith('select:')));
  assert.deepEqual((await d.dispatch('scene.select', { ids: ['a'] })).selectedIds, ['a']);
  assert.deepEqual((await d.dispatch('scene.select', { ids: ['b'], additive: true })).selectedIds, ['a', 'b']);
  assert.deepEqual((await d.dispatch('scene.select', { ids: [] })).selectedIds, []);
});

test('scene.remove: confirm gate, ids validated, goes through history (undoable)', async () => {
  const { d, log } = setup();
  assert.equal(await code(d.dispatch('scene.remove', { ids: ['a'] })), 'E_CONFIRM_REQUIRED');
  assert.equal(await code(d.dispatch('scene.remove', { ids: ['zz'], confirm: true })), 'E_NOT_FOUND');
  assert.ok(!log.some(l => l.startsWith('push:')));
  const r = await d.dispatch('scene.remove', { ids: ['a2', 'b'], confirm: true });
  assert.deepEqual(r, { removed: ['a', 'b'], undoable: true });
  assert.ok(log.includes('push:del:a,b'));
});

test('scene.transform: id validated, pushed via history, no-op reported', async () => {
  const { d, log } = setup();
  assert.equal(await code(d.dispatch('scene.transform', { id: 'zz', position_mm: [1, 2, 3] })), 'E_NOT_FOUND');
  assert.equal(await code(d.dispatch('scene.transform', { id: 'a' })), 'E_INVALID_PARAMS');
  const r = await d.dispatch('scene.transform', { id: 'a', position_mm: [1, 2, 3] });
  assert.deepEqual(r, { id: 'a', changed: true, undoable: true });
  assert.ok(log.includes('push:xf:a'));
  const none = await d.dispatch('scene.transform', { id: 'a', scale: 2 });
  assert.equal(none.changed, false);
});

test('project.new / project.open: E_DIRTY unless confirm, confirm discards without a dialog', async () => {
  const s = setup();
  s.setDirty(true);
  assert.equal(await code(s.d.dispatch('project.new', {})), 'E_DIRTY');
  assert.equal(await code(s.d.dispatch('project.open', { file: ref('p.mixo', 'PT') })), 'E_DIRTY');
  assert.ok(!s.log.includes('new'));
  await s.d.dispatch('project.new', { confirm: true });
  assert.deepEqual(s.log.filter(l => l === 'discard' || l === 'new'), ['discard', 'new']);
  const info = await s.d.dispatch('project.open', { file: ref('p.mixo', 'PT') });
  assert.ok(s.log.includes('open:PT:PT.mixo'));
  assert.equal(info.dirty, false);
});

test('project.open on clean project needs no confirm; unreadable file -> E_NOT_FOUND', async () => {
  const s = setup();
  await s.d.dispatch('project.open', { file: ref('p.mixo', 'PT') });
  assert.ok(s.log.includes('open:PT:PT.mixo'));
  const u = setup({ unreadable: true });
  assert.equal(await code(u.d.dispatch('project.open', { file: ref('p.mixo') })), 'E_NOT_FOUND');
});

test('project.save / saveAs', async () => {
  const s = setup();
  await s.d.dispatch('project.save', {});
  assert.ok(s.log.includes('save'));
  await s.d.dispatch('project.saveAs', { file: ref('o.mixo', 'OT') });
  assert.ok(s.log.includes('saveAs:OT'));
  const nt = setup({ hasTarget: false });
  assert.equal(await code(nt.d.dispatch('project.save', {})), 'E_UNSUPPORTED');
  const c = setup({ saveAsResult: false });
  assert.equal(await code(c.d.dispatch('project.saveAs', { file: ref('o.mixo') })), 'E_CANCELLED');
});

test('library.mount / library.list return names only', async () => {
  const { d, log } = setup();
  await d.dispatch('library.mount', { dir: ref('lib', 'DT') });
  assert.ok(log.includes('mount:DT'));
  const r = await d.dispatch('library.list', {});
  assert.deepEqual(r.entries, [{ name: 'x.stl', kind: 'file' }]);
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(await code(d.dispatch('library.list', { subdir: 'missing' })), 'E_NOT_FOUND');
});

test('printer.list/get/set: unknown id E_NOT_FOUND, set goes through history', async () => {
  const { d, log } = setup();
  assert.equal((await d.dispatch('printer.list', {})).current, 'p1');
  assert.equal((await d.dispatch('printer.get', {})).id, 'p1');
  assert.equal(await code(d.dispatch('printer.set', { id: 'zz' })), 'E_NOT_FOUND');
  await d.dispatch('printer.set', { id: 'p1' });
  assert.ok(log.includes('push:printer:p1'));
});

test('validate.run: all parts and by id (ids validated)', async () => {
  const { d } = setup();
  const all = await d.dispatch('validate.run', {});
  assert.equal(all.errors, 1);
  assert.equal(all.objects[0].id, 'a');
  const one = await d.dispatch('validate.run', { ids: ['b'] });
  assert.equal(one.warnings, 1);
  assert.equal(await code(d.dispatch('validate.run', { ids: ['zz'] })), 'E_NOT_FOUND');
});

test('repair.run: confirm gate; before/after report; error text scrubbed of paths', async () => {
  const { d, log } = setup();
  assert.equal(await code(d.dispatch('repair.run', {})), 'E_CONFIRM_REQUIRED');
  assert.ok(!log.some(l => l.startsWith('repair:')));
  const r = await d.dispatch('repair.run', { ids: ['a', 'b'], confirm: true });
  assert.ok(log.includes('repair:a,b'));
  assert.deepEqual(r.before, { errors: 0, warnings: 2 });
  assert.equal(r.holesFilled, 2);
  assert.ok(!JSON.stringify(r).includes('C:\\'));
  assert.match(r.failed[0].error, /b\.stl/);
  assert.match(r.note, /nondeterministic/);
});

test('readiness.get / cost.quote', async () => {
  const { d, log } = setup();
  assert.equal((await d.dispatch('readiness.get', {})).canExport, true);
  const q = await d.dispatch('cost.quote', { ids: ['a'], options: { pricePerGram: 0.5 } });
  assert.equal(q.quotes[0].total, 50);
  assert.equal(q.quotes[0].material, 'pla');
  assert.ok(log.includes('ctx:a'));
  assert.equal(await code(d.dispatch('cost.quote', { options: { pricePerGram: -1 } })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('cost.quote', { options: { evil: 1 } })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('cost.quote', { ids: ['zz'] })), 'E_NOT_FOUND');
});

test('export.run: bytes returned unchanged from collectExportFiles; format + option checks', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const { d, log } = setup({ bytes });
  const r = await d.dispatch('export.run', { formats: ['stl', 'stl'], outDir: ref('out', 'OD'), selectedOnly: true, options: { acknowledgeWarnings: true } });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'a.stl');
  assert.equal(r[0].bytes, bytes);   // same reference: not re-encoded
  assert.deepEqual(Object.keys(r[0]).sort(), ['bytes', 'name']);
  assert.ok(log.includes('export:stl:{"acknowledgeWarnings":true,"selectedOnly":true}'));
  assert.equal(await code(d.dispatch('export.run', { formats: ['dxf'], outDir: ref('o') })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('export.run', { formats: ['stl'], outDir: ref('o'), options: { sink: true } })), 'E_INVALID_PARAMS');
  assert.equal(await code(d.dispatch('export.run', { formats: ['stl'], outDir: '/abs/dir' })), 'E_PATH_REJECTED');
});

test('export.run: gate blocked -> E_EXPORT_GATE with issues, nothing returned', async () => {
  const { d } = setup({ exportResult: { blocked: true, code: 'EXPORT_BLOCKED', readinessIssues: [{ code: 'geometry-error' }] } });
  const e = await d.dispatch('export.run', { formats: ['stl'], outDir: ref('o') }).catch(x => x);
  assert.equal(e.data.code, 'E_EXPORT_GATE');
  assert.equal(e.data.gate, 'EXPORT_BLOCKED');
  assert.equal(e.data.issues[0].code, 'geometry-error');
});

test('render.png / render.thumbnail return PNG bytes', async () => {
  const { d, log } = setup();
  const r = await d.dispatch('render.png', { outFile: ref('o.png'), width: 800, height: 600, preset: 'transparent' });
  assert.deepEqual([...r.bytes], [137, 80, 78, 71]);
  assert.equal(r.name, 'render.png');
  assert.ok(log.includes('png:{"width":800,"height":600,"transparent":true}'));
  assert.equal(await code(d.dispatch('render.png', { outFile: ref('o.png'), preset: 'weird' })), 'E_INVALID_PARAMS');
  const t = await d.dispatch('render.thumbnail', { outFile: ref('t.png'), size: 256 });
  assert.deepEqual([...t.bytes], [137, 80]);
  assert.ok(log.includes('thumb:{"size":256}'));
});

test('events: only subscribed types are forwarded; resubscribe replaces; dispose unsubscribes', async () => {
  const s = setup();
  s.fire(EVENTS.OBJECT_REMOVED, { id: 'a' });
  assert.equal(s.notes.length, 0);   // not subscribed yet
  const r = await s.d.dispatch('events.subscribe', { events: ['objectRemoved', 'selectionChanged'] });
  assert.deepEqual(r.subscribed, ['objectRemoved', 'selectionChanged']);
  s.fire(EVENTS.OBJECT_REMOVED, { id: 'a' });
  s.fire(EVENTS.SELECTION_CHANGED, { selectedIds: ['b'], activeId: 'b' });
  s.fire(EVENTS.PROJECT_SAVED, {});
  assert.deepEqual(s.notes.map(n => n.type), ['objectRemoved', 'selectionChanged']);
  assert.deepEqual(s.notes[1].data, { selectedIds: ['b'], activeId: 'b' });
  await s.d.dispatch('events.subscribe', { events: ['projectSaved'] });
  s.fire(EVENTS.OBJECT_REMOVED, { id: 'b' });
  s.fire(EVENTS.PROJECT_SAVED, {});
  assert.equal(s.notes.length, 3);
  assert.equal(s.notes[2].type, 'projectSaved');
  s.d.dispose();
  assert.equal(s.listenerCount(), 0);
});

test('events: objectAdded skips internal parts; validationDone counts; busy + exportDone emitted', async () => {
  const s = setup();
  await s.d.dispatch('events.subscribe', {});
  s.fire(EVENTS.ASSET_INSTANTIATED, { meshId: 'a2', meshName: 'x' });
  s.fire(EVENTS.ASSET_INSTANTIATED, { meshId: 'b', meshName: 'Beta' });
  s.fire(EVENTS.VALIDATION_COMPLETE, { meshId: 'b', results: [{ severity: 'error' }, { severity: 'warning' }, { severity: 'warning' }] });
  assert.deepEqual(s.notes.map(n => n.type), ['objectAdded', 'validationDone']);
  assert.deepEqual(s.notes[1].data, { id: 'b', name: null, errors: 1, warnings: 2 });
  s.notes.length = 0;
  await s.d.dispatch('export.run', { formats: ['stl'], outDir: ref('o') });
  assert.deepEqual(s.notes.map(n => n.type), ['busy', 'exportDone', 'busy']);
  assert.equal(s.notes[0].data.busy, true);
  assert.equal(s.notes[2].data.busy, false);
  assert.deepEqual(s.notes[1].data.files, ['a.stl']);
});

test('events: 50/s cap, drops counted, window resets', async () => {
  const s = setup();
  await s.d.dispatch('events.subscribe', { events: ['objectRemoved'] });
  for (let i = 0; i < 80; i++) s.fire(EVENTS.OBJECT_REMOVED, { id: `x${i}` });
  assert.equal(s.notes.length, 50);
  s.tick(1000);
  s.fire(EVENTS.OBJECT_REMOVED, { id: 'late' });
  assert.equal(s.notes.length, 51);
  assert.equal(s.notes[50].dropped, 30);
  assert.equal(s.notes[50].data.id, 'late');
});

test('events.subscribe rejects unknown event names', async () => {
  const { d } = setup();
  assert.equal(await code(d.dispatch('events.subscribe', { events: ['bogus'] })), 'E_INVALID_PARAMS');
});

test('non-api exceptions become E_INTERNAL with absolute paths scrubbed', async () => {
  const { d } = setup({ deps: { exporter: { formats: ['stl'], collectExportFiles: async () => { throw new Error('ENOENT: C:\\Users\\me\\secret\\x.stl and /home/me/y.obj'); } } } });
  const e = await d.dispatch('export.run', { formats: ['stl'], outDir: ref('o') }).catch(x => x);
  assert.equal(e.data.code, 'E_INTERNAL');
  assert.ok(!/Users|home\/me/.test(e.message), e.message);
  assert.match(e.message, /x\.stl/);
});

test('scrubPaths', () => {
  assert.equal(scrubPaths('open C:\\a\\b\\c.mixo failed'), 'open c.mixo failed');
  assert.equal(scrubPaths('bad \\\\srv\\share\\f.stl'), 'bad f.stl');
  assert.equal(scrubPaths('and/or fine'), 'and/or fine');
});

test('scene.import: a cancelled request aborts the import it already started (F-08)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let signal = null;
  const { d } = setup({ deps: { importPicked: async (_picked, opts) => { signal = opts?.signal ?? null; await gate; } } });
  const caller = new AbortController();
  const req = d.dispatch('scene.import', { files: [ref('a.stl')] }, { signal: caller.signal }).catch(e => e);
  for (let i = 0; i < 5 && !signal; i++) await new Promise(r => setImmediate(r));
  caller.abort();
  assert.equal(signal?.aborted, true, 'the running import sees the cancel');
  release();
  await req;
});
