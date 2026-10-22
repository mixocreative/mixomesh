// Listbridge temporary-link file host (plan PB.5b, PB.12): filehosts/tunnel.cjs (incl. Range
// + served coverage / stats()) + the runner's uptime hold (jobs.cjs). Plain node, no network.
//
// Test seam: a FAKE cloudflared (a tiny node script written to a temp dir) is launched via
// the injected `spawnImpl` (node <fake> tunnel --no-autoupdate --url http://127.0.0.1:<port>).
// It prints a quick-tunnel banner with https://fake-tunnel-abc.trycloudflare.com plus a
// "Registered tunnel connection" line to stderr and stays alive. Public URLs therefore
// carry the fake hostname; to fetch them "through the tunnel" the tests (and the host's
// testConnection, via its injected fetchImpl) swap that origin for the host's real
// loopback origin (`host.localOrigin`). Everything after the origin — token, name,
// expiry, headers — is exercised exactly as the platform would see it.
//   node --test tests/listbridge-tunnel.test.mjs

import assert from 'node:assert/strict';
import { localFetch } from './local-fetch.mjs';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createTunnelFileHost, findCloudflared, NOT_INSTALLED_MESSAGE } = require('../electron/listbridge/filehosts/tunnel.cjs');
const { createPublishRunner } = require('../electron/listbridge/jobs.cjs');

const PUBLIC = 'https://fake-tunnel-abc.trycloudflare.com';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-tunnel-'));
const FAKE = path.join(dir, 'fake-cloudflared.cjs');
fs.writeFileSync(FAKE, `
const mode = process.env.FAKE_CF_MODE || 'ok';
const args = process.argv.slice(2);
if (mode === 'exit') { process.stderr.write('ERR failed to request quick Tunnel: network down\\n'); process.exit(3); }
if (mode === 'ok') {
  process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');
  process.stderr.write('INF +----+\\nINF |  ${PUBLIC}  |\\nINF +----+\\n');
  process.stderr.write('INF origin ' + args[args.indexOf('--url') + 1] + '\\n');
  setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0\\n'), 30);
}
setInterval(() => {}, 1000);
`);
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

const spawned = [];
// DoH fake: every lookup resolves at once (the gate's own tests pass their own).
const dohAllOk = async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '203.0.113.7' }] }));
const noSleep = async () => {};
function makeHost({ mode = 'ok', ...opts } = {}) {
  /** @type {any} */
  let host = null;
  const spawnImpl = (_bin, args, o) => {
    const c = spawn(process.execPath, [FAKE, ...args], { ...o, env: { ...process.env, FAKE_CF_MODE: mode } });
    spawned.push({ child: c, args });
    return c;
  };
  const fetchImpl = (url, o) => localFetch(String(url).replace(PUBLIC, host.localOrigin), o);
  host = createTunnelFileHost({ binaryPath: FAKE, spawnImpl, fetchImpl, dohFetchImpl: dohAllOk, sleep: noSleep, ...opts });
  return host;
}
const local = (host, url) => url.replace(PUBLIC, host.localOrigin);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  return !alive(pid);
}
const enc = s => new TextEncoder().encode(s);

