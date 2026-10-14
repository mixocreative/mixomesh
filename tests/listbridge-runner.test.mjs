// Listbridge Electron runner (plan PB.4): credential store (fake safeStorage), transport
// retry / backoff / timeout (fake fetch + fake sleep), the resumable publish job (fake
// adapter + fake transport + fake file host) and the IPC wiring (fake handle).
//   node --test tests/listbridge-runner.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createCredentialStore } = require('../electron/listbridge/credentials.cjs');
const { createTransport, BACKOFF_MS } = require('../electron/listbridge/transport.cjs');
const { createPublishRunner } = require('../electron/listbridge/jobs.cjs');
const { registerListbridgeIpc, defaultZip } = require('../electron/listbridge/index.cjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'sk_live_TOP_SECRET_123';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lb-runner-'));

// ── fakes ────────────────────────────────────────────────────────────────

function fakeSafeStorage({ available = true } = {}) {
  const flip = buf => Buffer.from(buf.map(b => b ^ 0x5a));
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString: s => Buffer.concat([Buffer.from('FAKEENC1'), flip(Buffer.from(s, 'utf8'))]),
    decryptString: b => {
      if (!b.subarray(0, 8).equals(Buffer.from('FAKEENC1'))) throw new Error('bad blob');
      return flip(b.subarray(8)).toString('utf8');
    },
  };
}

function recordingSleep(clock) {
  const delays = [];
  const sleep = async ms => { delays.push(ms); if (clock) clock.t += ms; };
  return { delays, sleep };
}

const bytes = (...n) => new Uint8Array(n);

function makePkg({ files = 2, images = 1 } = {}) {
  return core.createListing({
    title: 'Dragon Bust', description: 'A **printable** bust.', tags: ['dragon'],
    price: { amount: 4, currency: 'EUR' }, license: 'cc-by', madeWithAi: false,
    images: Array.from({ length: images }, (_, i) => ({ name: `img${i}.png`, mime: 'image/png', bytes: bytes(1, i), role: i === 0 ? 'hero' : 'gallery' })),
    files: Array.from({ length: files }, (_, i) => ({ name: `part${i}.3mf`, mime: 'model/3mf', bytes: bytes(2, i) })),
  });
}

function fakeAdapter({ transfer = 'url', maxFiles = 10, confirmAfter = 0, issues = [] } = {}) {
  let confirmCalls = 0;
  return {
    describe: () => ({
      id: 'fake', label: 'Fake Market', transfer, maxFiles, maxImages: 10, currencies: ['EUR'],
      fields: ['title'], credentials: ['user', 'apiKey'],
    }),
    validate: () => issues,
    authHeaders: rec => ({ Authorization: `Basic ${Buffer.from(`${rec.user}:${rec.apiKey}`).toString('base64')}` }),
    buildCreate: (pkg, ctx) => ({
      method: 'POST', url: 'https://fake.test/graphql',
      body: { op: 'create', title: pkg.title, files: ctx.files.map(f => f.url ?? `bytes:${f.name}:${f.bytes.length}`), images: ctx.images.map(i => i.url ?? `bytes:${i.name}`), names: ctx.files.map(f => f.name) },
    }),
    buildUpdate: (remoteId, pkg, ctx) => ({
      method: 'POST', url: 'https://fake.test/graphql',
      body: { op: 'update', remoteId, title: pkg.title, files: ctx.files.map(f => f.url) },
    }),
    parseResult: res => {
      if (res.json?.errors?.length) throw new Error(res.json.errors[0].message);
      return res.json.data;
    },
    ...(confirmAfter ? {
      buildConfirm: result => ({ method: 'POST', url: 'https://fake.test/graphql', body: { op: 'confirm', id: result.remoteId } }),
      parseConfirm: () => ({ confirmed: ++confirmCalls >= confirmAfter, status: 'published' }),
    } : {}),
  };
}

function fakeTransport(responder) {
  const calls = [];
  return {
    calls,
    request: async req => {
      calls.push(req);
      const r = await responder(req, calls.length);
      return { status: 200, ok: true, headers: {}, text: '', ...r };
    },
  };
}
const created = (id = 'c1') => ({ json: { data: { remoteId: id, url: `https://fake.test/c/${id}`, status: 'draft' } } });

