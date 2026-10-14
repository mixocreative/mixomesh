// PB.15 part 2: in-app dress rehearsal. Opt-in (needs network):
//   LIVE_TUNNEL=1 node tests/listbridge-rehearsal.mjs        (npm run test:rehearsal)
// Real dev Electron (Vite dev server + LISTBRIDGE_FAKE_PLATFORM=1, a throw-away userData dir),
// driven over CDP. The renderer runs the REAL PublishClient (real export pipeline -> IPC ->
// runner -> real cloudflared tunnel) against a FAKE Cults: a local GraphQL server that, like
// Cults, downloads every fileUrl / imageUrl through the PUBLIC tunnel after createCreation and
// answers a confirm read-back once all of them arrived.
// Asserts: outcome ok, remoteId saved in project.listings, every object downloaded through the
// tunnel (sha256 equal to what the renderer sent), tunnel closed after done, no stray cloudflared.
// Never part of `npm test`.

import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  freePort, waitForHttp, Cdp, evaluate, waitFor, assert, sleep, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

if (process.env.LIVE_TUNNEL !== '1') {
  console.log('SKIP listbridge rehearsal (set LIVE_TUNNEL=1 to run; needs network + cloudflared)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const ELECTRON = require('electron');   // path to electron.exe
const NICK = 'rehearsal';
const KEY = 'rehearsal-key-not-secret';

function cloudflaredPids() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return new Set(out.split(/\r?\n/).map(l => /^"(?:cloudflared[^"]*)\.exe","(\d+)"/i.exec(l)?.[1]).filter(Boolean).map(Number));
    }
    return new Set(execFileSync('pgrep', ['-x', 'cloudflared'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number));
  } catch { return new Set(); }
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// ── Fake Cults ──────────────────────────────────────────────────────────────
const fake = {
  creates: [], confirms: 0, ours: [], authOk: false, downloads: [],   // downloads: { url, status, bytes, sha, ms }
  pending: null, done: false, failure: null,
};
const before = cloudflaredPids();

async function downloadAll(urls) {
  // PB.16: ONE attempt per URL, no retries, no sleeping. Like a real platform, the first lookup
  // of the hostname poisons DNS if it happens too early, so the app's readiness gate (DoH
  // resolve + public probe BEFORE createCreation) is what must make this pass first time.
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      fake.downloads.push({ url, status: r.status, bytes: buf.length, sha: sha256(buf), ms: Date.now() - t0, attempts: 1 });
    } catch (err) {
      fake.downloads.push({ url, status: 0, error: String(err?.cause?.code || err?.message || err), ms: Date.now() - t0, attempts: 1 });
    }
  }
  fake.done = true;
}

