import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createJobRunner, validateJob, EXIT, LIMITS } = require('../electron/JobRunner.cjs');
const { METHOD_NAMES } = require('../electron/ApiServer.cjs');

const TOKEN = 'tok-0123456789abcdef-SECRET';
const PIPE = '//./pipe/mixomesh-test';

// ---- fakes -----------------------------------------------------------------
function fakeFs(files = {}) {
  const map = new Map(Object.entries(files));
  const ops = [];
  return {
    map, ops,
    stat: async p => { if (!map.has(p)) throw new Error('ENOENT'); return { size: Buffer.byteLength(map.get(p)) }; },
    readFile: async p => { if (!map.has(p)) throw new Error('ENOENT'); return map.get(p); },
    writeFile: async (p, data, opts) => {
      ops.push(['writeFile', p, opts]);
      if (opts?.flag === 'wx' && map.has(p)) throw new Error('EEXIST');
      map.set(p, String(data));
    },
    rename: async (a, b) => { ops.push(['rename', a, b]); map.set(b, map.get(a)); map.delete(a); },
    unlink: async p => { ops.push(['unlink', p]); map.delete(p); },
  };
}

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    advance(ms) {
      t += ms;
      for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn(); }
    },
    get pendingTimers() { return timers.size; },
  };
}

// validatePath: paths are already "absolute" in these tests; mimics LaunchArgs kinds.
const validatePath = async (raw, kind) => {
  const name = String(raw).split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (kind === 'jobFile' && ext !== 'json') return { ok: false, name, reason: 'unsupported file type' };
  if (kind === 'outputFile' && !['json', 'png'].includes(ext)) return { ok: false, name, reason: 'unsupported file type' };
  return { ok: true, absolutePath: raw, name, ext };
};

const goodJob = (steps, extra = {}) => JSON.stringify({ apiVersion: 1, steps, ...extra });
const ok = result => ({ ok: true, result });
const err = (code, message = code) => ({ ok: false, error: { code: -32000, message, data: { code } } });

function make({ files = {}, dispatch, session, net, localAvailable, waitReady, limits, clock = fakeClock() } = {}) {
  const fs = fakeFs({ '/w/job.json': goodJob([{ method: 'app.ping' }]), ...files });
  const calls = [];
  const stderr = [];
  const runner = createJobRunner({
    fs, net,
    dispatchLocal: dispatch ?? (async (method, params) => { calls.push([method, params]); return ok({ pong: true }); }),
    readSession: session ?? (async () => { throw new Error('ENOENT'); }),
    validatePath, clock, waitReady, localAvailable, limits,
    methodNames: METHOD_NAMES,
    stderr: line => stderr.push(line),
    tmpSuffix: () => 'x1',
  });
  return { runner, fs, calls, stderr, clock };
}
const resultOf = fs => JSON.parse(fs.map.get('/w/r.json'));
const runLocal = (m, over = {}) => m.runner.run({ job: '/w/job.json', result: '/w/r.json', mode: 'local', ...over });

// ---- job validation --------------------------------------------------------
test('validateJob: accepts a good job and defaults stopOnError to true / params to {}', () => {
  const r = validateJob({ apiVersion: 1, steps: [{ method: 'app.ping' }] }, { methodNames: METHOD_NAMES });
  assert.equal(r.ok, true);
  assert.deepEqual(r.job, { steps: [{ method: 'app.ping', params: {} }], stopOnError: true });
  assert.equal(validateJob({ apiVersion: 1, stopOnError: false, steps: [{ method: 'app.ping' }] }, { methodNames: METHOD_NAMES }).job.stopOnError, false);
});

