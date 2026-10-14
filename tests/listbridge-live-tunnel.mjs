// PB.15 part 1: REAL cloudflared, REAL Cloudflare edge. Opt-in (needs network):
//   LIVE_TUNNEL=1 node tests/listbridge-live-tunnel.mjs      (npm run test:live-tunnel)
// Serves a 50 MB random file + a small PNG through the temporary-link host, fetches both via the
// PUBLIC trycloudflare URL from a SEPARATE node process (full GET, HEAD, one Range), asserts the
// bytes are identical (sha256) and stats().served === total, logs tunnel start time + throughput,
// then close() and checks that no cloudflared.exe started by THIS run is still alive.
// Never part of `npm test`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.LIVE_TUNNEL !== '1') {
  console.log('SKIP listbridge live tunnel (set LIVE_TUNNEL=1 to run; needs network + cloudflared)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createTunnelFileHost, findCloudflared } = require('../electron/listbridge/filehosts/tunnel.cjs');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const mb = n => (n / (1024 * 1024)).toFixed(1);

/** PIDs of every running cloudflared*.exe (Windows; the vendored dev copy is cloudflared-windows-amd64.exe, the bundled one cloudflared.exe) / cloudflared (elsewhere). */
function cloudflaredPids() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return new Set(out.split(/\r?\n/).map(l => /^"(?:cloudflared[^"]*)\.exe","(\d+)"/i.exec(l)?.[1]).filter(Boolean).map(Number));
    }
    const out = execFileSync('pgrep', ['-x', 'cloudflared'], { encoding: 'utf8' });
    return new Set(out.split(/\s+/).filter(Boolean).map(Number));
  } catch { return new Set(); }   // pgrep exits 1 with no match
}

// The separate fetching process: HEAD (retried until the brand-new hostname resolves), then
// Range, then full GETs with a streaming sha256 + timing. Prints one JSON line.
const CHILD = `
const crypto = require('node:crypto');
const [bigUrl, pngUrl] = JSON.parse(process.argv[1]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function head(url) {
  const deadline = Date.now() + 90000; let last = 'no answer';
  for (;;) {
    try { const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) }); if (r.ok) return r; last = 'HTTP ' + r.status; }
    catch (e) { last = String(e?.cause?.code || e?.name || e); }
    if (Date.now() > deadline) throw new Error('HEAD never succeeded: ' + last);
    await sleep(1500);
  }
}
async function full(url) {
  const t0 = Date.now(); const h = crypto.createHash('sha256'); let n = 0;
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('GET ' + r.status);
  for await (const c of r.body) { h.update(c); n += c.length; }
  return { sha: h.digest('hex'), bytes: n, ms: Date.now() - t0 };
}
(async () => {
  const out = {};
  const hb = await head(bigUrl); out.headBig = { status: hb.status, length: Number(hb.headers.get('content-length')), ranges: hb.headers.get('accept-ranges') };
  const hp = await head(pngUrl); out.headPng = { status: hp.status, length: Number(hp.headers.get('content-length')), type: hp.headers.get('content-type') };
  const rr = await fetch(bigUrl, { headers: { Range: 'bytes=1000-1999' }, signal: AbortSignal.timeout(60000) });
  const rb = Buffer.from(await rr.arrayBuffer());
  out.range = { status: rr.status, contentRange: rr.headers.get('content-range'), sha: crypto.createHash('sha256').update(rb).digest('hex'), bytes: rb.length };
  out.png = await full(pngUrl);
  out.big = await full(bigUrl);
  process.stdout.write(JSON.stringify(out) + '\\n');
})().catch(e => { process.stderr.write(String(e?.stack || e) + '\\n'); process.exit(1); });
`;

const found = findCloudflared({ repoRoot: ROOT });
assert.ok(found.path, `cloudflared not found: ${found.error}`);
console.log(`cloudflared: ${found.path}`);