const gql = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const reply = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let q;
    try { q = JSON.parse(body); } catch { return reply({ errors: [{ message: 'bad json' }] }, 400); }
    const expectAuth = `Basic ${Buffer.from(`${NICK}:${KEY}`).toString('base64')}`;
    if (req.headers.authorization !== expectAuth) return reply({ errors: [{ message: 'unauthorized' }] }, 401);
    fake.authOk = true;
    if (/createCreation/.test(q.query)) {
      const v = q.variables || {};
      const urls = [...(v.fileUrls || []), ...(v.imageUrls || [])];
      fake.creates.push({ name: v.name, urls });
      fake.ours = [...cloudflaredPids()].filter(p => !before.has(p));   // tunnel is up right now
      // Like Cults: answer first, ingest asynchronously.
      setTimeout(() => { fake.pending = downloadAll(urls); }, 400);
      return reply({ data: { createCreation: { creation: { id: 'fake-cults-1', url: 'https://cults3d.com/en/3d-model/fake/fake-cults-1' }, errors: [] } } });
    }
    if (/Confirm/.test(q.query)) {
      fake.confirms++;
      return reply({ data: { creation: { id: q.variables?.id, url: 'https://cults3d.com/en/3d-model/fake/fake-cults-1', filesIngested: fake.done } } });
    }
    return reply({ data: { myself: { user: { nick: NICK } } } });
  });
});
await new Promise(r => gql.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${gql.address().port}/graphql`;

// ── Electron + Vite ─────────────────────────────────────────────────────────
const appPort = await freePort();
const debugPort = await freePort();
const userData = mkdtempSync(join(tmpdir(), 'mixo-rehearsal-'));
const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const viteOut = [];
vite.stdout.on('data', c => viteOut.push(String(c)));
vite.stderr.on('data', c => viteOut.push(String(c)));
let electron = null;
let cdp = null;
const tAll = Date.now();
let failed = false;

try {
  await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 30000, viteOut);
  electron = spawn(ELECTRON, ['electron/main.cjs', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', MIXO_DEV_URL: `http://127.0.0.1:${appPort}/index.html`,
      LISTBRIDGE_FAKE_PLATFORM: '1', LISTBRIDGE_FAKE_URL: fakeUrl,
    },
  });
  const eOut = [];
  electron.stdout.on('data', c => eOut.push(String(c)));
  electron.stderr.on('data', c => eOut.push(String(c)));
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 40000, eOut);
  let target = null;
  await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target = list.find(t => t.type === 'page' && String(t.url).startsWith(`http://127.0.0.1:${appPort}`));
    return !!target;
  }, 30000, 'electron page target');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const pageErrors = [];
  cdp.onEvent = msg => {
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
  };
  await cdp.send('Runtime.enable');
  await waitFor(() => evaluate(cdp, `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!window.BABYLON?.SceneLoader`), 60000, 'app boot');
  await evaluate(cdp, `(() => { try { localStorage.setItem('mx-onboard-v1', '1'); } catch { /* */ } document.querySelector('.ob-skip')?.click(); })()`);

  // The fake must really be in place (describe goes through the real IPC).
  const desc = await evaluate(cdp, `window.electronAPI.listbridge.describe().then(d => ({ ids: d.platforms.map(p => p.id), transfer: d.platforms[0]?.transfer, def: d.defaultFileHost }))`);
  assert(desc.ids.includes('cults3d') && desc.transfer === 'url' && desc.def === 'tunnel', `describe: ${JSON.stringify(desc)}`);

  // Kick the publish off (long-running: poll for the result instead of one 30 s CDP call).
  const kick = await evaluate(cdp, `(async () => {
    try {
      const { caps } = await import('/src/core/storage/capabilities.js');
      if (!caps.publish) return { error: 'caps.publish is false in the Electron shell' };
      const api = window.electronAPI.listbridge;
      await api.setCredentials('cults3d:default', { nickname: ${JSON.stringify(NICK)}, apiKey: ${JSON.stringify(KEY)} });
      const blob = await (await fetch('/tests/fixtures/textured-quad.glb')).blob();
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const ids = await AssetLoader.loadFromBlob(blob, 'textured-quad.glb');
      const Client = await import('/src/core/publish/PublishClient.js');
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d'); g.fillStyle = '#c2410c'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff'; g.fillRect(16, 16, 32, 32);
      const hero = await new Promise(r => c.toBlob(r, 'image/png'));
      const built = await Client.buildListingPackage({
        listing: { title: 'Rehearsal quad', description: 'Dress rehearsal listing.', tags: ['rehearsal', 'test'], price: { amount: 4, currency: 'EUR' }, license: null, madeWithAi: false },
        exportSelection: { formats: ['stl', '3mf'], options: { acknowledgeWarnings: true } },
        heroBlob: hero,
      });
      if (built.blocked) return { error: 'export gate blocked: ' + built.code };
      const pkg = built.pkg;
      const hex = async u8 => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('');
      const sent = [];
      for (const f of pkg.files) sent.push({ name: f.name, bytes: f.bytes.byteLength, sha: await hex(f.bytes) });
      for (const i of pkg.images) sent.push({ name: i.name, bytes: i.bytes.byteLength, sha: await hex(i.bytes) });
      window.__reh = { events: [], sent, outcome: null, error: null };
      Client.publish(pkg, { platform: 'cults3d', accountId: 'default', fileHostId: 'tunnel' }, e => window.__reh.events.push({ ...e, t: Date.now() }))
        .then(o => { window.__reh.outcome = o; }, e => { window.__reh.error = String(e?.stack || e); });
      return { started: true, sent };
    } catch (err) { return { error: String(err?.stack ?? err) }; }
  })()`);
  assert(!kick?.error, `kick-off failed: ${kick?.error}`);
  console.log(`publishing ${kick.sent.length} objects: ${kick.sent.map(s => `${s.name} (${s.bytes} B)`).join(', ')}`);
  const t0 = Date.now();

  await waitFor(() => evaluate(cdp, `!!(window.__reh.outcome || window.__reh.error)`), 240000, 'publish outcome');
  const publishS = (Date.now() - t0) / 1000;
  const res = await evaluate(cdp, `(async () => {
    const { getState } = await import('/src/core/StateManager.js');
    return { reh: window.__reh, listings: getState().project.listings };
  })()`);
  if (res.reh.error) throw new Error(`renderer publish threw: ${res.reh.error}`);
  const out = res.reh.outcome;
  const steps = res.reh.events.filter(e => e.status === 'done').map(e => e.step);
  console.log(`steps done: ${steps.join(' > ')}`);
  const ev = res.reh.events;
  const tAt = f => ev.find(f)?.t;
  const tDns = tAt(e => e.phase === 'dns'); const tProbe = tAt(e => e.phase === 'probe'); const tCreate = tAt(e => e.step === 'create' && e.status === 'running');
  assert(tDns && tProbe && tCreate && tDns <= tProbe && tProbe <= tCreate, 'readiness gate (dns -> probe) must run before the create step');
  console.log(`readiness gate: DoH ready ${((tProbe - tDns) / 1000).toFixed(1)} s, probe ok ${((tCreate - tProbe) / 1000).toFixed(1)} s (until create)`);

  assert(out.ok === true && out.status === 'done', `outcome not ok: ${JSON.stringify(out)}`);
  assert(out.result.remoteId === 'fake-cults-1', `remoteId: ${JSON.stringify(out.result)}`);
  const rec = res.listings.find(l => l.platform === 'cults3d');
  assert(rec && rec.remoteId === 'fake-cults-1' && rec.status === 'published', `project.listings: ${JSON.stringify(res.listings)}`);

  // Everything Cults was told to fetch was fetched through the PUBLIC tunnel, byte-identical.
  assert(fake.authOk, 'fake Cults never saw the Basic auth header');
  assert(fake.creates.length === 1, `expected exactly one createCreation, got ${fake.creates.length}`);
  const urls = fake.creates[0].urls;
  assert(urls.length === kick.sent.length, `fake got ${urls.length} urls, renderer sent ${kick.sent.length} objects`);
  assert(urls.every(u => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\//.test(u)), `urls are not public tunnel links: ${urls.join(' ')}`);
  assert(fake.downloads.length === urls.length, `downloaded ${fake.downloads.length}/${urls.length}`);
  for (const d of fake.downloads) assert(d.status === 200 && d.attempts === 1, `download (single attempt) ${d.url} -> ${d.status} ${d.error || ''}`);
  const sentShas = kick.sent.map(s => s.sha).sort();
  assert(JSON.stringify(fake.downloads.map(d => d.sha).sort()) === JSON.stringify(sentShas), 'downloaded bytes differ from what the renderer sent');
  assert(fake.confirms >= 1, 'the confirm read-back was never polled');
  console.log(`fake Cults downloaded ${fake.downloads.length}/${urls.length} objects through the tunnel (${fake.downloads.map(d => `${d.bytes} B ${d.ms} ms`).join('; ')}), confirm polled ${fake.confirms}x`);

  // Tunnel closed after done, while the app is still running.
  assert(fake.ours.length >= 1, 'no cloudflared process was seen while the tunnel was up');
  const dl = Date.now() + 15000;
  while (fake.ours.some(p => cloudflaredPids().has(p)) && Date.now() < dl) await sleep(300);
  const alive = fake.ours.filter(p => cloudflaredPids().has(p));
  assert(alive.length === 0, `tunnel not closed after done: cloudflared pid(s) ${alive.join(', ')} still alive`);
  let publicStatus = 'unreachable';
  try { publicStatus = (await fetch(urls[0], { signal: AbortSignal.timeout(15000) })).status; } catch { /* unreachable is fine */ }
  assert(publicStatus !== 200, `a hosted link still answers 200 after done`);
  console.log(`tunnel closed after done: cloudflared pid(s) ${fake.ours.join(', ')} gone; old public link now -> ${publicStatus}`);
  console.log(`publish (renderer click to done): ${publishS.toFixed(1)} s; page errors: ${pageErrors.length}`);
  assert(pageErrors.length === 0, `renderer exceptions: ${pageErrors.join(' | ')}`);

  await cdp.close(); cdp = null;
  await stopProcess(electron); electron = null;
  await sleep(800);
  const stray = [...cloudflaredPids()].filter(p => !before.has(p));
  assert(stray.length === 0, `stray cloudflared after the app exited: ${stray.join(', ')}`);
  console.log(`PASS listbridge rehearsal (total ${((Date.now() - tAll) / 1000).toFixed(1)} s, no stray cloudflared)`);
} catch (err) {
  failed = true;
  console.error('FAIL listbridge rehearsal:', err?.stack || err);
  console.error('fake Cults saw:', JSON.stringify({ creates: fake.creates.length, confirms: fake.confirms, downloads: fake.downloads }));
  try {
    const tail = await evaluate(cdp, `JSON.stringify((window.__reh?.events || []).slice(-4))`);
    console.error('last progress events:', tail);
  } catch { /* page gone */ }
} finally {
  try { await cdp?.close(); } catch { /* */ }
  await stopProcess(electron);
  await stopProcess(vite);
  gql.close();
  removeTempDir(userData);
  // Never leave a tunnel of ours behind, even on failure.
  for (const pid of cloudflaredPids()) if (!before.has(pid)) { try { process.kill(pid); } catch { /* gone */ } }
  process.exit(failed ? 1 : 0);
}
