import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import nodeCrypto from 'node:crypto';
import nodePath from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../electron/ApiServer.cjs');
const { API_VERSION: SCHEMA_VERSION, ERROR_CODES: SCHEMA_CODES } = await import('../src/core/api/ApiErrors.js');
const { METHODS, EVENT_TYPES: SCHEMA_EVENTS, LIMITS: SCHEMA_LIMITS } = await import('../src/core/api/ApiSchema.js');
const { MAX_API_IMPORTS } = require('../electron/LaunchArgs.cjs');

const win = nodePath.win32;
const USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\MIXOMESH';
const ABS_RE = /[a-zA-Z]:[\\/]|\\\\|\\|(^|["'\s:,])\/[A-Za-z]/;

// ---- fakes -----------------------------------------------------------------
function fakeFs(seedDirs = [], seedFiles = {}) {
  const dirs = new Set(['C:\\', USER_DATA, ...seedDirs].map(d => win.resolve(d).toLowerCase()));
  const files = new Map(Object.entries(seedFiles).map(([k, v]) => [win.resolve(k).toLowerCase(), Buffer.from(v)]));
  const key = p => win.resolve(p).toLowerCase();
  const ops = [];
  const notFound = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    dirs, files, ops,
    mkdir: async p => { ops.push(['mkdir', p]); dirs.add(key(p)); },
    writeFile: async (p, data, opts) => {
      ops.push(['writeFile', p, opts]);
      if (opts?.flag === 'wx' && files.has(key(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      files.set(key(p), Buffer.from(data));
    },
    rename: async (a, b) => { ops.push(['rename', a, b]); files.set(key(b), files.get(key(a))); files.delete(key(a)); },
    unlink: async p => { ops.push(['unlink', p]); if (!files.delete(key(p))) throw notFound(); },
    realpath: async p => { const k = key(p); if (files.has(k) || dirs.has(k)) return win.resolve(p); throw notFound(); },
    stat: async p => {
      const k = key(p);
      if (files.has(k)) return { isFile: () => true, isDirectory: () => false, size: files.get(k).length };
      if (dirs.has(k)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      throw notFound();
    },
    access: async () => {},
  };
}

function fakeSocket() {
  const s = new EventEmitter();
  s.written = []; s.ended = false; s.destroyed = false;
  s.write = d => { s.written.push(String(d)); return true; };
  s.end = d => { if (d) s.written.push(String(d)); s.ended = true; };
  s.destroy = () => { s.destroyed = true; };
  s.frames = () => s.written.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
  s.feed = obj => s.emit('data', Buffer.from(typeof obj === 'string' ? obj : `${JSON.stringify(obj)}\n`));
  return s;
}

function fakeNet() {
  const net = { listenedOn: null, closed: false };
  net.createServer = handler => {
    net.handler = handler;
    return { once() {}, removeListener() {}, listen(p, cb) { net.listenedOn = p; cb(); }, close(cb) { net.closed = true; cb(); } };
  };
  net.connect = () => { const s = fakeSocket(); net.handler(s); return s; };
  return net;
}

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; },
    fire: ms => { for (const t of timers.filter(x => !x.cleared && x.ms === ms)) { t.cleared = true; t.fn(); } },
  };
}

function build(over = {}) {
  const net = fakeNet();
  const fs = over.fs ?? fakeFs(['C:\\in', 'C:\\out'], { 'C:\\in\\a.glb': 'GLB', 'C:\\in\\b.stl': 'STL', 'C:\\in\\p.mixo': 'MIXO', 'C:\\out\\exists.png': 'old' });
  const clock = fakeClock();
  const calls = [];
  const registered = [];
  const timingCalls = [];
  const crypto = {
    randomBytes: n => nodeCrypto.randomBytes(n),
    createHash: a => nodeCrypto.createHash(a),
    timingSafeEqual: (a, b) => { timingCalls.push([a.length, b.length]); return nodeCrypto.timingSafeEqual(a, b); },
  };
  const dispatch = over.dispatch ?? (async (method, params) => { calls.push({ method, params }); return { ok: true }; });
  const wrapped = over.dispatch ? async (m, p) => { calls.push({ method: m, params: p }); return over.dispatch(m, p); } : dispatch;
  const server = S.createApiServer({
    net, fs, crypto, dispatch: wrapped, userDataDir: USER_DATA, username: 'u', pid: 4242,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    registerFile: (p, n, o) => { registered.push({ kind: 'file', p, n, o }); return { ref: `ref_${registered.length}`, name: n }; },
    registerMount: (p, n) => { registered.push({ kind: 'mount', p, n }); return { ref: `mount_${registered.length}`, name: n }; },
    limits: over.limits,
  });
  return { net, fs, clock, calls, registered, timingCalls, server };
}

async function connected(ctx, { auth = true } = {}) {
  const sock = ctx.net.connect();
  if (auth) {
    const sess = JSON.parse(ctx.fs.files.get(win.resolve(ctx.server.sessionFile).toLowerCase()).toString());
    sock.feed({ jsonrpc: '2.0', method: 'hello', params: { token: sess.token, apiVersion: 1 }, id: 'h' });
    await tick();
    assert.equal(sock.frames()[0].result.authenticated, true);
  }
  return sock;
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const rpc = (sock, id, method, params) => sock.feed({ jsonrpc: '2.0', id, method, params });
const reply = (sock, id) => sock.frames().find(f => f.id === id);
const sessionOf = ctx => JSON.parse(ctx.fs.files.get(win.resolve(ctx.server.sessionFile).toLowerCase()).toString());

// ---- pins to the real schema -------------------------------------------------
test('mirrored constants equal ApiErrors/ApiSchema', () => {
  assert.equal(S.API_VERSION, SCHEMA_VERSION);
  assert.deepEqual(S.ERROR_CODES, { ...SCHEMA_CODES });
  assert.deepEqual([...S.METHOD_NAMES], METHODS.map(m => m.name));
  assert.deepEqual([...S.EVENT_TYPES], [...SCHEMA_EVENTS]);
  assert.equal(MAX_API_IMPORTS, SCHEMA_LIMITS.maxImportFiles);
  // needsPath flags and path keys agree with the schema
  const needs = METHODS.filter(m => m.needsPath).map(m => m.name).sort();
  assert.deepEqual(Object.keys(S.PATH_METHODS).sort(), needs);
  for (const m of METHODS.filter(x => x.needsPath)) {
    const spec = S.PATH_METHODS[m.name];
    assert.ok(m.params[spec.pathKey]?.type === 'path' || m.params[spec.pathKey]?.item === 'path', m.name);
    for (const k of Object.keys(m.params)) assert.ok(k === spec.pathKey || spec.allow.includes(k), `${m.name}.${k}`);
  }
  assert.equal(S.LIMITS.maxClients, 4);
  assert.equal(S.LIMITS.maxFrameBytes, 1048576);
  assert.equal(S.LIMITS.requestTimeoutMs, 600000);
});

// ---- lifecycle ---------------------------------------------------------------
test('pipe name and session file lifecycle', async () => {
  const ctx = build();
  const expectHash = nodeCrypto.createHash('sha256').update('u' + USER_DATA).digest('hex').slice(0, 16);
  assert.equal(ctx.server.pipe, `\\\\.\\pipe\\mixomesh-${expectHash}`);
  await ctx.server.start();
  assert.equal(ctx.net.listenedOn, ctx.server.pipe);
  const sess = sessionOf(ctx);
  assert.deepEqual(Object.keys(sess).sort(), ['apiVersion', 'pid', 'pipe', 'token']);
  assert.equal(sess.pipe, ctx.server.pipe);
  assert.equal(sess.pid, 4242);
  assert.equal(sess.apiVersion, 1);
  assert.match(sess.token, /^[0-9a-f]{64}$/);
  // temp + rename, user-only mode, directory created under userData only
  const w = ctx.fs.ops.find(o => o[0] === 'writeFile');
  const r = ctx.fs.ops.find(o => o[0] === 'rename');
  assert.equal(w[2].mode, 0o600);
  assert.ok(w[1].endsWith('.tmp') && r[1] === w[1] && r[2] === ctx.server.sessionFile);
  assert.ok(ctx.server.sessionFile.startsWith(USER_DATA + '\\api\\'));
  assert.ok(!ctx.fs.files.has(w[1].toLowerCase()));
  await ctx.server.stop();
  assert.equal(ctx.fs.files.has(win.resolve(ctx.server.sessionFile).toLowerCase()), false);
  assert.equal(ctx.net.closed, true);
});

test('two starts mint different tokens', async () => {
  const a = build(); const b = build();
  await a.server.start(); await b.server.start();
  assert.notEqual(sessionOf(a).token, sessionOf(b).token);
});

// ---- hello / token -----------------------------------------------------------
test('hello is required first; other first frame closes', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = ctx.net.connect();
  rpc(sock, 1, 'app.ping', {});
  await settle();
  assert.equal(sock.ended, true);
  assert.equal(sock.frames()[0].error.data.reason, 'hello-required');
  assert.equal(ctx.calls.length, 0);
});

test('wrong, missing and wrong-length tokens close the socket', async () => {
  const ctx = build(); await ctx.server.start();
  for (const params of [{ token: 'x'.repeat(64), apiVersion: 1 }, { token: 'short', apiVersion: 1 }, { apiVersion: 1 }, undefined]) {
    const sock = ctx.net.connect();
    sock.feed({ jsonrpc: '2.0', method: 'hello', params, id: 1 });
    await settle();
    assert.equal(sock.ended, true);
    assert.equal(sock.frames()[0].error.data.reason, 'bad-token');
  }
  assert.equal(ctx.calls.length, 0);
});

test('token compare uses timingSafeEqual (including on length mismatch)', async () => {
  const ctx = build(); await ctx.server.start();
  const sess = sessionOf(ctx);
  const s1 = ctx.net.connect();
  s1.feed({ jsonrpc: '2.0', method: 'hello', params: { token: sess.token, apiVersion: 1 }, id: 1 });
  await settle();
  assert.deepEqual(ctx.timingCalls.at(-1), [64, 64]);
  const s2 = ctx.net.connect();
  s2.feed({ jsonrpc: '2.0', method: 'hello', params: { token: 'abc', apiVersion: 1 }, id: 1 });
  await settle();
  assert.equal(ctx.timingCalls.length, 2);
  assert.equal(s2.ended, true);
});

test('wrong apiVersion in hello is refused', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = ctx.net.connect();
  sock.feed({ jsonrpc: '2.0', method: 'hello', params: { token: sessionOf(ctx).token, apiVersion: 2 }, id: 1 });
  await settle();
  assert.equal(sock.frames()[0].error.data.code, 'E_UNSUPPORTED');
  assert.equal(sock.ended, true);
});

test('hello deadline closes silent connections', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = ctx.net.connect();
  ctx.clock.fire(S.LIMITS.helloTimeoutMs);
  assert.equal(sock.ended, true);
  assert.equal(sock.frames()[0].error.data.code, 'E_TIMEOUT');
});

