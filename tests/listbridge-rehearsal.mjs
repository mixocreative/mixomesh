// PB.15 part 2 / PB.3b: in-app dress rehearsal. Opt-in:
//   LIVE_TUNNEL=1 node tests/listbridge-rehearsal.mjs        (npm run test:rehearsal)
// Real dev Electron (Vite dev server + LISTBRIDGE_FAKE_PLATFORM=1, a throw-away userData dir),
// driven over CDP. The renderer runs the REAL PublishClient (real export pipeline -> IPC ->
// runner) against a FAKE Cults: a local GraphQL server that, like Cults, hands out presigned-POST
// upload slots (createFileUploader / createImageUploader), receives the multipart uploads at a local
// storage endpoint, then accepts createCreation(fileKeys, imageKeys) only for keys it really received
// and answers the creation(slug) read-back (blueprints / illustrations) once everything arrived.
// Cults now takes native uploads, so NO tunnel is involved: the test also asserts that no cloudflared
// process is ever started (the tunnel stays the fallback for URL-only platforms; its own live test is
// tests/listbridge-live-tunnel.mjs).
// Asserts: outcome ok, remoteId saved in project.listings (secret -> draft record), every object
// uploaded byte-identical (sha256), keys in createCreation match the uploads, storage never sees the
// Basic auth header, visibility SECRET by default, no cloudflared, no renderer exceptions.
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

if (process.env.LIVE_TUNNEL !== '1' && process.env.REHEARSAL !== '1') {
  console.log('SKIP listbridge rehearsal (set LIVE_TUNNEL=1 or REHEARSAL=1 to run; needs Electron + Chrome-free local ports only)');
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
  creates: [], confirms: 0, authOk: false, slots: [], uploads: [],   // uploads: { key, filename, bytes, sha, hadAuth }
  listOptions: 0, storageSawAuth: false,
};
const before = cloudflaredPids();
let storageUrl = '';
let slotN = 0;

function parseMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const text = buf.toString('latin1');
  return text.split(`--${boundary}`).slice(1, -1).map(chunk => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    return { name: /name="([^"]*)"/.exec(head)[1], filename: /filename="([^"]*)"/.exec(head)?.[1], bytes: Buffer.from(body, 'latin1') };
  });
}

// The presigned-POST target: no Authorization expected, key = the `key` field with ${filename} expanded.
const storage = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.headers.authorization) fake.storageSawAuth = true;
    const parts = parseMultipart(Buffer.concat(chunks), req.headers['content-type'] || '');
    const file = parts.find(p => p.name === 'file');
    const keyField = parts.find(p => p.name === 'key');
    if (!file || !keyField || parts.at(-1) !== file || !parts.some(p => p.name === 'policy')) { res.writeHead(400); return res.end('<Error><Code>InvalidArgument</Code></Error>'); }
    const key = keyField.bytes.toString().split('${filename}').join(file.filename);
    fake.uploads.push({ key, filename: file.filename, bytes: file.bytes.length, sha: sha256(file.bytes) });
    res.writeHead(204); res.end();
  });
});
await new Promise(r => storage.listen(0, '127.0.0.1', r));
storageUrl = `http://127.0.0.1:${storage.address().port}/bucket`;