test('validateJob: rejects every bad envelope with E_INVALID_PARAMS', () => {
  const bad = [
    null, [], 'x', {}, { apiVersion: 2, steps: [{ method: 'app.ping' }] }, { apiVersion: 1 },
    { apiVersion: 1, steps: [] }, { apiVersion: 1, steps: 'x' },
    { apiVersion: 1, steps: [{ method: 'app.ping' }], stopOnError: 'yes' },
    { apiVersion: 1, steps: [null] }, { apiVersion: 1, steps: [{}] }, { apiVersion: 1, steps: [{ method: 5 }] },
    { apiVersion: 1, steps: [{ method: 'no.such' }] },
    { apiVersion: 1, steps: [{ method: 'events.subscribe' }] },
    { apiVersion: 1, steps: [{ method: 'app.ping', params: [] }] },
    { apiVersion: 1, steps: Array.from({ length: LIMITS.maxSteps + 1 }, () => ({ method: 'app.ping' })) },
  ];
  for (const doc of bad) {
    const r = validateJob(doc, { methodNames: METHOD_NAMES });
    assert.equal(r.ok, false, JSON.stringify(doc)?.slice(0, 80));
    assert.equal(r.error.code, 'E_INVALID_PARAMS');
  }
  assert.equal(validateJob({ apiVersion: 1, steps: Array.from({ length: LIMITS.maxSteps }, () => ({ method: 'app.ping' })) }, { methodNames: METHOD_NAMES }).ok, true);
});

// ---- local mode ------------------------------------------------------------
test('local: runs steps in order, writes the result schema, exit 0', async () => {
  const order = [];
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'scene.list', params: { a: 1 } }, { method: 'app.info' }]) },
    dispatch: async (method, params) => { order.push([method, params]); return ok({ m: method }); },
  });
  const { exitCode } = await runLocal(m);
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(order, [['app.ping', {}], ['scene.list', { a: 1 }], ['app.info', {}]]);
  const r = resultOf(m.fs);
  assert.equal(r.apiVersion, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map(s => [s.method, s.ok, s.result.m]), [['app.ping', true, 'app.ping'], ['scene.list', true, 'scene.list'], ['app.info', true, 'app.info']]);
  for (const s of r.steps) assert.equal(typeof s.ms, 'number');
});

test('local: stopOnError true (default) stops at the first failing step, exit 2', async () => {
  const seen = [];
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'scene.get' }, { method: 'app.info' }]) },
    dispatch: async method => { seen.push(method); return method === 'scene.get' ? err('E_NOT_FOUND', 'no such object') : ok(1); },
  });
  assert.equal((await runLocal(m)).exitCode, EXIT.STEP_FAILED);
  assert.deepEqual(seen, ['app.ping', 'scene.get']);
  const r = resultOf(m.fs);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.steps[1].error, { code: 'E_NOT_FOUND', message: 'no such object' });
  assert.equal('result' in r.steps[1], false);
});

test('local: stopOnError false runs every step, still exit 2', async () => {
  const seen = [];
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'scene.get' }, { method: 'app.info' }], { stopOnError: false }) },
    dispatch: async method => { seen.push(method); return method === 'scene.get' ? err('E_NOT_FOUND') : ok(1); },
  });
  assert.equal((await runLocal(m)).exitCode, EXIT.STEP_FAILED);
  assert.deepEqual(seen, ['app.ping', 'scene.get', 'app.info']);
  assert.deepEqual(resultOf(m.fs).steps.map(s => s.ok), [true, false, true]);
});

test('local: a throwing dispatch becomes an E_INTERNAL step error, not a crash', async () => {
  const m = make({ dispatch: async () => { throw new Error('boom C:\\secret\\path'); } });
  assert.equal((await runLocal(m)).exitCode, EXIT.STEP_FAILED);
  assert.equal(resultOf(m.fs).steps[0].error.code, 'E_INTERNAL');
});

test('local: waits for the renderer (waitReady) before the first step', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const m = make({ waitReady: () => gate });
  const p = runLocal(m);
  await new Promise(r => setImmediate(r));
  assert.equal(m.calls.length, 0);
  release(true);
  assert.equal((await p).exitCode, EXIT.OK);
  assert.equal(m.calls.length, 1);
});

test('local: app never ready -> exit 4 with a result', async () => {
  const m = make({ waitReady: () => new Promise(() => {}) });
  const p = runLocal(m);
  await new Promise(r => setImmediate(r));
  m.clock.advance(LIMITS.readyMs + 1);
  assert.equal((await p).exitCode, EXIT.TIMEOUT);
  const r = resultOf(m.fs);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_TIMEOUT');
});

