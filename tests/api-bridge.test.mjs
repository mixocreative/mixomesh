import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiBridge, TOAST_MIN_INTERVAL_MS } from '../src/core/api/ApiBridge.js';
import { apiError } from '../src/core/api/ApiErrors.js';

function setup({ dispatch, bridge = {} } = {}) {
  const responses = [];
  const notes = [];
  const toasts = [];
  const timers = [];
  let clock = 10_000;
  let extra = null;
  const fake = {
    onApiRequest(cb) { fake.cb = cb; return () => { fake.off = true; }; },
    respondApi: async r => { responses.push(r); },
    notifyApi: async e => { notes.push(e); },
    ...bridge,
  };
  const api = createApiBridge({
    bridge: fake,
    createDispatcher: async e => { extra = e; return { dispatch: dispatch ?? (async () => ({ ok: true })) }; },
    toast: (m, type) => toasts.push({ m, type }),
    now: () => clock,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { api, fake, responses, notes, toasts, timers, extra: () => extra, tick: ms => { clock += ms; } };
}

test('request -> dispatcher -> respondApi result', async () => {
  const calls = [];
  const s = setup({ dispatch: async (m, p) => { calls.push([m, p]); return { n: 1 }; } });
  s.api.init();
  await s.api.handle({ id: 7, method: 'scene.list', params: { a: 1 } });
  assert.deepEqual(calls, [['scene.list', { a: 1 }]]);
  assert.deepEqual(s.responses, [{ id: 7, result: { n: 1 } }]);
  assert.equal(s.toasts.length, 0);   // read-only: no toast
});

test('api error object is passed through as error', async () => {
  const err = apiError('E_NOT_FOUND', 'nope');
  const s = setup({ dispatch: async () => { throw err; } });
  await s.api.handle({ id: 1, method: 'x', params: {} });
  assert.deepEqual(s.responses, [{ id: 1, error: err }]);
});

test('thrown non-api error -> E_INTERNAL without paths', async () => {
  const s = setup({ dispatch: async () => { throw new Error(String.raw`boom at C:\Users\bob\secret\file.glb and /home/bob/x/y.stl`); } });
  await s.api.handle({ id: 2, method: 'x', params: {} });
  const e = s.responses[0].error;
  assert.equal(e.data.code, 'E_INTERNAL');
  assert.ok(!/Users|bob|home|[\\/]/.test(e.message), e.message);
  assert.match(e.message, /file\.glb/);
});

test('dispatcher factory failure is answered, not thrown', async () => {
  const responses = [];
  const api = createApiBridge({
    bridge: { respondApi: async r => { responses.push(r); } },
    createDispatcher: async () => { throw new Error(String.raw`init failed in D:\app\x.js`); },
  });
  await api.handle({ id: 3, method: 'x' });
  assert.equal(responses[0].error.data.code, 'E_INTERNAL');
  assert.ok(!/D:|app[\\/]/.test(responses[0].error.message));
});

test('respondApi rejecting never escapes', async () => {
  const s = setup({ bridge: { respondApi: async () => { throw new Error('ipc closed'); } } });
  await s.api.handle({ id: 4, method: 'x', params: {} });
});

test('notifications are forwarded through notifyApi', async () => {
  const s = setup();
  await s.api.handle({ id: 1, method: 'x', params: {} });
  s.extra().notify({ type: 'busy', data: { busy: true } });
  assert.deepEqual(s.notes, [{ type: 'busy', data: { busy: true } }]);
});

test('no-op without bridge methods', () => {
  const api = createApiBridge({ bridge: {}, createDispatcher: () => { throw new Error('must not build'); } });
  const off = api.init();
  assert.equal(typeof off, 'function');
  off();
});

test('init subscribes and routes requests; unsubscribe returned', async () => {
  const s = setup();
  const off = s.api.init();
  s.fake.cb({ id: 9, method: 'app.ping', params: {} });
  await new Promise(r => setImmediate(r));
  assert.equal(s.responses[0].id, 9);
  off();
  assert.equal(s.fake.off, true);
});

test('toasts: first immediate, then coalesced into one per 2 s window', async () => {
  const s = setup({ dispatch: async m => (m === 'scene.import' ? { added: [{}, {}, {}] } : [{ name: 'a.stl' }, { name: 'b.3mf' }]) });
  await s.api.handle({ id: 1, method: 'scene.import', params: {} });
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0].m, 'External request: imported 3 files');
  await s.api.handle({ id: 2, method: 'export.run', params: {} });
  await s.api.handle({ id: 3, method: 'scene.import', params: {} });
  assert.equal(s.toasts.length, 1);          // rate limited
  assert.equal(s.timers.length, 1);          // single flush timer
  assert.ok(s.timers[0].ms <= TOAST_MIN_INTERVAL_MS && s.timers[0].ms > 0);
  s.tick(TOAST_MIN_INTERVAL_MS);
  s.timers[0].fn();
  assert.equal(s.toasts.length, 2);
  assert.equal(s.toasts[1].m, 'External request: imported 3 files, exported 2 files');
});

test('failed mutating call does not toast', async () => {
  const s = setup({ dispatch: async () => { throw apiError('E_BUSY', 'busy'); } });
  await s.api.handle({ id: 1, method: 'scene.import', params: {} });
  assert.equal(s.toasts.length, 0);
});