test('token never appears in any server frame', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'app.ping', {}); await settle();
  assert.ok(!sock.written.join('').includes(sessionOf(ctx).token));
});

// ---- limits ------------------------------------------------------------------
test('frame cap: oversize line closes with error; oversize partial too', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  sock.feed(Buffer.alloc(S.LIMITS.maxFrameBytes + 1, 0x61).toString() + '\n');
  assert.equal(sock.ended, true);
  assert.equal(sock.frames().at(-1).error.data.code, 'E_LIMIT');
  const s2 = await connected(ctx);
  s2.feed(Buffer.alloc(S.LIMITS.maxFrameBytes + 1, 0x61).toString()); // no newline yet
  assert.equal(s2.ended, true);
  assert.equal(ctx.calls.length, 0);
});

test('frame exactly at cap is accepted; pre-auth cap is small', async () => {
  const ctx = build(); await ctx.server.start();
  const pre = ctx.net.connect();
  pre.feed('a'.repeat(S.LIMITS.maxPreAuthFrameBytes + 1) + '\n');
  assert.equal(pre.ended, true);
});

test('client cap: 5th is refused with E_LIMIT and closed', async () => {
  const ctx = build(); await ctx.server.start();
  const ok = [];
  for (let i = 0; i < 4; i++) ok.push(ctx.net.connect());
  assert.equal(ctx.server.clientCount, 4);
  const fifth = ctx.net.connect();
  assert.equal(fifth.ended, true);
  assert.equal(fifth.frames()[0].error.data.code, 'E_LIMIT');
  assert.ok(ok.every(s => !s.ended));
  ok[0].emit('close');
  const again = ctx.net.connect();
  assert.equal(again.ended, false);
});

