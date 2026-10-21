// cia F-08: a pipe request whose client disconnects (or that times out) is cancelled: main
// writes no late output files, and the renderer drops the request if it has not started.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import nodeCrypto from 'node:crypto';
import nodePath from 'node:path';
import { createApiBridge } from '../src/core/api/ApiBridge.js';
import { createDispatcher } from '../src/core/api/ApiDispatcher.js';

const require = createRequire(import.meta.url);
const { createApiServer } = require('../electron/ApiServer.cjs');
const win = nodePath.win32;

function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.write = d => { s.written.push(String(d)); return true; };
  s.end = d => { if (d) s.written.push(String(d)); };
  s.destroy = () => {};
  s.feed = obj => s.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
  return s;
}

async function serverWith(dispatch) {
  const files = new Map();
  const dirs = new Set(['c:\\', 'c:\\out']);
  const key = p => win.resolve(p).toLowerCase();
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  let handler = null;
  const timers = [];
  const server = createApiServer({
    net: { createServer: h => { handler = h; return { once() {}, removeListener() {}, listen(_p, cb) { cb(); }, close(cb) { cb(); } }; } },
    fs: {
      mkdir: async p => { dirs.add(key(p)); },
      writeFile: async (p, d) => { files.set(key(p), Buffer.from(d)); },
      rename: async (a, b) => { files.set(key(b), files.get(key(a))); files.delete(key(a)); },
      unlink: async p => { files.delete(key(p)); },
      realpath: async p => { if (files.has(key(p)) || dirs.has(key(p))) return win.resolve(p); throw enoent(); },
      stat: async p => {
        if (files.has(key(p))) return { isFile: () => true, isDirectory: () => false, size: files.get(key(p)).length };
        if (dirs.has(key(p))) return { isFile: () => false, isDirectory: () => true, size: 0 };
        throw enoent();
      },
      access: async () => {},
    },
    crypto: nodeCrypto,
    dispatch,
    userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\MIXOMESH', username: 'u', pid: 1,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; },
    registerFile: (p, n) => ({ ref: 'r1', name: n }),
    registerMount: (p, n) => ({ ref: 'm1', name: n }),
  });
  await server.start();
  const session = [...files.entries()].find(([k]) => k.endsWith('session.json'));
  const token = JSON.parse(session[1].toString()).token;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const client = async () => {
    const s = fakeSocket();
    handler(s);
    s.feed({ jsonrpc: '2.0', id: 'h', method: 'hello', params: { token, apiVersion: 1 } });
    await settle();
    return s;
  };
  const fireTimeout = ms => { for (const t of timers.filter(x => !x.cleared && x.ms === ms)) { t.cleared = true; t.fn(); } };
  return { files, client, settle, fireTimeout, outputs: () => [...files.keys()].filter(k => k.startsWith('c:\\out\\')) };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('client disconnects mid-render: no file is written late, and the app is told to cancel', async () => {
  const gate = deferred();
  const seen = [];
  const s = await serverWith(async (method, params, opts) => {
    seen.push(opts?.signal);
    await gate.promise;
    return { name: 'shot.png', bytes: new Uint8Array([137, 80, 78, 71]) };
  });
  const sock = await s.client();
  sock.feed({ jsonrpc: '2.0', id: 1, method: 'render.png', params: { outFile: 'C:\\out\\shot.png' } });
  await s.settle();
  sock.emit('close');
  gate.resolve();
  await s.settle();
  assert.deepEqual(s.outputs(), [], 'no output written for a client that is gone');
  assert.equal(seen[0]?.aborted, true, 'the dispatch was signalled to cancel');
});

test('a request that times out signals cancel to the app', async () => {
  const seen = [];
  const s = await serverWith(async (method, params, opts) => { seen.push(opts?.signal); return new Promise(() => {}); });
  const sock = await s.client();
  sock.feed({ jsonrpc: '2.0', id: 1, method: 'scene.list', params: {} });
  await s.settle();
  s.fireTimeout(10 * 60 * 1000);
  await s.settle();
  assert.equal(seen[0]?.aborted, true);
});

test('renderer: a cancelled request that has not started never runs and answers E_CANCELLED', async () => {
  const ran = [];
  const responses = [];
  let release;
  const blocker = new Promise(r => { release = r; });
  const dispatcher = createDispatcher({
    state: { getState: () => ({ scene: { objects: {} }, project: {} }), subscribe: () => () => {} },
    persistence: { isDirty: () => false, hasSaveTarget: () => true, save: async () => { ran.push('save'); await blocker; return true; } },
    importPicked: async () => { ran.push('import'); },
    isBusy: () => false, sleep: async () => {},
  });
  const bridge = createApiBridge({
    bridge: { onApiRequest: () => () => {}, respondApi: async r => { responses.push(r); } },
    createDispatcher: async () => dispatcher,
  });
  const first = bridge.handle({ id: 'r1', method: 'project.save', params: {} });
  const second = bridge.handle({ id: 'r2', method: 'scene.import', params: { files: [{ ref: 't', name: 'a.stl' }] } });
  await new Promise(r => setImmediate(r));
  await bridge.handle({ cancel: 'r2' });
  release();
  await first;
  await second;
  assert.deepEqual(ran, ['save'], 'the queued import never ran');
  assert.equal(responses.find(r => r.id === 'r2')?.error?.data?.code, 'E_CANCELLED');
  assert.equal(responses.filter(r => r.id === undefined).length, 0, 'a cancel message gets no response of its own');
});