const before = cloudflaredPids();
const big = crypto.randomBytes(50 * 1024 * 1024);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(4096)]);
const expect = { big: sha256(big), png: sha256(png), range: sha256(big.subarray(1000, 2000)) };

const host = createTunnelFileHost({ resolveBinary: () => found });
let closed = false;
const tAll = Date.now();
try {
  const bigKey = (await host.put('big-random.bin', big, 'application/octet-stream')).key;
  const pngKey = (await host.put('hero.png', png, 'image/png')).key;
  const t0 = Date.now();
  const bigUrl = await host.presignGet(bigKey, 600);       // first presign starts the tunnel
  const startS = (Date.now() - t0) / 1000;
  const pngUrl = await host.presignGet(pngKey, 600);
  console.log(`tunnel start: ${startS.toFixed(2)} s  ->  ${new URL(bigUrl).origin}`);

  const ours = [...cloudflaredPids()].filter(p => !before.has(p));
  assert.ok(ours.length >= 1, 'a new cloudflared process must be running while the tunnel is up');

  const stdout = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', CHILD, JSON.stringify([bigUrl, pngUrl])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; let e = '';
    c.stdout.on('data', d => { o += d; });
    c.stderr.on('data', d => { e += d; });
    c.on('exit', code => (code === 0 ? resolve(o) : reject(new Error(`fetch child exit ${code}: ${e}`))));
  });
  const r = JSON.parse(stdout.trim().split('\n').pop());

  assert.equal(r.headBig.status, 200); assert.equal(r.headBig.length, big.length); assert.equal(r.headBig.ranges, 'bytes');
  assert.equal(r.headPng.status, 200); assert.equal(r.headPng.length, png.length); assert.equal(r.headPng.type, 'image/png');
  assert.equal(r.range.status, 206); assert.equal(r.range.contentRange, `bytes 1000-1999/${big.length}`);
  assert.equal(r.range.sha, expect.range, 'Range bytes differ');
  assert.equal(r.png.bytes, png.length); assert.equal(r.png.sha, expect.png, 'PNG bytes differ');
  assert.equal(r.big.bytes, big.length); assert.equal(r.big.sha, expect.big, '50 MB bytes differ');

  // served is credited on the 'finish' of the response; give the tail a moment.
  const dl = Date.now() + 5000;
  while (host.stats().served < host.stats().total && Date.now() < dl) await new Promise(res => setTimeout(res, 100));
  const st = host.stats();
  assert.equal(st.served, st.total, `stats served ${st.served} !== total ${st.total}`);
  assert.equal(st.total, 2);

  const mbps = (big.length / (1024 * 1024)) / (r.big.ms / 1000);
  console.log(`50 MB GET through the public URL: ${mb(big.length)} MB in ${(r.big.ms / 1000).toFixed(2)} s = ${mbps.toFixed(2)} MB/s (sha256 identical)`);
  console.log(`PNG ${png.length} B: sha256 identical, HEAD ok, Range 206 ok, stats ${st.served}/${st.total}`);

  await host.close();
  closed = true;
  await new Promise(res => setTimeout(res, 800));
  const after = cloudflaredPids();
  const stray = ours.filter(p => after.has(p));
  assert.deepEqual(stray, [], `cloudflared started by this run still alive after close(): ${stray.join(', ')}`);
  console.log(`close(): our cloudflared pid(s) ${ours.join(', ')} gone (other cloudflared left alone: ${[...after].join(', ') || 'none'})`);
  console.log(`PASS listbridge live tunnel (tunnel start ${startS.toFixed(2)} s, ${mbps.toFixed(2)} MB/s, total ${((Date.now() - tAll) / 1000).toFixed(1)} s)`);
} catch (err) {
  console.error('FAIL listbridge live tunnel:', err?.stack || err);
  process.exitCode = 1;
} finally {
  if (!closed) await host.close().catch(() => {});
}