test('per-request timeout returns E_TIMEOUT and the late result is not written', async () => {
  let release;
  const ctx = build({ dispatch: () => new Promise(r => { release = r; }) });
  await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 7, 'render.png', { outFile: 'C:\\out\\new.png' });
  await settle();
  ctx.clock.fire(S.LIMITS.requestTimeoutMs);
  await settle();
  assert.equal(reply(sock, 7).error.data.code, 'E_TIMEOUT');
  release(Buffer.from('PNG'));
  await settle();
  assert.equal(ctx.fs.files.has('c:\\out\\new.png'), false);
});

// ---- protocol robustness -----------------------------------------------------
test('malformed JSON after hello -> parse error, connection survives', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  sock.feed('{not json\n');
  await settle();
  const err = sock.frames().at(-1);
  assert.equal(err.error.code, -32700);
  assert.equal(err.id, null);
  assert.equal(sock.ended, false);
  rpc(sock, 2, 'app.ping', {}); await settle();
  assert.deepEqual(reply(sock, 2).result, { ok: true });
});

test('malformed JSON before hello closes', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = ctx.net.connect();
  sock.feed('garbage\n');
  assert.equal(sock.ended, true);
});

test('split frames, CRLF, batches, unknown method, dispatch throw', async () => {
  const ctx = build({ dispatch: async () => { throw new Error('C:\\secret\\path boom'); } });
  await ctx.server.start();
  const sock = await connected(ctx);
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'app.ping' });
  sock.feed(line.slice(0, 10)); sock.feed(line.slice(10) + '\r\n');
  await settle();
  const e = reply(sock, 1).error;
  assert.equal(e.data.code, 'E_INTERNAL');
  assert.ok(!JSON.stringify(e).includes('secret'));
  sock.feed('[]\n'); await settle();
  assert.equal(sock.frames().at(-1).error.code, -32600);
  rpc(sock, 3, 'nope.nope', {}); await settle();
  assert.equal(reply(sock, 3).error.data.code, 'E_METHOD_NOT_FOUND');
});