test('local: 20 minute total budget -> exit 4, stuck step reported, later steps not run', async () => {
  const seen = [];
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'export.run', params: {} }, { method: 'app.info' }]) },
    dispatch: async method => { seen.push(method); return method === 'export.run' ? new Promise(() => {}) : ok(1); },
  });
  const p = runLocal(m);
  for (let i = 0; i < 20 && seen.length < 2; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ['app.ping', 'export.run']);
  m.clock.advance(LIMITS.totalMs + 1);
  assert.equal((await p).exitCode, EXIT.TIMEOUT);
  const r = resultOf(m.fs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map(s => [s.method, s.ok]), [['app.ping', true], ['export.run', false]]);
  assert.equal(r.steps[1].error.code, 'E_TIMEOUT');
  assert.equal(seen.includes('app.info'), false);
  assert.equal(m.clock.pendingTimers, 0, 'no timer left behind');
});

test('local: API disabled in this process -> exit 5', async () => {
  const m = make({ localAvailable: () => false });
  assert.equal((await runLocal(m)).exitCode, EXIT.UNAVAILABLE);
  assert.equal(resultOf(m.fs).ok, false);
  assert.equal(m.calls.length, 0);
});

test('abort() (renderer crash) fails the running step, exit 2, result written', async () => {
  const m = make({ dispatch: () => new Promise(() => {}) });
  const p = runLocal(m);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  m.runner.abort('the app window crashed');
  assert.equal((await p).exitCode, EXIT.STEP_FAILED);
  assert.equal(resultOf(m.fs).steps[0].error.message, 'the app window crashed');
});

// ---- invalid job / arguments (exit 3) --------------------------------------
test('invalid job file -> result {ok:false, E_INVALID_PARAMS} and exit 3', async () => {
  const cases = {
    notJson: '{nope',
    wrongVersion: JSON.stringify({ apiVersion: 9, steps: [{ method: 'app.ping' }] }),
    noSteps: JSON.stringify({ apiVersion: 1, steps: [] }),
    unknownMethod: JSON.stringify({ apiVersion: 1, steps: [{ method: 'x.y' }] }),
    tooBig: ' '.repeat(LIMITS.maxJobBytes + 1),
  };
  for (const [name, body] of Object.entries(cases)) {
    const m = make({ files: { '/w/job.json': body } });
    const { exitCode } = await runLocal(m);
    assert.equal(exitCode, EXIT.BAD_JOB, name);
    const r = resultOf(m.fs);
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, 'E_INVALID_PARAMS', name);
    assert.deepEqual(r.steps, []);
    assert.equal(m.calls.length, 0);
  }
});

test('UTF-8 BOM in the job file is tolerated', async () => {
  const m = make({ files: { '/w/job.json': `\uFEFF${goodJob([{ method: 'app.ping' }])}` } });
  assert.equal((await runLocal(m)).exitCode, EXIT.OK);
});

test('missing job file, wrong job extension -> exit 3 with a result', async () => {
  const m = make();
  assert.equal((await runLocal(m, { job: '/w/missing.json' })).exitCode, EXIT.BAD_JOB);
  assert.equal(resultOf(m.fs).error.code, 'E_INVALID_PARAMS');
  const m2 = make();
  assert.equal((await runLocal(m2, { job: '/w/job.txt' })).exitCode, EXIT.BAD_JOB);
});

test('--job without --result, or a bad --result -> exit 3, stderr explains, nothing written', async () => {
  const m = make();
  assert.equal((await m.runner.run({ job: '/w/job.json', result: null, mode: 'local' })).exitCode, EXIT.BAD_JOB);
  assert.match(m.stderr.join('\n'), /--result/);
  const m2 = make();
  assert.equal((await runLocal(m2, { result: '/w/r.png' })).exitCode, EXIT.BAD_JOB);   // png is an output ext but not for results
  assert.equal(m2.fs.ops.length, 0);
  const m3 = make();
  assert.equal((await runLocal(m3, { result: '/w/r.exe' })).exitCode, EXIT.BAD_JOB);
});