test('put → presignGet → GET serves the bytes with the right headers; HEAD has no body', async () => {
  const host = makeHost();
  try {
    assert.equal(host.requiresUptime, true);
    const { key } = await host.put('Dragon Bust (v2).3mf', enc('hello-3mf'), 'model/3mf');
    assert.doesNotMatch(key, /[0-9a-f]{32}/, 'runner keys are opaque, not tokens');
    assert.equal(host.localOrigin, null, 'nothing listens before the first presignGet');
    const url = await host.presignGet(key);
    assert.match(url, /^https:\/\/fake-tunnel-abc\.trycloudflare\.com\/[0-9a-f]{32}\/Dragon%20Bust%20%28v2%29\.3mf$/);
    assert.match(host.localOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(spawned.at(-1).args, ['tunnel', '--no-autoupdate', '--url', host.localOrigin]);

    const res = await localFetch(local(host, url));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello-3mf');
    assert.equal(res.headers.get('content-type'), 'model/3mf');
    assert.equal(res.headers.get('content-length'), '9');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="Dragon Bust (v2).3mf"; filename*=UTF-8''Dragon%20Bust%20%28v2%29.3mf`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS');
    const head = await localFetch(local(host, url), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '9');
    assert.equal(await head.text(), '');

    // A second object reuses the same tunnel; unicode names get a safe ASCII fallback.
    const k2 = (await host.put('ドラゴン.png', enc('png'), 'image/png')).key;
    const u2 = await host.presignGet(k2);
    assert.equal(spawned.filter(s => s.args.includes(host.localOrigin)).length, 1, 'one tunnel per host');
    const r2 = await localFetch(local(host, u2));
    assert.equal(r2.status, 200);
    assert.match(r2.headers.get('content-disposition'), /filename="____\.png"; filename\*=UTF-8''%E3%83%89/);
  } finally { await host.close(); }
});

test('only exact /<token>/<name> GET|HEAD is served: unknown token, traversal, listing, other methods', async () => {
  const host = makeHost();
  try {
    const { key } = await host.put('part.stl', enc('solid'), 'model/stl');
    const url = await host.presignGet(key);
    const u = new URL(local(host, url));
    const token = u.pathname.split('/')[1];
    const o = host.localOrigin;
    const status = async (p, init) => (await localFetch(o + p, init)).status;
    assert.equal(await status(`/${'0'.repeat(32)}/part.stl`), 404, 'unknown token');
    assert.equal(await status(`/${token}/other.stl`), 404, 'wrong name');
    assert.equal(await status(`/${token}/`), 404, 'directory listing');
    assert.equal(await status('/'), 404);
    assert.equal(await status(`/${token}`), 404);
    assert.equal(await status(`/${token}/..%2F..%2Fetc%2Fpasswd`), 404, 'encoded traversal');
    assert.equal(await status(`/${token}/%2e%2e`), 404);
    assert.equal(await status(`/${token}/part.stl/..`), 404);
    assert.equal(await status(`/${token.toUpperCase()}/part.stl`), 404, 'token is exact');
    assert.equal(await status(`/${token}/part.stl?x=1`), 200, 'query string ignored, not a bypass');
    // Raw traversal sent without URL normalisation:
    const raw = await new Promise((resolve, reject) => {
      const http = require('node:http');
      const req = http.request(`${o}/`, { path: `/${token}/../../../windows/win.ini` }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(raw, 404);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const r = await localFetch(u, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'GET, HEAD');
    }
  } finally { await host.close(); }
});

test('links expire at the presign expiry (410); remove() → 404', async () => {
  const clock = { t: 1_000_000 };
  const host = makeHost({ now: () => clock.t });
  try {
    const { key } = await host.put('a.zip', enc('zip'), 'application/zip');
    const url = await host.presignGet(key, 60);
    assert.equal((await localFetch(local(host, url))).status, 200);
    clock.t += 59_000;
    assert.equal((await localFetch(local(host, url))).status, 200);
    clock.t += 1_000;
    assert.equal((await localFetch(local(host, url))).status, 410);
    const again = await host.presignGet(key);   // default 3600 s
    assert.equal(again, url, 'same token/name: re-presign extends the expiry');
    assert.equal((await localFetch(local(host, url))).status, 200);
    await host.remove(key);
    assert.equal((await localFetch(local(host, url))).status, 404);
    await host.remove(key);   // idempotent
    await assert.rejects(host.presignGet(key), /unknown object key/);
    await assert.rejects(host.presignGet((await host.put('b', enc('b'))).key, 0), /positive/);
  } finally { await host.close(); }
});

test('close() kills cloudflared and stops the server; the host is single-use', async () => {
  const host = makeHost();
  const { key } = await host.put('a.txt', enc('a'), 'text/plain');
  const url = await host.presignGet(key);
  const origin = host.localOrigin;
  const pid = spawned.at(-1).child.pid;
  assert.ok(alive(pid) && host.running);
  await host.close();
  assert.ok(await waitDead(pid), 'cloudflared process tree killed');
  assert.equal(host.running, false);
  assert.equal(host.localOrigin, null);
  await assert.rejects(localFetch(url.replace(PUBLIC, origin)), 'server no longer listening');
  await assert.rejects(host.put('b', enc('b')), /closed/);
  await host.close();   // idempotent
});

// ── PB.12: Range support + served coverage (stats) ─────────────────────────
const tick = () => new Promise(r => setTimeout(r, 20));

test('Range: 206 + Content-Range + Accept-Ranges; suffix / open ranges; 416; multi-range and If-Range → 200', async () => {
  const host = makeHost();
  try {
    const { key } = await host.put('r.bin', enc('0123456789'), 'application/octet-stream');
    const url = local(host, await host.presignGet(key));
    const full = await localFetch(url);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    await full.arrayBuffer();
    const r1 = await localFetch(url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(r1.status, 206);
    assert.equal(r1.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(r1.headers.get('content-length'), '4');
    assert.equal(await r1.text(), '2345');
    const r2 = await localFetch(url, { headers: { Range: 'bytes=7-' } });
    assert.equal(await r2.text(), '789');
    const r3 = await localFetch(url, { headers: { Range: 'bytes=-3' } });
    assert.equal(r3.headers.get('content-range'), 'bytes 7-9/10');
    assert.equal(await r3.text(), '789');
    const r4 = await localFetch(url, { headers: { Range: 'bytes=8-100' } });
    assert.equal(r4.headers.get('content-range'), 'bytes 8-9/10');
    await r4.arrayBuffer();
    const r416 = await localFetch(url, { headers: { Range: 'bytes=10-' } });
    assert.equal(r416.status, 416);
    assert.equal(r416.headers.get('content-range'), 'bytes */10');
    await r416.arrayBuffer();
    const multi = await localFetch(url, { headers: { Range: 'bytes=0-1,4-5' } });
    assert.equal(multi.status, 200);
    assert.equal(await multi.text(), '0123456789');
    const ifr = await localFetch(url, { headers: { Range: 'bytes=0-1', 'If-Range': '"x"' } });
    assert.equal(ifr.status, 200);
    await ifr.arrayBuffer();
    const headR = await localFetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
    assert.equal(headR.status, 206);
    assert.equal(await headR.text(), '');
  } finally { await host.close(); }
});

test('stats(): served = every byte delivered at least once by finished GETs; HEAD / 404 / 416 / aborted never count', async () => {
  const host = makeHost();
  try {
    const a = (await host.put('a.3mf', enc('AAAAAAAAAA'), 'model/3mf')).key;
    const b = (await host.put('b.png', enc('BBBB'), 'image/png')).key;
    const ua = local(host, await host.presignGet(a));
    const ub = local(host, await host.presignGet(b));
    assert.deepEqual(host.stats(), { served: 0, total: 2 });

    await (await localFetch(ua, { method: 'HEAD' })).arrayBuffer();
    await (await localFetch(ua, { headers: { Range: 'bytes=20-' } })).arrayBuffer();     // 416
    await (await localFetch(ua.replace(/\/[^/]+$/, '/wrong.3mf'))).arrayBuffer();        // 404
    await tick();
    assert.deepEqual(host.stats(), { served: 0, total: 2 }, 'HEAD / 416 / 404 do not count');

    // Range-only fetch: two overlapping halves, the second leaves a gap, then the gap.
    await (await localFetch(ua, { headers: { Range: 'bytes=0-4' } })).arrayBuffer();
    await (await localFetch(ua, { headers: { Range: 'bytes=3-6' } })).arrayBuffer();
    await tick();
    assert.equal(host.stats().served, 0, 'bytes 7-9 not delivered yet');
    await (await localFetch(ua, { headers: { Range: 'bytes=-3' } })).arrayBuffer();
    await tick();
    assert.deepEqual(host.stats(), { served: 1, total: 2 }, 'ranges merged → fully covered');

    await (await localFetch(ub)).arrayBuffer();
    await tick();
    assert.deepEqual(host.stats(), { served: 2, total: 2 });

    await host.remove(b);
    assert.deepEqual(host.stats(), { served: 1, total: 1 }, 'removed objects drop out of both counts');
  } finally { await host.close(); }
});

test('stats(): a GET aborted mid-body is not counted as served', async () => {
  const host = makeHost();
  try {
    const big = new Uint8Array(96 * 1024 * 1024).fill(7);
    const { key } = await host.put('big.zip', big, 'application/zip');
    const url = local(host, await host.presignGet(key));
    await new Promise((resolve, reject) => {
      // A stalled client: read nothing (backpressure), then drop the connection.
      const req = http.get(url, res => {
        res.pause();
        setTimeout(() => { req.destroy(); resolve(undefined); }, 150);
      });
      req.on('error', err => (err.code === 'ECONNRESET' ? resolve(undefined) : reject(err)));
    });
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(host.stats(), { served: 0, total: 1 });
    // A later complete fetch does count.
    const res = await localFetch(url);
    assert.equal((await res.arrayBuffer()).byteLength, big.byteLength);
    await tick();
    assert.deepEqual(host.stats(), { served: 1, total: 1 });
  } finally { await host.close(); }
});

test('parseRange edge cases', () => {
  const { parseRange } = require('../electron/listbridge/filehosts/tunnel.cjs')._internal;
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange('bytes=5-2', 10), null, 'reversed → ignored (full body)');
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.deepEqual(parseRange('bytes=-50', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
});

test('cloudflared missing → install hint; resolution order: setting, downloaded, vendor, PATH, Program Files', async () => {
  const host = createTunnelFileHost({ resolveBinary: () => findCloudflared({ exists: () => false, which: () => null, platform: 'win32' }) });
  const { key } = await host.put('a', enc('a'));
  await assert.rejects(host.presignGet(key), e => e.message === NOT_INSTALLED_MESSAGE);
  assert.equal(NOT_INSTALLED_MESSAGE, 'cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared');
  const t = await host.testConnection();
  assert.deepEqual(t, { ok: false, message: NOT_INSTALLED_MESSAGE });
  await host.close();

  const seen = [];
  const exists = p => { seen.push(p); return false; };
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' };
  findCloudflared({ settingPath: 'C:\\set\\cf.exe', repoRoot: 'R:\\repo', exists, which: () => 'C:\\bin\\cloudflared.exe', env, platform: 'win32' });
  assert.deepEqual(seen, [
    'C:\\set\\cf.exe',
    path.join('R:\\repo', 'vendor', 'cloudflared', 'cloudflared-windows-amd64.exe'),
    'C:\\bin\\cloudflared.exe',
    path.join('C:\\PF86', 'cloudflared', 'cloudflared.exe'),
    path.join('C:\\PF', 'cloudflared', 'cloudflared.exe'),
  ]);
  // Packaged app: the downloaded copy wins over PATH; nothing bundled in resources any more.
  const dl = path.join('U:/ud', 'listbridge', 'cloudflared.exe');
  assert.deepEqual(findCloudflared({ userDataDir: 'U:/ud', exists: p => p === dl, which: () => 'x', platform: 'win32' }), { path: dl, error: null });
  assert.deepEqual(findCloudflared({ userDataDir: 'U:/ud', exists: () => false, which: () => null, platform: 'win32' }), { path: null, error: NOT_INSTALLED_MESSAGE });
  assert.deepEqual(findCloudflared({ repoRoot: 'R:\\repo', exists: p => p === 'C:\\bin\\cloudflared.exe', which: () => 'C:\\bin\\cloudflared.exe', env, platform: 'win32' }), { path: 'C:\\bin\\cloudflared.exe', error: null });
});

test('tunnel startup: timeout and early exit give clear errors and leave no process behind', async () => {
  const slow = makeHost({ mode: 'silent', startupTimeoutMs: 400 });
  const { key } = await slow.put('a', enc('a'));
  await assert.rejects(slow.presignGet(key), /did not start within 0 s\. Check the internet connection/);
  assert.ok(await waitDead(spawned.at(-1).child.pid), 'timed-out cloudflared killed');
  await slow.close();

  const dead = makeHost({ mode: 'exit' });
  const k2 = (await dead.put('a', enc('a'))).key;
  await assert.rejects(dead.presignGet(k2), /cloudflared exited before the temporary link was ready \(code 3\): ERR failed to request quick Tunnel: network down/);
  await dead.close();
});

test('testConnection fetches a probe through the public URL, removes it, keeps the tunnel', async () => {
  const host = makeHost();
  try {
    const r = await host.testConnection();
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /Temporary link works/);
    assert.equal(host.running, true, 'tunnel kept for the job');
    const pid = spawned.at(-1).child.pid;
    const { key } = await host.put('a', enc('a'));
    await host.presignGet(key);
    assert.equal(spawned.at(-1).child.pid, pid, 'same tunnel reused');
  } finally { await host.close(); }

  // Unreachable public URL → ok:false, message without the URL / token.
  const blocked = createTunnelFileHost({
    binaryPath: FAKE, probeTimeoutMs: 5000, dohFetchImpl: dohAllOk, sleep: noSleep,
    spawnImpl: (_b, a, o) => { const c = spawn(process.execPath, [FAKE, ...a], o); spawned.push({ child: c, args: a }); return c; },
    fetchImpl: async () => new Response('nope', { status: 502 }),
  });
  const r = await blocked.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.message, /not reachable from the internet yet \(HTTP 502\)/);
  assert.doesNotMatch(r.message, /trycloudflare|[0-9a-f]{32}/);
  await blocked.close();
});

// ── runner: hold the tunnel until the platform fetched everything ─────────

function fakeAdapter({ confirmAfter = 0 } = {}) {
  let confirmCalls = 0;
  return {
    get confirmCalls() { return confirmCalls; },
    describe: () => ({ id: 'fake', label: 'Fake Market', transfer: 'url', maxFiles: 10, maxImages: 10, currencies: ['EUR'], fields: ['title'], credentials: [] }),
    validate: () => [],
    buildCreate: (pkg, ctx) => ({ method: 'POST', url: 'https://fake.test/gql', body: { op: 'create', files: ctx.files.map(f => f.url), images: ctx.images.map(i => i.url) } }),
    buildUpdate: (remoteId, pkg, ctx) => ({ method: 'POST', url: 'https://fake.test/gql', body: { op: 'update', remoteId, files: ctx.files.map(f => f.url), images: ctx.images.map(i => i.url) } }),
    parseResult: res => res.json.data,
    ...(confirmAfter ? {
      buildConfirm: r => ({ method: 'POST', url: 'https://fake.test/gql', body: { op: 'confirm', id: r.remoteId } }),
      parseConfirm: () => ({ confirmed: ++confirmCalls >= confirmAfter, status: 'published' }),
    } : {}),
  };
}

function makePkg() {
  return core.createListing({
    title: 'Dragon Bust', description: 'A bust.', tags: ['dragon'], price: { amount: 4, currency: 'EUR' },
    license: 'cc-by', madeWithAi: false,
    images: [{ name: 'hero.png', mime: 'image/png', bytes: enc('PNG'), role: 'hero' }],
    files: [{ name: 'part.3mf', mime: 'model/3mf', bytes: enc('3MF-BYTES') }],
  });
}

function setupRunner({ adapter, responder, holdMs = 60_000, retryWindowMs = 60_000, onSleep, hostOpts, publicWaitMs } = {}) {
  const clock = { t: 5_000_000 };
  const hosts = [];
  const events = [];
  const calls = [];
  let puts = 0;
  const transport = {
    request: async req => {
      calls.push(req.body);
      const r = (await responder?.(req.body, calls.length)) ?? { json: { data: { remoteId: 'c1', url: 'https://fake.test/c/c1' } } };
      return { status: 200, ok: true, headers: {}, text: '', ...r };
    },
  };
  const hooks = { onSleep };
  const runner = createPublishRunner({
    adapters: [adapter], core, transport,
    credentials: { get: async id => (id === 'filehost:tunnel' ? { type: 'tunnel' } : null) },
    makeFileHost: () => {
      const h = makeHost({ now: () => clock.t, ...(hostOpts ? hostOpts(clock) : {}) });
      hosts.push(h);
      return { ...h, put: (...a) => { puts++; return h.put(...a); }, get running() { return h.running; }, get closed() { return h.closed; }, get localOrigin() { return h.localOrigin; } };
    },
    emit: e => events.push(e), now: () => clock.t,
    sleep: async ms => { clock.t += ms; await hooks.onSleep?.(); await new Promise(r => setImmediate(r)); },
    confirm: { polls: 2, intervalMs: 5000, holdMs, retryWindowMs, ...(publicWaitMs != null ? { publicWaitMs } : {}) },
  });
  return { runner, hosts, events, calls, clock, hooks, get puts() { return puts; } };
}

// Fetch every URL the platform was given (file + image), fully, through the loopback origin.
async function platformFetchAll(ctx, call = ctx.calls[0]) {
  for (const u of [...call.files, ...call.images]) {
    const res = await localFetch(local(ctx.hosts.at(-1), u));
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
  await new Promise(r => setTimeout(r, 20));
}

test('runner: held until every object is served AND the platform confirms; structured progress; then closed', async () => {
  const adapter = fakeAdapter({ confirmAfter: 2 });
  let sleeps = 0;
  const ctx = setupRunner({
    adapter,
    onSleep: async () => { if (++sleeps === 3) await platformFetchAll(ctx); },
  });
  const out = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(adapter.confirmCalls, 2, 'adapter queried only once everything was served');
  const hold = ctx.events.filter(e => e.step === 'confirm' && e.status === 'running' && e.hold);
  assert.deepEqual(hold.slice(0, 3).map(e => [e.served, e.total]), [[0, 2], [0, 2], [0, 2]]);
  assert.equal(hold[0].holdRemainingMs, 60_000);
  assert.equal(hold[1].holdRemainingMs, 55_000);
  assert.match(hold[0].message, /Keep MIXOMESH open while Fake Market downloads the files \(0\/2\)/);
  assert.deepEqual([hold.at(-1).served, hold.at(-1).total], [2, 2], 'served 2/2, waiting for the adapter');
  assert.equal(ctx.hosts[0].closed, true, 'closed on done');
  assert.ok(await waitDead(spawned.at(-1).child.pid));
});

test('runner: hold expiry fails at confirm, links stay up; Retry inside the window resumes on the SAME URLs (no re-put)', async () => {
  const ctx = setupRunner({ adapter: fakeAdapter(), holdMs: 20_000 });
  const first = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(first.failedStep, 'confirm');
  assert.match(first.error, /Fake Market has not finished downloading the files \(0\/2 downloaded\) after 1 min/);
  assert.equal(ctx.hosts[0].running, true, 'links kept for Retry');
  const failed = ctx.events.find(e => e.status === 'failed');
  assert.equal(failed.linksOpenMs, 60_000, 'hold already over → fresh retry window');
  const putsBefore = ctx.puts;
  await platformFetchAll(ctx);                // the platform finally downloads
  const second = await ctx.runner.retry(first.jobId);
  assert.equal(second.ok, true, second.error);
  assert.equal(ctx.puts, putsBefore, 'no re-put');
  assert.equal(ctx.hosts.length, 1, 'same tunnel');
  assert.deepEqual(ctx.calls.map(c => c.op), ['create'], 'no update: the platform still has the same URLs');
  assert.equal(ctx.hosts[0].closed, true, 'closed on done');
});

test('runner: cancel during the hold closes the tunnel', async () => {
  let jobId = null;
  const ctx = setupRunner({ adapter: fakeAdapter(), holdMs: 10 * 60_000 });
  let cancelP = null;
  ctx.events.push = function (e) {
    if (e.hold && !cancelP) cancelP = ctx.runner.cancel(jobId);
    return Array.prototype.push.call(this, e);
  };
  jobId = ctx.runner.create({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  const out = await ctx.runner.run(jobId);
  assert.equal(out.status, 'cancelled');
  assert.equal((await cancelP).status, 'cancelled');
  assert.equal(out.leftover, undefined);
  assert.equal(ctx.hosts[0].closed, true);
  assert.ok(await waitDead(spawned.at(-1).child.pid));
});

test('runner: retry-window expiry closes the tunnel; Retry then re-hosts and UPDATES the listing', async () => {
  let fail = true;
  const ctx = setupRunner({
    adapter: fakeAdapter(), holdMs: 20_000, retryWindowMs: 150,
    responder: body => (body.op === 'create' && fail ? { status: 400, ok: false } : undefined),
  });
  const first = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(first.failedStep, 'create');
  assert.equal(ctx.hosts[0].running, true, 'kept for retry');
  fail = false;
  const second = await ctx.runner.retry(first.jobId);        // create ok, nothing fetched → hold expires
  assert.equal(second.failedStep, 'confirm');
  assert.equal(ctx.hosts.length, 1, 'retry reused the same host');
  assert.deepEqual(ctx.calls[0].files, ctx.calls[1].files, 'retry sent the same URLs');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(ctx.hosts[0].closed, true, 'closed when the retry window ran out');
  assert.ok(await waitDead(spawned.at(-1).child.pid));

  // The "platform" fetches the fresh links once the update carrying them was sent.
  let fetched = false;
  ctx.hooks.onSleep = async () => {
    const update = ctx.calls.find(c => c.op === 'update');
    if (update && !fetched) { fetched = true; await platformFetchAll(ctx, update); }
  };
  const third = await ctx.runner.retry(first.jobId);
  assert.equal(ctx.hosts.length, 2, 'new tunnel for the re-host');
  const update = ctx.calls.find(c => c.op === 'update');
  assert.equal(update.remoteId, 'c1', 'listing updated with fresh links');
  assert.notDeepEqual(update.files, ctx.calls[0].files);
  assert.equal(third.ok, true, third.error);
  assert.equal(ctx.hosts[1].closed, true);
});

// ── PB.16 readiness gate ─────────────────────────────────────────────────

const nx = () => new Response(JSON.stringify({ Status: 3 }));   // NXDOMAIN
const answer = () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '203.0.113.7' }] }));

test('PB.16 gate: waits for BOTH DoH resolvers, then 2 stable polls, then probes; DoH only (headers + URLs)', async () => {
  // Per poll round: [cloudflare, google] → NX/NX, ok/NX, ok/ok, ok/NX (reset), ok/ok, ok/ok → ready on round 6.
  const script = [[nx, nx], [answer, nx], [answer, answer], [answer, nx], [answer, answer], [answer, answer]];
  const seen = []; const log = []; const sleeps = [];
  const counts = { cf: 0, g: 0 };
  const dohFetchImpl = async (url, o) => {
    const u = new URL(url);
    assert.equal(o.headers.accept, 'application/dns-json');
    assert.equal(u.searchParams.get('type'), 'A');
    assert.equal(u.searchParams.get('name'), 'fake-tunnel-abc.trycloudflare.com');
    const which = u.hostname === 'cloudflare-dns.com' ? 'cf' : u.hostname === 'dns.google' ? 'g' : null;
    assert.ok(which, `unexpected resolver ${u.hostname}`);
    seen.push(u.origin + u.pathname);
    const round = counts[which]++;
    log.push(`doh:${which}`);
    return script[Math.min(round, script.length - 1)][which === 'cf' ? 0 : 1]();
  };
  const host = makeHost({
    dohFetchImpl, sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async (url, o) => { log.push('probe'); return localFetch(String(url).replace(PUBLIC, host.localOrigin), o); },
  });
  try {
    const phases = [];
    const r = await host.waitUntilPublic({ onProgress: p => phases.push(p.phase) });
    assert.deepEqual(counts, { cf: 6, g: 6 });
    assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000], 'polls every 1 s');
    assert.deepEqual(phases, ['dns', 'probe']);
    assert.equal(log.indexOf('probe'), 12, 'probe only after all 12 DoH lookups');
    assert.deepEqual([...new Set(seen)].sort(), ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']);
    assert.ok(r.base.startsWith(PUBLIC));
    // Second call on the same tunnel is instant (no new lookups).
    await host.waitUntilPublic();
    assert.equal(counts.cf, 6);
  } finally { await host.close(); }
});

test('PB.16 probe: retries 530 with 2 s backoff then succeeds; probe is hidden from stats() and removed', async () => {
  const sleeps = []; let n = 0; let during = null; let host = null;
  host = makeHost({
    sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async (url, o) => {
      if (++n <= 2) return new Response('edge', { status: 530 });
      during = host.stats();
      return localFetch(String(url).replace(PUBLIC, host.localOrigin), o);
    },
  });
  try {
    const { key } = await host.put('a.txt', enc('a'));
    await host.presignGet(key);
    await host.waitUntilPublic();
    assert.equal(n, 3);
    assert.deepEqual(sleeps.filter(ms => ms === 2000), [2000, 2000]);
    assert.deepEqual(during, { served: 0, total: 1 }, 'probe object excluded while it exists');
    assert.deepEqual(host.stats(), { served: 0, total: 1 }, 'and after');
    // Removed: a second hidden object is gone → total unchanged and map empty of probes.
    const only = await host.put('b.txt', enc('b'));
    assert.deepEqual(host.stats(), { served: 0, total: 2 });
    await host.remove(only.key);
  } finally { await host.close(); }
});

test('PB.16 probe: a byte mismatch fails with code tunnel-not-public', async () => {
  const host = makeHost({ fetchImpl: async () => new Response(Buffer.from('some captive portal page')) });
  try {
    await assert.rejects(host.waitUntilPublic({ timeoutMs: 60_000 }), e => e.code === 'tunnel-not-public' && /probe bytes differ/.test(e.message) && !/trycloudflare/.test(e.message));
    assert.deepEqual(host.stats(), { served: 0, total: 0 });
  } finally { await host.close(); }
});

test('PB.16 job: timeout fails the host step with tunnel-not-public, the platform got NOTHING; Retry re-runs the gate', async () => {
  const adapter = fakeAdapter();
  let created = 0;
  const base = adapter.buildCreate;
  adapter.buildCreate = (...a) => { created++; return base(...a); };
  let dnsUp = false;
  let sleeps = 0;
  const ctx = setupRunner({
    adapter, publicWaitMs: 5000,
    hostOpts: clock => ({ dohFetchImpl: async () => (dnsUp ? answer() : nx()), sleep: async ms => { clock.t += ms; } }),
    onSleep: async () => { if (++sleeps === 1) await platformFetchAll(ctx); },
  });
  const first = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(first.ok, false);
  assert.equal(first.failedStep, 'host');
  const failed = ctx.events.find(e => e.status === 'failed');
  assert.equal(first.code, 'tunnel-not-public');
  assert.ok(failed);
  assert.equal(created, 0, 'buildCreate never called');
  assert.equal(ctx.calls.length, 0, 'nothing sent to the platform');
  assert.ok(ctx.events.some(e => e.step === 'host' && e.status === 'running' && e.phase === 'dns' && /reachable/.test(e.message)));
  assert.equal(ctx.hosts[0].running, true, 'tunnel not restarted/killed');
  const putsBefore = ctx.puts;

  dnsUp = true;
  const second = await ctx.runner.retry(first.jobId);
  assert.equal(second.ok, true, second.error);
  assert.equal(created, 1);
  assert.equal(ctx.puts, putsBefore, 'hosted objects reused');
  assert.equal(ctx.hosts.length, 1, 'same tunnel');
  const order = ctx.events.filter(e => (e.step === 'host' && e.phase === 'probe') || e.step === 'create').map(e => `${e.step}:${e.phase || e.status}`);
  assert.ok(order.includes('host:probe') && order.indexOf('host:probe') < order.indexOf('create:running'), 'gate precedes the publish step: ' + order.join());
});

test('PB.16 S3-style host (no waitUntilPublic): host step unchanged, no gate events', async () => {
  const adapter = fakeAdapter();
  const calls = [];
  const store = new Map();
  const runner = createPublishRunner({
    adapters: [adapter], core,
    transport: { request: async req => { calls.push(req.body); return { status: 200, ok: true, headers: {}, text: '', json: { data: { remoteId: 'c1', url: 'https://fake.test/c/c1' } } }; } },
    credentials: { get: async id => (id === 'filehost:r2' ? { type: 's3' } : null) },
    makeFileHost: () => ({
      async put(name, bytes) { const key = `k${store.size}`; store.set(key, bytes); return { key }; },
      async presignGet(key) { return `https://bucket.test/${key}`; },
      async remove(key) { store.delete(key); },
    }),
    emit: () => {}, sleep: async () => {},
  });
  const events = [];
  const id = runner.create({ platform: 'fake', accountId: 'me', fileHostId: 'r2', pkg: makePkg(), onProgress: e => events.push(e) });
  const out = await runner.run(id);
  assert.equal(out.ok, true, out.error);
  assert.equal(events.some(e => e.phase), false, 'no readiness phases for hosts without the gate');
  assert.equal(calls[0].files[0], 'https://bucket.test/k0');
});

test('tunnel host source: no electron import, no logging', () => {
  const src = fs.readFileSync(new URL('../electron/listbridge/filehosts/tunnel.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/);
  assert.doesNotMatch(src, /console\./);
  assert.match(src, /listen\(0, '127\.0\.0\.1'/);
});