// ---- path rewriting ----------------------------------------------------------
test('scene.import rewrites paths to refs; read-only registration; renderer sees no path', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'scene.import', { files: ['C:\\in\\a.glb', 'C:\\in\\b.stl'] });
  await settle();
  assert.deepEqual(ctx.calls[0].params, { files: [{ ref: 'ref_1', name: 'a.glb' }, { ref: 'ref_2', name: 'b.stl' }] });
  assert.deepEqual(ctx.registered.map(r => r.o), [{ writable: false }, { writable: false }]);
  assert.equal(reply(sock, 1).result.ok, true);
});

test('library.mount -> registerMount; project.open -> writable file ref', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'library.mount', { dir: 'C:\\in' });
  rpc(sock, 2, 'project.open', { file: 'C:\\in\\p.mixo', confirm: true });
  await settle();
  assert.deepEqual(ctx.calls[0].params, { dir: { ref: 'mount_1', name: 'in' } });
  assert.deepEqual(ctx.calls[1].params, { file: { ref: 'ref_2', name: 'p.mixo' }, confirm: true });
  assert.deepEqual(ctx.registered[1].o, { writable: true });
});

test('input rejections: relative, UNC, device, missing, wrong ext, mixo import, >32, stray path field', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  const cases = [
    ['scene.import', { files: ['a.glb'] }],
    ['scene.import', { files: ['\\\\host\\share\\a.glb'] }],
    ['scene.import', { files: ['\\\\.\\pipe\\x'] }],
    ['scene.import', { files: ['C:\\in\\missing.glb'] }],
    ['scene.import', { files: ['C:\\in\\a.exe'] }],
    ['scene.import', { files: ['C:\\in\\p.mixo'] }],
    ['project.open', { file: 'C:\\in\\a.glb' }],
    ['scene.import', { files: ['C:\\in\\a.glb'], extra: 'C:\\in' }],
    ['library.list', { subdir: 'C:\\Windows' }],
    ['export.run', { formats: ['stl'], outDir: 'C:\\out', options: { p: 'D:\\x' } }],
  ];
  cases.forEach(([m, p], i) => rpc(sock, 100 + i, m, p));
  await settle();
  cases.forEach((c, i) => assert.ok(reply(sock, 100 + i).error, `case ${i} ${c[0]}`));
  assert.equal(reply(sock, 106).error.data.code, 'E_PATH_REJECTED');
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.registered.length, 0);
  const many = Array.from({ length: 33 }, () => 'C:\\in\\a.glb');
  rpc(sock, 200, 'scene.import', { files: many }); await settle();
  assert.equal(reply(sock, 200).error.data.code, 'E_LIMIT');
  // rejection messages are basename-only
  for (const f of sock.frames().filter(f => f.error?.data?.code === 'E_PATH_REJECTED')) {
    assert.ok(!/[A-Za-z]:\\|\\\\/.test(f.error.message), f.error.message);
  }
});