function fakeFileHost({ failRemove = false, gate = null } = {}) {
  const host = {
    puts: [], removed: [], presigns: 0, failRemove,
    async put(name, b, mime) {
      if (gate) await gate();
      const key = `listbridge/k${host.puts.length}/${name}`;
      host.puts.push({ name, key, mime, size: b.length });
      return { key };
    },
    presignGet(key) { host.presigns++; return `https://host.test/${key}?sig=${host.presigns}`; },
    async remove(key) {
      if (host.failRemove) throw new Error('remove failed');
      host.removed.push(key);
    },
    async testConnection() { return { ok: true, message: 'ok' }; },
  };
  return host;
}

const fakeCreds = (extra = {}) => ({
  records: { 'fake:me': { user: 'me', apiKey: SECRET }, 'filehost:r2': { type: 's3' }, ...extra },
  async get(id) { return this.records[id] ? { ...this.records[id] } : null; },
});

function setupRunner({ adapter = fakeAdapter(), responder = () => created(), host = fakeFileHost(), zip, sleep } = {}) {
  const events = [];
  const transport = fakeTransport(responder);
  const zipCalls = [];
  const runner = createPublishRunner({
    adapters: [adapter], credentials: fakeCreds(), transport, core,
    makeFileHost: () => host,
    zip: zip ?? (async files => { zipCalls.push(files.map(f => f.name)); return bytes(80, 75, 3, 4); }),
    emit: e => events.push(e), sleep: sleep ?? (async () => {}), confirm: { polls: 3, intervalMs: 7 },
  });
  return { runner, events, transport, host, zipCalls };
}
const stepStatus = events => events.filter(e => !(e.step === 'host' && e.status === 'running' && /Uploaded/.test(e.message))).map(e => `${e.step}:${e.status}`);

// ── credentials ──────────────────────────────────────────────────────────

test('credentials: encrypted round trip, file never holds the plaintext secret', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'listbridge-credentials.bin');
  const safe = fakeSafeStorage();
  const store = createCredentialStore({ filePath, safeStorage: safe });
  assert.equal(await store.has('cults3d:mixo'), false);
  await store.set('cults3d:mixo', { nickname: 'mixo', apiKey: SECRET });
  await store.set('filehost:r2', { type: 's3', secretAccessKey: 'SECRET_S3_KEY_XYZ' });
  assert.equal(await store.has('cults3d:mixo'), true);
  assert.deepEqual(await store.listIds(), ['cults3d:mixo', 'filehost:r2']);

  const raw = fs.readFileSync(filePath);
  assert.ok(!raw.includes(SECRET) && !raw.includes('SECRET_S3_KEY_XYZ') && !raw.includes('nickname'), 'file is encrypted');
  assert.deepEqual(fs.readdirSync(dir), ['listbridge-credentials.bin'], 'no temp file left behind');

  const again = createCredentialStore({ filePath, safeStorage: safe });
  assert.deepEqual(await again.get('cults3d:mixo'), { nickname: 'mixo', apiKey: SECRET });
  assert.equal(await again.clear('cults3d:mixo'), true);
  assert.equal(await again.clear('cults3d:mixo'), false);
  assert.equal(await again.get('cults3d:mixo'), null);
  assert.deepEqual(await again.listIds(), ['filehost:r2']);
});

test('credentials: refuse to store when OS encryption is unavailable (no plaintext fallback)', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'c.bin');
  const store = createCredentialStore({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
  await assert.rejects(store.set('cults3d:mixo', { apiKey: SECRET }), /encryption .*not available/i);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(await store.has('cults3d:mixo'), false);
});

test('credentials: ids and record shapes are validated; damaged file gives a clear error', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'c.bin');
  const store = createCredentialStore({ filePath, safeStorage: fakeSafeStorage() });
  await assert.rejects(store.set('nocolon', { a: 'b' }), /id must look like/);
  await assert.rejects(store.set('x:../../etc', { a: 'b' }), /id must look like/);
  await assert.rejects(store.set('cults3d:me', { nested: { a: 1 } }), /must be a string/);
  await assert.rejects(store.set('cults3d:me', {}), /no fields/);
  fs.writeFileSync(filePath, 'garbage');
  await assert.rejects(store.get('cults3d:me'), /cannot be decrypted/);
});

