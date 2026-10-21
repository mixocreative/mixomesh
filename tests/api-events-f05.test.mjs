// cia F-05: one pipe client's events.subscribe must never change another client's event
// stream, and one chatty subscriber must not use up another client's event budget.
// Real ApiServer (fake socket) wired to the real renderer dispatcher.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import nodeCrypto from 'node:crypto';
import { createDispatcher } from '../src/core/api/ApiDispatcher.js';

const require = createRequire(import.meta.url);
const { createApiServer } = require('../electron/ApiServer.cjs');

const EVENTS = { SELECTION_CHANGED: 'sel', ASSET_INSTANTIATED: 'inst' };

function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.write = d => { s.written.push(String(d)); return true; };
  s.end = d => { if (d) s.written.push(String(d)); };
  s.destroy = () => {};
  s.frames = () => s.written.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
  s.events = type => s.frames().filter(f => f.method === 'event' && f.params.type === type);
  s.feed = obj => s.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
  return s;
}

async function setup() {
  const listeners = new Map();
  const files = new Map();
  let handler = null;
  let clock = 1_000_000;
  let server = null;
  const renderer = createDispatcher({
    state: {
      getState: () => ({ scene: { objects: {} } }),
      subscribe: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => listeners.get(name).delete(fn);
      },
    },
    EVENTS,
    persistence: { isDirty: () => false },
    notify: evt => server.notify(evt),
    now: () => clock,
    isBusy: () => false, sleep: async () => {},
  });
  server = createApiServer({
    net: { createServer: h => { handler = h; return { once() {}, removeListener() {}, listen(_p, cb) { cb(); }, close(cb) { cb(); } }; } },
    fs: {
      mkdir: async () => {}, writeFile: async (p, d) => { files.set(p, String(d)); },
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, unlink: async () => {},
    },
    crypto: nodeCrypto,
    dispatch: (m, p) => renderer.dispatch(m, p),
    userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\MIXOMESH', username: 'u', pid: 1,
    now: () => clock,
  });
  await server.start();
  const token = JSON.parse([...files.values()][0]).token;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const client = async () => {
    const s = fakeSocket();
    handler(s);
    s.feed({ jsonrpc: '2.0', id: 'h', method: 'hello', params: { token, apiVersion: 1 } });
    await settle();
    return s;
  };
  const fire = (name, payload) => [...(listeners.get(name) ?? [])].forEach(f => f(payload));
  return { client, settle, fire, tick: ms => { clock += ms; } };
}

test('a second client subscribing to other events does not silence the first', async () => {
  const s = await setup();
  const a = await s.client();
  const b = await s.client();
  a.feed({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: { events: ['selectionChanged'] } });
  await s.settle();
  b.feed({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: { events: ['objectAdded'] } });
  await s.settle();

  assert.deepEqual(a.frames().find(f => f.id === 1).result.subscribed, ['selectionChanged']);
  assert.deepEqual(b.frames().find(f => f.id === 1).result.subscribed, ['objectAdded']);

  s.fire('sel', { selectedIds: ['x'], activeId: 'x' });
  s.fire('inst', { meshId: 'm1', meshName: 'M1' });
  await s.settle();
  assert.equal(a.events('selectionChanged').length, 1, 'A still receives its selection events');
  assert.equal(a.events('objectAdded').length, 0, 'A never receives what only B asked for');
  assert.equal(b.events('objectAdded').length, 1);
  assert.equal(b.events('selectionChanged').length, 0);
});

test("one client's event flood does not drop another client's events", async () => {
  const s = await setup();
  const a = await s.client();
  const b = await s.client();
  a.feed({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: { events: ['selectionChanged'] } });
  b.feed({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: { events: ['objectAdded'] } });
  await s.settle();
  for (let i = 0; i < 80; i++) s.fire('inst', { meshId: `m${i}` });
  s.fire('sel', { selectedIds: ['x'], activeId: 'x' });
  await s.settle();
  assert.equal(a.events('selectionChanged').length, 1);
  assert.equal(b.events('objectAdded').length, 50, 'B is capped at its own 50 events per second');
});