test('NO absolute path in any params object passed to dispatch', async () => {
  const ctx = build({ dispatch: async method => (method === 'export.run' ? [{ name: 'm.stl', bytes: new Uint8Array([1, 2]) }] : method.startsWith('render') ? new Uint8Array([9]) : { ok: true }) });
  await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'scene.import', { files: ['C:\\in\\a.glb'] });
  rpc(sock, 2, 'library.mount', { dir: 'C:\\in' });
  rpc(sock, 3, 'project.open', { file: 'C:\\in\\p.mixo' });
  rpc(sock, 4, 'export.run', { formats: ['stl'], outDir: 'C:\\out', selectedOnly: true });
  rpc(sock, 5, 'render.png', { outFile: 'C:\\out\\r.png', width: 64, height: 64 });
  rpc(sock, 6, 'render.thumbnail', { outFile: 'C:\\out\\t.png', size: 64 });
  rpc(sock, 7, 'scene.list', { includeValidation: true });
  await settle();
  assert.equal(ctx.calls.length, 7);
  for (const c of ctx.calls) assert.ok(!ABS_RE.test(JSON.stringify(c.params)), `${c.method} ${JSON.stringify(c.params)}`);
  const exp = ctx.calls.find(c => c.method === 'export.run');
  assert.deepEqual(exp.params, { formats: ['stl'], selectedOnly: true });
  assert.deepEqual(ctx.calls.find(c => c.method === 'render.png').params, { width: 64, height: 64 });
  assert.deepEqual(ctx.calls.find(c => c.method === 'render.thumbnail').params, { size: 64 });
});