// ── transport ────────────────────────────────────────────────────────────

const resp = (status, headers = {}, body = '') => new Response(body, { status, headers });

test('transport: 5xx retried with 1s/5s backoff, then succeeds', async () => {
  const { delays, sleep } = recordingSleep();
  const queue = [resp(503), resp(502), resp(200, { 'content-type': 'application/json' }, '{"ok":1}')];
  const t = createTransport({ fetchImpl: async () => queue.shift(), sleep });
  const r = await t.request({ url: 'https://api.test/x', method: 'POST', body: { a: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: 1 });
  assert.equal(r.attempts, 3);
  assert.deepEqual(delays, [1000, 5000]);
});

test('transport: 429 gives up after 4 retries (1s→5s→10s→30s)', async () => {
  const { delays, sleep } = recordingSleep();
  let n = 0;
  const t = createTransport({ fetchImpl: async () => { n++; return resp(429); }, sleep });
  const r = await t.request({ url: 'https://api.test/x' });
  assert.equal(r.status, 429);
  assert.equal(r.ok, false);
  assert.equal(n, 5);
  assert.deepEqual(delays, [...BACKOFF_MS]);
  assert.deepEqual(BACKOFF_MS, [1000, 5000, 10000, 30000]);
});

test('transport: Retry-After and x-ratelimit-reset replace the schedule', async () => {
  const clock = { t: 1_700_000_000_000 };
  const { delays, sleep } = recordingSleep(clock);
  const queue = [
    resp(429, { 'retry-after': '7' }),
    resp(429, { 'x-ratelimit-reset': String(Math.floor(clock.t / 1000) + 12) }),   // epoch seconds
    resp(503, { 'x-ratelimit-reset': '3' }),                                          // seconds until reset
    resp(200),
  ];
  const t = createTransport({ fetchImpl: async () => queue.shift(), sleep, now: () => clock.t });
  const r = await t.request({ url: 'https://api.test/x' });
  assert.equal(r.status, 200);
  assert.deepEqual(delays, [7000, 12000 - 7000, 3000]);
});

test('transport: x-ratelimit-remaining 0 delays the NEXT request until reset', async () => {
  const clock = { t: 1_000_000 };
  const { delays, sleep } = recordingSleep(clock);
  const queue = [resp(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' }), resp(200)];
  const t = createTransport({ fetchImpl: async () => queue.shift(), sleep, now: () => clock.t });
  await t.request({ url: 'https://api.test/a' });
  assert.deepEqual(delays, []);
  await t.request({ url: 'https://api.test/b' });
  assert.deepEqual(delays, [30000]);
});

test('transport: network error retried; rate-limit policy does not retry 5xx', async () => {
  const { delays, sleep } = recordingSleep();
  const queue = [() => { throw new TypeError('fetch failed'); }, () => resp(200)];
  const t = createTransport({ fetchImpl: async () => queue.shift()(), sleep });
  assert.equal((await t.request({ url: 'https://api.test/x' })).status, 200);
  assert.deepEqual(delays, [1000]);

  const s2 = recordingSleep();
  let n = 0;
  const t2 = createTransport({ fetchImpl: async () => { n++; return resp(500); }, sleep: s2.sleep });
  const r = await t2.request({ url: 'https://api.test/x', method: 'POST', retry: 'rate-limit' });
  assert.equal(r.status, 500);
  assert.equal(n, 1);
  assert.deepEqual(s2.delays, []);
});

test('transport: per-attempt timeout aborts the fetch; error hides the query string', async () => {
  const { delays, sleep } = recordingSleep();
  let aborted = 0;
  const hang = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => { aborted++; rej(new Error('aborted')); });
  });
  const t = createTransport({ fetchImpl: hang, sleep });
  await assert.rejects(
    t.request({ url: 'https://api.test/x?X-Amz-Signature=deadbeefsecret', timeoutMs: 15 }),
    err => /timed out after 15 ms/.test(err.message) && !err.message.includes('deadbeefsecret'),
  );
  assert.equal(aborted, 5, 'every attempt timed out');
  assert.deepEqual(delays, [...BACKOFF_MS]);
});