// ---- result file -----------------------------------------------------------
test('result write is atomic (temp + rename) and overwrites the caller\'s own file', async () => {
  const m = make({ files: { '/w/r.json': 'old' } });
  assert.equal((await runLocal(m)).exitCode, EXIT.OK);
  const kinds = m.fs.ops.map(o => o[0]);
  assert.deepEqual(kinds, ['writeFile', 'rename']);
  assert.equal(m.fs.ops[0][1], '/w/r.json.x1.tmp');
  assert.equal(m.fs.ops[0][2].flag, 'wx');
  assert.equal(m.fs.ops[1][2], '/w/r.json');
  assert.equal(m.fs.map.has('/w/r.json.x1.tmp'), false);
  assert.equal(resultOf(m.fs).ok, true);
});

test('result write failure -> temp cleaned up, stderr, never exit 0', async () => {
  const m = make();
  m.fs.rename = async () => { throw new Error('EPERM'); };
  const { exitCode } = await runLocal(m);
  assert.equal(exitCode, EXIT.STEP_FAILED);
  assert.equal(m.fs.map.has('/w/r.json.x1.tmp'), false);
  assert.match(m.stderr.join('\n'), /result file could not be written/);
});

// ---- remote (lock loser) ---------------------------------------------------
/** Fake pipe server: replies per request; records every frame it receives. */
function fakeNet({ acceptToken = TOKEN, handler, refuse = false, dropAfter = Infinity } = {}) {
  const net = { frames: [], connected: [], createConnection(pipe) {
    net.connected.push(pipe);
    const sock = new EventEmitter();
    let answered = 0;
    sock.write = line => {
      const msg = JSON.parse(String(line).trim());
      net.frames.push(msg);
      queueMicrotask(() => {
        const reply = obj => sock.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...obj })}\n`));
        if (msg.method === 'hello') {
          if (msg.params.token !== acceptToken) { reply({ error: { code: -32602, message: 'authentication failed', data: { code: 'E_INVALID_PARAMS' } } }); sock.emit('close'); return; }
          reply({ result: { apiVersion: 1, authenticated: true } });
          return;
        }
        if (++answered > dropAfter) { sock.emit('close'); return; }
        const out = handler ? handler(msg) : { result: { pong: true } };
        reply(out);
      });
    };
    sock.end = () => {};
    sock.destroy = () => {};
    queueMicrotask(() => { if (refuse) sock.emit('error', new Error('ENOENT')); else sock.emit('connect'); });
    return sock;
  } };
  return net;
}
const goodSession = async () => ({ pipe: PIPE, token: TOKEN, pid: 1, apiVersion: 1 });
const runRemote = (m, over = {}) => m.runner.run({ job: '/w/job.json', result: '/w/r.json', mode: 'remote', ...over });

test('remote: session file + pipe answers hello -> steps run over the pipe, not in-process, exit 0', async () => {
  const net = fakeNet({ handler: msg => ({ result: { echoed: msg.method } }) });
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'scene.list', params: { x: 1 } }]) },
    session: goodSession, net,
  });
  assert.equal((await runRemote(m)).exitCode, EXIT.OK);
  assert.deepEqual(net.connected, [PIPE]);
  assert.equal(net.frames[0].method, 'hello');
  assert.deepEqual(net.frames[0].params, { token: TOKEN, apiVersion: 1 });
  assert.deepEqual(net.frames.slice(1).map(f => [f.jsonrpc, f.method, f.params]), [['2.0', 'app.ping', {}], ['2.0', 'scene.list', { x: 1 }]]);
  assert.equal(m.calls.length, 0, 'local dispatch must not be used');
  const r = resultOf(m.fs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map(s => s.result.echoed), ['app.ping', 'scene.list']);
});

test('remote: server error reply -> step error with symbolic code, stopOnError applies, exit 2', async () => {
  const net = fakeNet({ handler: msg => (msg.method === 'scene.get'
    ? { error: { code: -32000, message: 'no such object', data: { code: 'E_NOT_FOUND' } } } : { result: 1 }) });
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'scene.get' }, { method: 'app.info' }]) },
    session: goodSession, net,
  });
  assert.equal((await runRemote(m)).exitCode, EXIT.STEP_FAILED);
  assert.equal(net.frames.length, 3);   // hello + 2 steps; third skipped
  assert.deepEqual(resultOf(m.fs).steps[1].error, { code: 'E_NOT_FOUND', message: 'no such object' });
});

test('remote: connection lost mid-job -> remaining step fails with E_INTERNAL, exit 2', async () => {
  const net = fakeNet({ dropAfter: 1 });
  const m = make({
    files: { '/w/job.json': goodJob([{ method: 'app.ping' }, { method: 'app.info' }], { stopOnError: false }) },
    session: goodSession, net,
  });
  assert.equal((await runRemote(m)).exitCode, EXIT.STEP_FAILED);
  const r = resultOf(m.fs);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.steps[1].error.code, 'E_INTERNAL');
});

test('remote: no session file (API disabled / not running) -> exit 5 and a clear result', async () => {
  const m = make({ net: fakeNet() });
  assert.equal((await runRemote(m)).exitCode, EXIT.UNAVAILABLE);
  const r = resultOf(m.fs);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /automation API is not available/);
  assert.match(m.stderr.join('\n'), /automation API is not available/);
});

test('remote: malformed session file -> exit 5', async () => {
  for (const s of [null, [], {}, { pipe: PIPE }, { token: TOKEN }, { pipe: 5, token: TOKEN }]) {
    const m = make({ net: fakeNet(), session: async () => s });
    assert.equal((await runRemote(m)).exitCode, EXIT.UNAVAILABLE);
  }
});

test('remote: pipe refuses the connection -> exit 5', async () => {
  const m = make({ session: goodSession, net: fakeNet({ refuse: true }) });
  assert.equal((await runRemote(m)).exitCode, EXIT.UNAVAILABLE);
  assert.equal(resultOf(m.fs).ok, false);
});

test('remote: stale token (hello rejected) -> exit 5', async () => {
  const m = make({ session: goodSession, net: fakeNet({ acceptToken: 'another-token' }) });
  assert.equal((await runRemote(m)).exitCode, EXIT.UNAVAILABLE);
});

test('remote: no hello answer within the connect window -> exit 5', async () => {
  const silent = { createConnection() { const s = new EventEmitter(); s.write = () => {}; s.end = () => {}; s.destroy = () => {}; queueMicrotask(() => s.emit('connect')); return s; } };
  const m = make({ session: goodSession, net: silent });
  const p = runRemote(m);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  m.clock.advance(LIMITS.connectMs + 1);
  assert.equal((await p).exitCode, EXIT.UNAVAILABLE);
});

test('remote: an invalid job is rejected before any connection (exit 3)', async () => {
  const net = fakeNet();
  const m = make({ files: { '/w/job.json': '[]' }, session: goodSession, net });
  assert.equal((await runRemote(m)).exitCode, EXIT.BAD_JOB);
  assert.deepEqual(net.connected, []);
});

// ---- secrecy ---------------------------------------------------------------
test('the session token never appears in the result file or stderr (all failure paths)', async () => {
  const paths = [
    make({ session: goodSession, net: fakeNet() }),
    make({ session: goodSession, net: fakeNet({ acceptToken: 'other' }) }),
    make({ session: goodSession, net: fakeNet({ refuse: true }) }),
    make({ session: goodSession, net: fakeNet({ handler: () => ({ error: { code: -32603, message: 'x', data: { code: 'E_INTERNAL' } } }) }) }),
    make({ session: async () => { throw new Error(`cannot read ${TOKEN}`); }, net: fakeNet() }),
  ];
  for (const m of paths) {
    await runRemote(m);
    const blob = (m.fs.map.get('/w/r.json') ?? '') + m.stderr.join('\n');
    assert.equal(blob.includes(TOKEN), false);
  }
});

test('exit-code table is the documented one', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, STEP_FAILED: 2, BAD_JOB: 3, TIMEOUT: 4, UNAVAILABLE: 5 });
  assert.equal(LIMITS.maxSteps, 64);
  assert.equal(LIMITS.maxJobBytes, 1024 * 1024);
  assert.equal(LIMITS.totalMs, 20 * 60 * 1000);
});
