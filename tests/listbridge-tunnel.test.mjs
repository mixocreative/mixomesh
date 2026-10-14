// Listbridge temporary-link file host (plan PB.5b): filehosts/tunnel.cjs + the runner's
// uptime hold (jobs.cjs). Plain node, no network.
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
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createTunnelFileHost, findCloudflared, NOT_INSTALLED_MESSAGE, BUNDLE_MISSING_MESSAGE } = require('../electron/listbridge/filehosts/tunnel.cjs');
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
function makeHost({ mode = 'ok', ...opts } = {}) {
  /** @type {any} */
  let host = null;
  const spawnImpl = (_bin, args, o) => {
    const c = spawn(process.execPath, [FAKE, ...args], { ...o, env: { ...process.env, FAKE_CF_MODE: mode } });
    spawned.push({ child: c, args });
    return c;
  };
  const fetchImpl = (url, o) => fetch(String(url).replace(PUBLIC, host.localOrigin), o);
  host = createTunnelFileHost({ binaryPath: FAKE, spawnImpl, fetchImpl, ...opts });
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

    const res = await fetch(local(host, url));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello-3mf');
    assert.equal(res.headers.get('content-type'), 'model/3mf');
    assert.equal(res.headers.get('content-length'), '9');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="Dragon Bust (v2).3mf"; filename*=UTF-8''Dragon%20Bust%20%28v2%29.3mf`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS');
    const head = await fetch(local(host, url), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '9');
    assert.equal(await head.text(), '');

    // A second object reuses the same tunnel; unicode names get a safe ASCII fallback.
    const k2 = (await host.put('ドラゴン.png', enc('png'), 'image/png')).key;
    const u2 = await host.presignGet(k2);
    assert.equal(spawned.filter(s => s.args.includes(host.localOrigin)).length, 1, 'one tunnel per host');
    const r2 = await fetch(local(host, u2));
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
    const status = async (p, init) => (await fetch(o + p, init)).status;
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
      const r = await fetch(u, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
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
    assert.equal((await fetch(local(host, url))).status, 200);
    clock.t += 59_000;
    assert.equal((await fetch(local(host, url))).status, 200);
    clock.t += 1_000;
    assert.equal((await fetch(local(host, url))).status, 410);
    const again = await host.presignGet(key);   // default 3600 s
    assert.equal(again, url, 'same token/name: re-presign extends the expiry');
    assert.equal((await fetch(local(host, url))).status, 200);
    await host.remove(key);
    assert.equal((await fetch(local(host, url))).status, 404);
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
  await assert.rejects(fetch(url.replace(PUBLIC, origin)), 'server no longer listening');
  await assert.rejects(host.put('b', enc('b')), /closed/);
  await host.close();   // idempotent
});

test('cloudflared missing → install hint; resolution order: setting, bundled, vendor, PATH, Program Files', async () => {
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
  // Packaged app: the bundled copy wins; missing bundle = broken install, no PATH fallback.
  const bundled = path.join('C:\\app\\resources', 'listbridge', 'cloudflared.exe');
  assert.deepEqual(findCloudflared({ resourcesPath: 'C:\\app\\resources', exists: p => p === bundled, which: () => 'x', platform: 'win32' }), { path: bundled, error: null });
  assert.deepEqual(findCloudflared({ resourcesPath: 'C:\\app\\resources', exists: () => false, which: () => 'C:\\bin\\cloudflared.exe', platform: 'win32' }), { path: null, error: BUNDLE_MISSING_MESSAGE });
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
    binaryPath: FAKE, probeTimeoutMs: 0,
    spawnImpl: (_b, a, o) => { const c = spawn(process.execPath, [FAKE, ...a], o); spawned.push({ child: c, args: a }); return c; },
    fetchImpl: async () => new Response('nope', { status: 502 }),
  });
  const r = await blocked.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.message, /not reachable from the internet \(HTTP 502\)/);
  assert.doesNotMatch(r.message, /trycloudflare|[0-9a-f]{32}/);
  await blocked.close();
});

// ── runner: hold the tunnel until the platform confirms ───────────────────

function fakeAdapter({ confirmAfter = 0 } = {}) {
  let confirmCalls = 0;
  return {
    get confirmCalls() { return confirmCalls; },
    describe: () => ({ id: 'fake', label: 'Fake Market', transfer: 'url', maxFiles: 10, maxImages: 10, currencies: ['EUR'], fields: ['title'], credentials: [] }),
    validate: () => [],
    buildCreate: (pkg, ctx) => ({ method: 'POST', url: 'https://fake.test/gql', body: { op: 'create', files: ctx.files.map(f => f.url), images: ctx.images.map(i => i.url) } }),
    buildUpdate: (remoteId, pkg, ctx) => ({ method: 'POST', url: 'https://fake.test/gql', body: { op: 'update', remoteId, files: ctx.files.map(f => f.url) } }),
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

function setupRunner({ adapter, responder, maxWaitMs = 60_000, onSleep } = {}) {
  const clock = { t: 5_000_000 };
  const hosts = [];
  const events = [];
  const calls = [];
  const transport = {
    request: async req => {
      calls.push(req.body);
      const r = (await responder?.(req.body, calls.length)) ?? { json: { data: { remoteId: 'c1', url: 'https://fake.test/c/c1' } } };
      return { status: 200, ok: true, headers: {}, text: '', ...r };
    },
  };
  const runner = createPublishRunner({
    adapters: [adapter], core, transport,
    credentials: { get: async id => (id === 'filehost:tunnel' ? { type: 'tunnel' } : null) },
    makeFileHost: () => { const h = makeHost({ now: () => clock.t }); hosts.push(h); return h; },
    emit: e => events.push(e), now: () => clock.t,
    sleep: async ms => { clock.t += ms; await onSleep?.(); await new Promise(r => setImmediate(r)); },
    confirm: { polls: 2, intervalMs: 5000 }, hold: { maxWaitMs },
  });
  return { runner, hosts, events, calls, clock };
}

test('runner: the tunnel stays up (links servable) until the platform confirms, then closes', async () => {
  const adapter = fakeAdapter({ confirmAfter: 4 });   // more polls than confirm.polls: the hold wins
  let checks = 0;
  const ctx = setupRunner({
    adapter,
    onSleep: async () => {
      const url = ctx.calls[0].files[0];
      const res = await fetch(local(ctx.hosts[0], url));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '3MF-BYTES');
      checks++;
    },
  });
  const out = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(adapter.confirmCalls, 4);
  assert.equal(checks, 3, 'links served between every confirm poll');
  assert.ok(ctx.events.some(e => e.step === 'confirm' && e.hold && /Keep MIXOMESH open while Fake Market downloads the files/.test(e.message)));
  assert.equal(ctx.hosts[0].closed, true, 'closed after confirm + cleanup');
  assert.ok(await waitDead(spawned.at(-1).child.pid));
});

test('runner: without buildConfirm the links are held for hold.maxWaitMs, then closed', async () => {
  const ctx = setupRunner({ adapter: fakeAdapter(), maxWaitMs: 20_000 });
  const t0 = ctx.clock.t;
  const out = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(out.ok, true, out.error);
  assert.equal(ctx.clock.t - t0, 20_000);
  assert.ok(ctx.events.some(e => e.step === 'confirm' && e.status === 'done' && /Kept the temporary links open/.test(e.message)));
  assert.equal(ctx.hosts[0].closed, true);
});

test('runner: cancel during the hold closes the tunnel', async () => {
  let jobId = null;
  const ctx = setupRunner({ adapter: fakeAdapter(), maxWaitMs: 10 * 60_000 });
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

test('runner: a failed job keeps the tunnel so Retry reuses the URLs; a hold timeout closes it and Retry re-hosts + updates', async () => {
  let fail = true;
  const ctx = setupRunner({
    adapter: fakeAdapter({ confirmAfter: 1000 }), maxWaitMs: 30_000,
    responder: body => (body.op !== 'confirm' && fail ? { status: 500, ok: false } : undefined),
  });
  const first = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(first.failedStep, 'create');
  assert.equal(ctx.hosts[0].running, true, 'kept for retry');
  fail = false;
  const second = await ctx.runner.retry(first.jobId);
  // confirm never arrives → hold times out → links closed
  assert.equal(second.failedStep, 'confirm');
  assert.match(second.error, /did not confirm the files within 1 min, so the temporary links were closed/);
  assert.equal(ctx.hosts.length, 1, 'retry reused the same host');
  assert.deepEqual(ctx.calls[0].files, ctx.calls[1].files, 'retry sent the same URLs');
  assert.equal(ctx.hosts[0].closed, true);

  const third = await ctx.runner.retry(first.jobId);
  assert.equal(ctx.hosts.length, 2, 'new tunnel for the re-host');
  const update = ctx.calls.find(c => c.op === 'update');
  assert.equal(update.remoteId, 'c1', 'listing updated with fresh links');
  assert.notDeepEqual(update.files, ctx.calls[0].files);
  assert.equal(third.failedStep, 'confirm');
  assert.equal(ctx.hosts[1].closed, true);
});

test('runner: a failed job closes its tunnel after hold.maxWaitMs', async () => {
  const ctx = setupRunner({ adapter: fakeAdapter(), maxWaitMs: 150, responder: body => (body.op === 'create' ? { status: 500, ok: false } : undefined) });
  const out = await ctx.runner.start({ platform: 'fake', accountId: 'me', fileHostId: 'tunnel', pkg: makePkg() });
  assert.equal(out.failedStep, 'create');
  assert.equal(ctx.hosts[0].running, true);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(ctx.hosts[0].closed, true);
});

test('tunnel host source: no electron import, no logging', () => {
  const src = fs.readFileSync(new URL('../electron/listbridge/filehosts/tunnel.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/);
  assert.doesNotMatch(src, /console\./);
  assert.match(src, /listen\(0, '127\.0\.0\.1'/);
});