test('transport: JSON bodies are encoded; caller AbortSignal cancels without retry', async () => {
  let seen;
  const t = createTransport({ fetchImpl: async (url, init) => { seen = init; return resp(200); }, sleep: async () => {} });
  await t.request({ url: 'https://api.test/x', method: 'POST', body: { q: 1 }, headers: { Authorization: 'Basic x' } });
  assert.equal(seen.body, '{"q":1}');
  assert.equal(seen.headers['Content-Type'], 'application/json');

  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(t.request({ url: 'https://api.test/x', signal: ctrl.signal }), /cancelled/);
});

// ── publish runner ───────────────────────────────────────────────────────

test('runner: url transfer happy path — host put → presign → create → cleanup removes', async () => {
  const { runner, events, transport, host } = setupRunner();
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result, { remoteId: 'c1', url: 'https://fake.test/c/c1', status: 'draft' });
  assert.deepEqual(host.puts.map(p => p.name), ['part0.3mf', 'part1.3mf', 'img0.png']);
  const body = transport.calls[0].body;
  assert.equal(body.op, 'create');
  assert.ok(body.files.every(u => u.startsWith('https://host.test/listbridge/')), 'create got hosted urls');
  assert.ok(body.images[0].startsWith('https://host.test/listbridge/k2/img0.png'));
  assert.match(transport.calls[0].headers.Authorization, /^Basic /);
  assert.equal(transport.calls[0].retry, 'rate-limit', 'create is never blindly resent');
  assert.deepEqual(host.removed.sort(), host.puts.map(p => p.key).sort());
  assert.deepEqual(stepStatus(events), [
    'validate:running', 'validate:done', 'bundle:running', 'bundle:done', 'host:running', 'host:done',
    'create:running', 'create:done', 'confirm:running', 'confirm:done', 'cleanup:running', 'cleanup:done',
  ]);
  assert.ok(events.every(e => e.jobId === out.jobId));
  assert.equal(events.filter(e => /Uploaded/.test(e.message)).length, 3);
  assert.ok(!JSON.stringify(events).includes(SECRET) && !JSON.stringify(out).includes(SECRET), 'no secret in events/outcome');
});