// ---- output writes -----------------------------------------------------------
test('render.png: bytes written by server via temp + rename; caller gets absolute path', async () => {
  const ctx = build({ dispatch: async () => new Uint8Array([137, 80, 78, 71]) });
  await ctx.server.start();
  const sock = await connected(ctx);
  ctx.fs.ops.length = 0;
  rpc(sock, 1, 'render.png', { outFile: 'C:\\out\\shot.png' }); await settle();
  const res = reply(sock, 1).result;
  assert.equal(res.path, 'C:\\out\\shot.png');
  assert.equal(res.size, 4);
  const w = ctx.fs.ops.find(o => o[0] === 'writeFile');
  const r = ctx.fs.ops.find(o => o[0] === 'rename');
  assert.ok(w[1].startsWith('C:\\out\\shot.png.') && w[1].endsWith('.tmp'));
  assert.equal(w[2].flag, 'wx');
  assert.deepEqual([r[1], r[2]], [w[1], 'C:\\out\\shot.png']);
  assert.deepEqual([...ctx.fs.files.get('c:\\out\\shot.png')], [137, 80, 78, 71]);
  assert.ok(!ctx.fs.files.has(w[1].toLowerCase()));
});

test('overwrite refused by default (before dispatch), allowed with overwrite:true', async () => {
  const ctx = build({ dispatch: async () => ({ bytes: new Uint8Array([1]), extra: 'x' }) });
  await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'render.png', { outFile: 'C:\\out\\exists.png' }); await settle();
  const e = reply(sock, 1).error;
  assert.equal(e.data.code, 'E_PATH_REJECTED');
  assert.ok(e.message.startsWith('exists.png:') && !/[A-Za-z]:\\/.test(e.message));
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.fs.files.get('c:\\out\\exists.png').toString(), 'old');
  rpc(sock, 2, 'render.png', { outFile: 'C:\\out\\exists.png', overwrite: true }); await settle();
  assert.equal(reply(sock, 2).result.extra, 'x');
  assert.deepEqual([...ctx.fs.files.get('c:\\out\\exists.png')], [1]);
  rpc(sock, 3, 'render.png', { outFile: 'C:\\out\\exists.png', overwrite: 'yes' }); await settle();
  assert.equal(reply(sock, 3).error.data.code, 'E_INVALID_PARAMS');
});

test('file created between validate and write is still not overwritten', async () => {
  const ctx = build({ dispatch: async () => new Uint8Array([1]) });
  await ctx.server.start();
  const sock = await connected(ctx);
  // dispatch (slow path) creates the target behind our back
  ctx.fs.files.set('c:\\out\\race.png', Buffer.from('theirs'));
  const pre = ctx.net.connect; void pre;
  rpc(sock, 1, 'render.png', { outFile: 'C:\\out\\race.png' }); await settle();
  assert.equal(reply(sock, 1).error.data.code, 'E_PATH_REJECTED');
  assert.equal(ctx.fs.files.get('c:\\out\\race.png').toString(), 'theirs');
});

test('failed write cleans up its temp file', async () => {
  const fs = fakeFs(['C:\\out']);
  const ctx = build({ fs, dispatch: async () => new Uint8Array([1]) });
  await ctx.server.start();
  const sock = await connected(ctx);
  fs.rename = async () => { throw new Error('disk'); };
  rpc(sock, 1, 'render.png', { outFile: 'C:\\out\\z.png' }); await settle();
  assert.equal(reply(sock, 1).error.data.code, 'E_INTERNAL');
  assert.ok([...fs.files.keys()].every(k => !k.endsWith('.tmp')));
});