const MODEL_EXT = /\.(stl|3mf|obj|ply|step|stp|amf)$/i;
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
    const query = q.query;
    if (/createFileUploader|createImageUploader/.test(query)) {
      const field = /createFileUploader/.test(query) ? 'createFileUploader' : 'createImageUploader';
      fake.slots.push(field);
      slotN++;
      // The slot URL is loopback http here (fakePlatform.cjs lets the real parser accept it); real Cults gives https S3.
      return reply({ data: { [field]: { errors: [], uploader: { url: storageUrl, fields: [
        { name: 'key', value: `uploads/${slotN}/\${filename}` }, { name: 'policy', value: 'FAKE-POLICY' }] } } } });
    }
    if (/createCreation/.test(query)) {
      const v = q.variables || {};
      if (v.fileUrls || v.imageUrls) return reply({ data: { createCreation: { creation: null, errors: ['fileUrls were sent: native upload expected'] } } });
      const keys = [...(v.fileKeys || []), ...(v.imageKeys || [])];
      const missing = keys.filter(k => !fake.uploads.some(u => u.key === k));
      if (missing.length) return reply({ data: { createCreation: { creation: null, errors: [`unknown upload keys: ${missing.join(', ')}`] } } });
      fake.creates.push({ name: v.name, v });
      return reply({ data: { createCreation: { creation: { id: 'fake-cults-1', slug: 'fake-cults-1', url: 'https://cults3d.com/en/3d-model/fake/fake-cults-1', visibility: v.visibility }, errors: [] } } });
    }
    if (/Confirm/.test(query)) {
      fake.confirms++;
      const c = fake.creates.at(-1);
      const blueprints = (c?.v.fileKeys || []).filter(k => MODEL_EXT.test(k)).map((k, i) => ({ id: i, fileName: k }));
      const illustrations = (c?.v.imageKeys || []).map((k, i) => ({ id: i }));
      return reply({ data: { creation: { id: 'fake-cults-1', slug: 'fake-cults-1', url: 'https://cults3d.com/en/3d-model/fake/fake-cults-1', visibility: c?.v.visibility, blueprints, illustrations } } });
    }
    if (/ListOptions/.test(query)) {
      fake.listOptions++;
      return reply({ data: {
        categories: [{ id: 'C1', name: 'Art', children: [] }],
        licenses: [{ code: 'cults_cu', name: 'Personal', allowsCommercialUse: false, availableOnFreeDesigns: true, availableOnPricedDesigns: true }],
      } });
    }
    return reply({ data: { me: { nick: NICK } } });
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
  assert(desc.ids.includes('cults3d') && desc.transfer === 'direct', `describe: ${JSON.stringify(desc)}`);

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
        listing: { title: 'Rehearsal quad', description: 'Dress rehearsal listing.', tags: ['rehearsal', 'test'], price: { amount: 4, currency: 'EUR' }, license: 'cults_cu', categoryHint: 'C1', madeWithAi: false },
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
      Client.publish(pkg, { platform: 'cults3d', accountId: 'default' }, e => window.__reh.events.push({ ...e, t: Date.now() }))
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
  const hostDone = ev.find(e => e.step === 'host' && e.status === 'done');
  assert(hostDone && !hostDone.skipped, 'the host step must be a real upload, not skipped');
  const up = ev.filter(e => e.phase === 'upload');
  assert(up.length >= 2 && up.at(-1).done === up.at(-1).total && up.at(-1).total === kick.sent.length, `upload progress: ${JSON.stringify(up.at(-1))}`);
  assert(!ev.some(e => e.phase === 'dns' || e.phase === 'probe'), 'no tunnel readiness phases for a native-upload platform');

  assert(out.ok === true && out.status === 'done', `outcome not ok: ${JSON.stringify(out)}`);
  assert(out.result.remoteId === 'fake-cults-1', `remoteId: ${JSON.stringify(out.result)}`);
  assert(out.result.status === 'secret', `first publish must be SECRET: ${JSON.stringify(out.result)}`);
  const rec = res.listings.find(l => l.platform === 'cults3d');
  assert(rec && rec.remoteId === 'fake-cults-1' && rec.status === 'draft' && rec.visibility === 'secret', `project.listings: ${JSON.stringify(res.listings)}`);

  // Every object was uploaded natively, byte-identical, and createCreation used exactly those keys.
  assert(fake.authOk, 'fake Cults never saw the Basic auth header');
  assert(!fake.storageSawAuth, 'the storage endpoint must never receive the platform credentials');
  assert(fake.creates.length === 1, `expected exactly one createCreation, got ${fake.creates.length}`);
  const v = fake.creates[0].v;
  assert(v.visibility === 'SECRET' && v.locale === 'EN' && JSON.stringify(v.usages) === '["3dp"]' && v.licenseCode === 'cults_cu' && v.categoryId === 'C1', `createCreation args: ${JSON.stringify(v)}`);
  const keys = [...v.fileKeys, ...v.imageKeys];
  assert(keys.length === kick.sent.length, `createCreation got ${keys.length} keys, renderer sent ${kick.sent.length} objects`);
  assert(fake.uploads.length === kick.sent.length, `uploaded ${fake.uploads.length}/${kick.sent.length}`);
  assert(JSON.stringify(fake.uploads.map(u => u.sha).sort()) === JSON.stringify(kick.sent.map(x => x.sha).sort()), 'uploaded bytes differ from what the renderer sent');
  assert(fake.slots.filter(x => x === 'createImageUploader').length === 1 && fake.slots.length === kick.sent.length, `slot requests: ${fake.slots.join(',')}`);
  assert(fake.confirms >= 1, 'the creation(slug) read-back was never polled');
  console.log(`fake Cults received ${fake.uploads.length} uploads (${fake.uploads.map(u => `${u.filename} ${u.bytes} B`).join('; ')}), confirm polled ${fake.confirms}x`);

  // The renderer can load the option lists through the real IPC + adapter.
  const lo = await evaluate(cdp, `window.electronAPI.listbridge.listOptions('cults3d', 'en')`);
  assert(lo.ok && lo.categories[0].name === 'Art' && lo.licenses[0].code === 'cults_cu' && fake.listOptions === 1, `listOptions: ${JSON.stringify(lo)}`);

  const tunnelPids = [...cloudflaredPids()].filter(p => !before.has(p));
  assert(tunnelPids.length === 0, `a native-upload publish must not start a tunnel (cloudflared pid ${tunnelPids.join(', ')})`);
  console.log(`publish (renderer click to done): ${publishS.toFixed(1)} s, no tunnel started; page errors: ${pageErrors.length}`);
  assert(pageErrors.length === 0, `renderer exceptions: ${pageErrors.join(' | ')}`);

  await cdp.close(); cdp = null;
  await stopProcess(electron); electron = null;
  await sleep(500);
  console.log(`PASS listbridge rehearsal (direct upload, total ${((Date.now() - tAll) / 1000).toFixed(1)} s)`);
} catch (err) {
  failed = true;
  console.error('FAIL listbridge rehearsal:', err?.stack || err);
  console.error('fake Cults saw:', JSON.stringify({ slots: fake.slots.length, uploads: fake.uploads, creates: fake.creates.length, confirms: fake.confirms }));
  try {
    const tail = await evaluate(cdp, `JSON.stringify((window.__reh?.events || []).slice(-4))`);
    console.error('last progress events:', tail);
  } catch { /* page gone */ }
} finally {
  try { await cdp?.close(); } catch { /* */ }
  await stopProcess(electron);
  await stopProcess(vite);
  gql.close();
  storage.close();
  removeTempDir(userData);
  // Never leave a tunnel of ours behind, even on failure.
  for (const pid of cloudflaredPids()) if (!before.has(pid)) { try { process.kill(pid); } catch { /* gone */ } }
  process.exit(failed ? 1 : 0);
}