test('runner: direct transfer skips hosting and hands bytes to the adapter', async () => {
  const { runner, events, transport, host } = setupRunner({ adapter: fakeAdapter({ transfer: 'direct' }) });
  const out = await runner.start({ platform: 'fake', accountId: 'me', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(host.puts.length, 0);
  assert.deepEqual(transport.calls[0].body.files, ['bytes:part0.3mf:2', 'bytes:part1.3mf:2']);
  const hostDone = events.find(e => e.step === 'host' && e.status === 'done');
  assert.equal(hostDone.skipped, true);
  assert.equal(events.find(e => e.step === 'cleanup' && e.status === 'done').skipped, true);
});

test('runner: create failure keeps hosted files; retry reuses the SAME keys (no second put)', async () => {
  let fail = true;
  const responder = () => (fail ? { json: { errors: [{ message: 'Price is invalid' }] } } : created('c9'));
  const { runner, events, transport, host } = setupRunner({ responder });
  const first = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(first.ok, false);
  assert.equal(first.status, 'failed');
  assert.equal(first.failedStep, 'create');
  assert.match(first.error, /Price is invalid/);
  assert.equal(host.puts.length, 3);
  assert.equal(host.removed.length, 0, 'hosted objects kept for the retry');
  assert.deepEqual(events.at(-1), { jobId: first.jobId, step: 'create', status: 'failed', message: 'Price is invalid' });

  fail = false;
  events.length = 0;
  const second = await runner.retry(first.jobId);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.result.remoteId, 'c9');
  assert.equal(host.puts.length, 3, 'no second upload');
  assert.deepEqual(transport.calls[1].body.files, transport.calls[0].body.files, 'same hosted URLs');
  assert.deepEqual(stepStatus(events), ['create:running', 'create:done', 'confirm:running', 'confirm:done', 'cleanup:running', 'cleanup:done']);
  assert.equal(host.removed.length, 3);
  await assert.rejects(runner.retry(first.jobId), /nothing to retry/);
});

test('runner: cancel after a failure removes hosted objects', async () => {
  const { runner, host } = setupRunner({ responder: () => ({ status: 500, ok: false }) });
  const first = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(first.failedStep, 'create');
  assert.match(first.error, /HTTP 500/);
  const c = await runner.cancel(first.jobId);
  assert.equal(c.status, 'cancelled');
  assert.equal(host.removed.length, 3);
  await assert.rejects(runner.retry(first.jobId), /cancelled/);
});

test('runner: cancel while uploading stops the job and removes what was hosted', async () => {
  let release;
  let entered = 0;
  const gate = () => { entered++; return entered === 2 ? new Promise(r => { release = r; }) : Promise.resolve(); };
  const host = fakeFileHost({ gate });
  const { runner, events, transport } = setupRunner({ host });
  const jobId = runner.create({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  const running = runner.run(jobId);
  while (!release) await new Promise(r => setImmediate(r));
  const cancelling = runner.cancel(jobId);
  release();
  const [out, c] = await Promise.all([running, cancelling]);
  assert.equal(out.status, 'cancelled');
  assert.equal(c.status, 'cancelled');
  assert.equal(host.puts.length, 2, 'stopped before the third upload');
  assert.deepEqual(host.removed.sort(), host.puts.map(p => p.key).sort());
  assert.equal(transport.calls.length, 0, 'never reached create');
  assert.deepEqual(events.at(-1).step, 'cleanup');
});

test('runner: remoteId → update path', async () => {
  const { runner, events, transport } = setupRunner({ responder: () => created('existing-7') });
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', remoteId: 'existing-7', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(transport.calls[0].body.op, 'update');
  assert.equal(transport.calls[0].body.remoteId, 'existing-7');
  assert.ok(events.some(e => e.step === 'update' && e.status === 'done'));
  assert.ok(!events.some(e => e.step === 'create'));
});

test('runner: more files than maxFiles → one zip is hosted instead', async () => {
  const { runner, transport, host, zipCalls } = setupRunner();
  const pkg = makePkg({ files: 12 });
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg, zipName: 'dragon-bust.zip' });
  assert.equal(out.ok, true, out.error);
  assert.equal(zipCalls.length, 1);
  assert.equal(zipCalls[0].length, 12);
  assert.deepEqual(transport.calls[0].body.names, ['dragon-bust.zip']);
  assert.deepEqual(host.puts.map(p => [p.name, p.mime]), [['dragon-bust.zip', 'application/zip'], ['img0.png', 'image/png']]);
});

test('runner: invalid listing fails at validate with issues; nothing hosted', async () => {
  const { runner, host } = setupRunner({ adapter: fakeAdapter({ issues: [{ field: 'tags', code: 'x', message: 'Needs a tag.' }] }) });
  const pkg = makePkg();
  pkg.title = '';
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg });
  assert.equal(out.failedStep, 'validate');
  assert.deepEqual(out.issues.map(i => i.code), ['title-empty', 'x']);
  assert.equal(host.puts.length, 0);
});

test('runner: confirm polls the adapter until ingested', async () => {
  const { delays, sleep } = recordingSleep();
  const { runner, transport } = setupRunner({ adapter: fakeAdapter({ confirmAfter: 3 }), sleep });
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.status, 'published');
  assert.deepEqual(transport.calls.map(c => c.body.op), ['create', 'confirm', 'confirm', 'confirm']);
  assert.deepEqual(delays, [7, 7]);
});

test('runner: cleanup failure is reported with the listing result; retry removes the leftovers', async () => {
  const host = fakeFileHost({ failRemove: true });
  const { runner } = setupRunner({ host });
  const out = await runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(out.failedStep, 'cleanup');
  assert.equal(out.result.remoteId, 'c1', 'the listing exists even though cleanup failed');
  assert.equal(out.leftover.length, 3);
  host.failRemove = false;
  const again = await runner.retry(out.jobId);
  assert.equal(again.ok, true);
  assert.equal(host.removed.length, 3);
});