test('export.run writes every file, all-or-nothing preflight, rejects traversal names', async () => {
  const ctx = build({ dispatch: async () => [{ name: 'a.stl', bytes: new Uint8Array([1]) }, { name: 'exists.png', bytes: new Uint8Array([2]) }] });
  await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'export.run', { formats: ['stl'], outDir: 'C:\\out' }); await settle();
  assert.equal(reply(sock, 1).error.data.code, 'E_PATH_REJECTED');
  assert.equal(ctx.fs.files.has('c:\\out\\a.stl'), false, 'preflight failed -> nothing written');
  rpc(sock, 2, 'export.run', { formats: ['stl'], outDir: 'C:\\out', overwrite: true }); await settle();
  const res = reply(sock, 2).result;
  assert.equal(res.outDir, 'C:\\out');
  assert.deepEqual(res.files.map(f => f.path), ['C:\\out\\a.stl', 'C:\\out\\exists.png']);

  const bad = build({ dispatch: async () => [{ name: '..\\evil.stl', bytes: new Uint8Array([1]) }] });
  await bad.server.start();
  const s2 = await connected(bad);
  rpc(s2, 1, 'export.run', { formats: ['stl'], outDir: 'C:\\out' }); await settle();
  assert.equal(reply(s2, 1).error.data.code, 'E_PATH_REJECTED');
  const dup = build({ dispatch: async () => [{ name: 'a.stl', bytes: new Uint8Array(1) }, { name: 'A.STL', bytes: new Uint8Array(1) }] });
  await dup.server.start();
  const s3 = await connected(dup);
  rpc(s3, 1, 'export.run', { formats: ['stl'], outDir: 'C:\\out' }); await settle();
  assert.equal(reply(s3, 1).error.data.code, 'E_PATH_REJECTED');
});

test('output path rejections: bad dir, wrong ext, missing parent, project.saveAs', async () => {
  const ctx = build(); await ctx.server.start();
  const sock = await connected(ctx);
  rpc(sock, 1, 'export.run', { formats: ['stl'], outDir: 'C:\\in\\a.glb' });
  rpc(sock, 2, 'export.run', { formats: ['stl'], outDir: 'C:\\nope' });
  rpc(sock, 3, 'render.png', { outFile: 'C:\\out\\x.exe' });
  rpc(sock, 4, 'render.png', { outFile: 'C:\\nope\\x.png' });
  rpc(sock, 5, 'render.png', { outFile: 'C:\\out\\x.json' });
  rpc(sock, 6, 'render.png', { outFile: 'out\\x.png' });
  await settle();
  for (let i = 1; i <= 6; i++) assert.equal(reply(sock, i).error.data.code, 'E_PATH_REJECTED', `case ${i}`);
  assert.equal(ctx.calls.length, 0);
});

// ---- notifications -----------------------------------------------------------
test('notifications reach only subscribed, authenticated clients', async () => {
  const ctx = build(); await ctx.server.start();
  const a = await connected(ctx);
  const b = await connected(ctx);
  const c = ctx.net.connect(); // never authenticates
  rpc(a, 1, 'events.subscribe', { events: ['objectAdded'] }); await settle();
  assert.equal(ctx.server.notify({ type: 'objectAdded', id: 'o1' }), 1);
  assert.equal(ctx.server.notify({ type: 'busy', busy: true }), 0);
  assert.equal(ctx.server.notify({ type: 'bogus' }), 0);
  const ev = a.frames().filter(f => f.method === 'event');
  assert.deepEqual(ev.map(f => f.params.id), ['o1']);
  assert.equal(ev[0].id, undefined);
  assert.equal(b.frames().filter(f => f.method === 'event').length, 0);
  assert.equal(c.written.length, 0);
  rpc(b, 1, 'events.subscribe', {}); await settle();
  assert.equal(ctx.server.notify({ type: 'busy' }), 1);
});

// ---- dispatchLocal -----------------------------------------------------------
test('dispatchLocal goes through the same rewriting', async () => {
  const ctx = build(); await ctx.server.start();
  const r = await ctx.server.dispatchLocal('scene.import', { files: ['C:\\in\\a.glb'] });
  assert.equal(r.ok, true);
  assert.ok(!ABS_RE.test(JSON.stringify(ctx.calls[0].params)));
  const bad = await ctx.server.dispatchLocal('scene.import', { files: ['nope.glb'] });
  assert.equal(bad.ok, false);
});