test('runner: missing account credentials or file host fail cleanly', async () => {
  const { runner } = setupRunner();
  const a = await runner.start({ platform: 'fake', accountId: 'nobody', fileHostId: 'r2', pkg: makePkg() });
  assert.equal(a.failedStep, 'create');
  assert.match(a.error, /No saved credentials for fake account "nobody"/);
  const b = await runner.start({ platform: 'fake', accountId: 'me', pkg: makePkg() });
  assert.equal(b.failedStep, 'host');
  assert.match(b.error, /needs a file host/);
  assert.throws(() => runner.create({ platform: 'nope', accountId: 'me', pkg: makePkg() }), /no adapter/);
});

test('runner: default zip (jszip) produces a real zip archive', async () => {
  const z = await defaultZip([{ name: 'a.stl', bytes: bytes(1, 2, 3) }, { name: 'b.stl', bytes: bytes(4) }]);
  assert.ok(z instanceof Uint8Array);
  assert.deepEqual([...z.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

// ── IPC wiring ───────────────────────────────────────────────────────────

function setupIpc({ adapter = fakeAdapter(), responder = () => created() } = {}) {
  const handlers = new Map();
  const handle = (channel, fn) => handlers.set(channel, fn);
  const dir = tmpDir();
  const transport = fakeTransport(responder);
  const host = fakeFileHost();
  const madeHosts = [];
  registerListbridgeIpc(handle, {
    userDataDir: dir, safeStorage: fakeSafeStorage(), adapters: [adapter], transport,
    makeFileHost: record => {
      if (!/^https:\/\//.test(record.endpoint ?? '')) throw new Error('S3 file host: endpoint must use https://');
      madeHosts.push(Object.keys(record).sort());
      return host;
    },
    loadCore: async () => core,
  });
  const sent = [];
  const sender = (id = 1) => ({ id, isDestroyed: () => false, send: (ch, ev) => sent.push([ch, ev]) });
  const call = (channel, ...args) => handlers.get(channel)({ sender: sender() }, ...args);
  return { handlers, call, sent, sender, dir, transport, host, madeHosts };
}

const s3Record = { type: 's3', endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'mixo', accessKeyId: 'AK', secretAccessKey: 'S3SECRETVALUE' };

test('ipc: registers exactly the publish:* channels', () => {
  const { handlers } = setupIpc();
  assert.deepEqual([...handlers.keys()].sort(), [
    'publish:cancel', 'publish:clearCredentials', 'publish:describe', 'publish:hasCredentials',
    'publish:retry', 'publish:setCredentials', 'publish:start', 'publish:testConnection',
  ]);
});

test('ipc: credentials go in, never come back out', async () => {
  const { call, dir, madeHosts } = setupIpc();
  const d = await call('publish:describe');
  assert.deepEqual(d.platforms.map(p => [p.id, p.transfer, p.credentials]), [['fake', 'url', ['user', 'apiKey']]]);
  assert.deepEqual(d.fileHosts.map(h => h.type), ['s3']);

  assert.equal(await call('publish:hasCredentials', 'fake:me'), false);
  const r = await call('publish:setCredentials', 'fake:me', { user: 'me', apiKey: SECRET });
  assert.deepEqual(r, { ok: true });
  assert.equal(await call('publish:hasCredentials', 'fake:me'), true);
  await assert.rejects(call('publish:setCredentials', 'fake:me', { user: 'me' }), /apiKey is required/);
  await assert.rejects(call('publish:setCredentials', 'fake:me', { user: 'me', apiKey: 'k', extra: 1 }), /unexpected credential field "extra"/);
  await assert.rejects(call('publish:setCredentials', 'other:me', { user: 'me' }), /unknown platform/);
  await assert.rejects(call('publish:hasCredentials', '../x'), /account id/);

  assert.deepEqual(await call('publish:setCredentials', 'filehost:r2', s3Record), { ok: true });
  assert.deepEqual(madeHosts[0], ['accessKeyId', 'bucket', 'endpoint', 'region', 'secretAccessKey', 'type']);
  await assert.rejects(call('publish:setCredentials', 'filehost:bad', { ...s3Record, endpoint: 'http://evil' }), /https/);
  assert.deepEqual(await call('publish:testConnection', 'filehost:r2'), { ok: true, message: 'ok' });

  const raw = fs.readFileSync(path.join(dir, 'listbridge-credentials.bin'));
  assert.ok(!raw.includes(SECRET) && !raw.includes('S3SECRETVALUE'));
  assert.deepEqual(await call('publish:clearCredentials', 'fake:me'), { ok: true, removed: true });
  assert.equal(await call('publish:hasCredentials', 'fake:me'), false);
});

function startPayload(pkg = makePkg(), extra = {}) {
  const manifest = core.toManifest(pkg);
  return {
    platform: 'fake', accountId: 'me', fileHostId: 'r2', manifest,
    images: pkg.images.map(i => i.bytes.buffer.slice(i.bytes.byteOffset, i.bytes.byteOffset + i.bytes.byteLength)),
    files: pkg.files.map(f => f.bytes),
    ...extra,
  };
}

test('ipc: publish:start rebuilds + validates the package and streams progress to the sender', async () => {
  const { call, sent, host } = setupIpc();
  await call('publish:setCredentials', 'fake:me', { user: 'me', apiKey: SECRET });
  await call('publish:setCredentials', 'filehost:r2', s3Record);
  const out = await call('publish:start', startPayload());
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.remoteId, 'c1');
  assert.equal(host.puts.length, 3);
  assert.ok(sent.length >= 12 && sent.every(([ch, ev]) => ch === 'publish:progress' && ev.jobId === out.jobId));
  assert.ok(!JSON.stringify(sent).includes(SECRET));

  const bad = startPayload();
  bad.files = bad.files.slice(1);
  await assert.rejects(call('publish:start', bad), /do not match the manifest/);
  const wrongSize = startPayload();
  wrongSize.files[0] = bytes(1, 2, 3, 4, 5);
  await assert.rejects(call('publish:start', wrongSize), /size does not match/);
  const notBytes = startPayload();
  notBytes.files[0] = 'C:\\Users\\me\\model.3mf';
  await assert.rejects(call('publish:start', notBytes), /expected bytes/);

  const p = makePkg();
  p.title = '';
  const invalid = await call('publish:start', startPayload(p));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 'invalid');
  assert.ok(invalid.issues.some(i => i.code === 'title-empty'));
});

test('ipc: retry / cancel are limited to the window that started the job', async () => {
  const { call, handlers, sender } = setupIpc({ responder: () => ({ status: 500, ok: false }) });
  await call('publish:setCredentials', 'fake:me', { user: 'me', apiKey: SECRET });
  await call('publish:setCredentials', 'filehost:r2', s3Record);
  const out = await call('publish:start', startPayload());
  assert.equal(out.failedStep, 'create');
  await assert.rejects(handlers.get('publish:retry')({ sender: sender(2) }, out.jobId), /another window/);
  await assert.rejects(call('publish:cancel', 'job_unknown'), /unknown publish job/);
  const c = await call('publish:cancel', out.jobId);
  assert.equal(c.status, 'cancelled');
});

test('runner code stays host-neutral: no electron import, IPC only via the injected handle', () => {
  const dir = path.join(ROOT, 'electron', 'listbridge');
  const files = ['credentials.cjs', 'transport.cjs', 'jobs.cjs', 'index.cjs', 'filehosts/s3.cjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/, `${f} imports electron`);
    assert.doesNotMatch(src, /ipcMain/, `${f} touches ipcMain directly`);
    assert.doesNotMatch(src, /console\.log/, `${f} logs`);
  }
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /registerListbridgeIpc\(handle,/);
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
  for (const m of ['describe', 'hasCredentials', 'setCredentials', 'clearCredentials', 'testConnection', 'start', 'retry', 'cancel', 'onProgress']) {
    assert.match(preload, new RegExp(`\\b${m}:`), `preload listbridge.${m}`);
  }
  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /- src\/listbridge\/\*\*\/\*/, 'packaged build ships the ESM core');
});

