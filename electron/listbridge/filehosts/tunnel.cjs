// Listbridge file host: "temporary link from this computer" (plan PB.5b).
//
// URL-only platforms (Cults3D) fetch files/images from public HTTPS links. Instead of an
// object-storage account, this host keeps the job's files IN MEMORY, serves them from a
// node:http server bound to 127.0.0.1 on a random port, and exposes that server through a
// Cloudflare QUICK tunnel (`cloudflared tunnel --url …`: no account, no config, random
// https://<words>.trycloudflare.com hostname). Same interface as filehosts/s3.cjs
// (put / presignGet / remove / testConnection) plus close() and `requiresUptime: true`:
// the link only works while this app runs, so the runner holds the job open until the
// platform confirms it downloaded the files (jobs.cjs "hold").
//
// Security:
//   * listens on 127.0.0.1 only; the server and the tunnel exist only for one job.
//   * every object gets its own 32-hex-char token (crypto.randomBytes(16)); the ONLY
//     servable paths are `/<token>/<encoded name>` matched EXACTLY against the in-memory
//     store (nothing is resolved on disk, so there is no traversal surface). Anything else
//     is 404; methods other than GET / HEAD are 405. No directory listing, no CORS headers.
//   * a URL stops working at its presignGet expiry (410) or after remove() (404).
//   * keys handed to the runner are opaque counters, not tokens; nothing here logs, and no
//     thrown message contains a token or URL.
//
// Ingestion evidence (plan PB.12): stats() → { served, total }. An object counts as SERVED
// once every byte of it has been delivered at least once by GET responses that finished
// (a full 200, or 206 single-range responses whose ranges together cover the whole object;
// ranges are merged per object). HEAD, aborted responses, 404/410/416 never count.
// "Delivered" means handed to the local tunnel connection in full (the response's 'finish'
// after a backpressured stream), the strongest signal available on this side: cloudflared
// may still lose bytes it already accepted, so the adapter's confirm query is the other half.
// Range: single `bytes=a-b` / `a-` / `-n` ranges get 206 + Content-Range; multi-range or
// If-Range requests get the full 200 (allowed by RFC 9110); `Accept-Ranges: bytes` is sent.
//
// Pure Node (node:http / node:crypto / node:child_process). The cloudflared binary, the
// spawn function, fetch and the clock are injectable (tests/listbridge-tunnel.test.mjs runs
// a fake cloudflared under plain node).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ensureCloudflaredAt } = require('../cloudflaredPin.cjs');

const DEFAULT_PRESIGN_SEC = 3600;
const MAX_PRESIGN_SEC = 7 * 24 * 60 * 60;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const REGISTER_GRACE_MS = 10_000;        // URL seen but no "Registered tunnel connection" line
const MAX_NAME_BYTES = 180;
const CHUNK_BYTES = 256 * 1024;

const NOT_INSTALLED_MESSAGE = 'cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared';
const DOWNLOADING_MESSAGE = 'Downloading the link tool (one time)…';
const DOWNLOAD_FAILED_MESSAGE = 'The link tool could not be downloaded. Check the internet connection and try again, or install it with: winget install --id Cloudflare.cloudflared';
// Public hostname cloudflared prints for a quick tunnel (api.trycloudflare.com is the
// service endpoint it talks to, never the tunnel itself).
const QUICK_URL_RE = /https:\/\/(?!api\.)([a-z0-9-]+)\.trycloudflare\.com\b/i;
const REGISTERED_RE = /Registered tunnel connection/i;

// Readiness gate (PB.16). A brand-new quick-tunnel hostname does not resolve for a few
// seconds; anyone who looks it up early (even us, via the local resolver) gets a cached
// NXDOMAIN for 20+ s. So the name is checked ONLY over DNS-over-HTTPS JSON APIs.
const DOH_URLS = [
  host => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
  host => `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
];
const DEFAULT_PUBLIC_TIMEOUT_MS = 120_000;   // trycloudflare.com SOA negative-cache TTL is 60 s
const DNS_POLL_MS = 1000;
const DNS_STABLE_POLLS = 2;
const PROBE_ATTEMPTS = 5;
const PROBE_BACKOFF_MS = 2000;

// Any cloudflared we spawned is killed when this process exits, even on a crash path.
const liveChildren = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of liveChildren) killTreeSync(child);
  });
}

function killTreeSync(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform === 'win32') {
      childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

// Kill the process TREE (Windows: taskkill /T /F, like tests/cdp-harness.mjs stopProcess).
async function killTree(child) {
  if (!child) return;
  liveChildren.delete(child);
  const exited = () => child.exitCode != null || child.signalCode != null;
  if (exited()) return;
  const gone = new Promise(resolve => child.once('exit', resolve));
  const wait = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
  if (process.platform === 'win32') {
    try {
      const killer = childProcess.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await Promise.race([new Promise(r => killer.once('exit', r).once('error', r)), wait(3000)]);
    } catch { /* fall through */ }
    if (!exited()) { try { child.kill(); } catch { /* already gone */ } }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  await Promise.race([gone, wait(3000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function safeFileName(name) {
  let s = String(name ?? '').normalize('NFC').replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = 'file';
  if (Buffer.byteLength(s, 'utf8') > MAX_NAME_BYTES) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    let stem = ext ? s.slice(0, dot) : s;
    while (stem && Buffer.byteLength(stem + ext, 'utf8') > MAX_NAME_BYTES) stem = Array.from(stem).slice(0, -1).join('');
    s = (stem || 'file') + ext;
  }
  return s;
}

// RFC 3986 path-segment encoding (keeps the extension readable for platforms that sniff it).
const encodeSegment = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeSegment(name)}`;
}

// One `Range: bytes=…` spec → { start, end } (inclusive), 'unsatisfiable', or null = serve
// the whole object (no header, multi-range, malformed or reversed ranges are ignored).
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') {                       // suffix: last n bytes
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== '' && Number(m[2]) < start) return null;
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

// Record [start, end) as delivered; merge overlapping / touching ranges.
function addCoverage(obj, start, end) {
  if (obj.served) return;
  const size = obj.bytes.byteLength;
  if (size === 0) { obj.served = true; return; }
  const all = [...obj.ranges, [start, end]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of all) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  obj.ranges = merged;
  obj.served = merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= size;
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * Locate cloudflared. Order: explicit setting → downloaded copy
 * (<userData>/listbridge/cloudflared.exe) → dev vendor copy → PATH (`where` / `which`) →
 * default Windows install dirs. The installer does not bundle it; see resolveCloudflared().
 * @param {{ settingPath?: string|null, userDataDir?: string|null, repoRoot?: string|null,
 *   env?: NodeJS.ProcessEnv, platform?: string, exists?: (p: string) => boolean,
 *   which?: (name: string) => string|null }} [opts]
 * @returns {{ path: string|null, error: string|null }}
 */
function findCloudflared({
  settingPath = null, userDataDir = null, repoRoot = null, env = process.env,
  platform = process.platform, exists = isFile, which = defaultWhich,
} = {}) {
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (settingPath && exists(settingPath)) return { path: settingPath, error: null };
  const candidates = [];
  if (userDataDir) candidates.push(downloadedPath(userDataDir, platform));
  if (repoRoot) candidates.push(path.join(repoRoot, 'vendor', 'cloudflared', platform === 'win32' ? 'cloudflared-windows-amd64.exe' : 'cloudflared'));
  const onPath = which('cloudflared');
  if (onPath) candidates.push(onPath);
  if (platform === 'win32') {
    candidates.push(path.join(env['ProgramFiles(x86)'] || 'C:\Program Files (x86)', 'cloudflared', exe));
    candidates.push(path.join(env.ProgramFiles || 'C:\Program Files', 'cloudflared', exe));
  }
  for (const c of candidates) if (c && exists(c)) return { path: c, error: null };
  return { path: null, error: NOT_INSTALLED_MESSAGE };
}

/** Where the first-use download lands. */
function downloadedPath(userDataDir, platform = process.platform) {
  return path.join(userDataDir, 'listbridge', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/**
 * findCloudflared(), then (Windows only, needs userDataDir) download the pinned,
 * SHA-256-verified release once into <userData>/listbridge/ when nothing was found.
 * Never throws: failure → { path: null, error } so the host reports 'cloudflared-missing'.
 * @param {Parameters<typeof findCloudflared>[0] & { fetchImpl?: typeof fetch,
 *   onProgress?: (p: { phase: 'download-tool', message: string }) => void,
 *   pinFile?: { name: string, url: string, sha256: string } }} (pinFile: tests only) [opts]
 */
async function resolveCloudflared({ fetchImpl = globalThis.fetch, onProgress, pinFile, ...findOpts } = {}) {
  const found = findCloudflared(findOpts);
  if (found.path) return found;
  const platform = findOpts.platform || process.platform;
  if (!findOpts.userDataDir || platform !== 'win32') return found;
  try { onProgress?.({ phase: 'download-tool', message: DOWNLOADING_MESSAGE }); } catch { /* listener must not break */ }
  try {
    const dest = downloadedPath(findOpts.userDataDir, platform);
    await ensureCloudflaredAt(dest, { fetchImpl, file: pinFile, exists: findOpts.exists || isFile });
    return { path: dest, error: null };
  } catch {
    return { path: null, error: DOWNLOAD_FAILED_MESSAGE };
  }
}

function defaultWhich(name) {
  try {
    const r = childProcess.spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    if (r.status !== 0) return null;
    return String(r.stdout).split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
  } catch { return null; }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.binaryPath]                  cloudflared to run (skips resolveBinary)
 * @param {(o?: { onProgress?: Function }) => { path: string|null, error: string|null } | Promise<{ path: string|null, error: string|null }>} [opts.resolveBinary]
 * @param {typeof childProcess.spawn} [opts.spawnImpl]
 * @param {typeof fetch} [opts.fetchImpl]             the public-URL probe (waitUntilPublic / testConnection)
 * @param {typeof fetch} [opts.dohFetchImpl]          DNS-over-HTTPS lookups only (never the local resolver)
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.startupTimeoutMs=30000]
 * @param {number} [opts.probeTimeoutMs=45000]        testConnection: how long DNS / edge may take
 * @param {() => number} [opts.now]
 * @param {() => string} [opts.randomToken]            32 lowercase hex chars
 */
function createTunnelFileHost({
  binaryPath, resolveBinary = () => resolveCloudflared(), spawnImpl = childProcess.spawn,
  fetchImpl = globalThis.fetch, dohFetchImpl = globalThis.fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)), startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, probeTimeoutMs = 45_000,
  now = Date.now, randomToken = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  /** @type {Map<string, { token: string, name: string, enc: string, mime: string, bytes: Buffer, expiresAt: number,
   *   ranges: Array<[number, number]>, served: boolean, hidden?: boolean }>} */
  const byKey = new Map();
  /** @type {Map<string, string>} token → key */
  const byToken = new Map();
  let seq = 0;
  let closed = false;
  let server = null;
  let localOrigin = null;
  let child = null;
  let publicBase = null;
  let starting = null;

  function handler(req, res) {
    const send = (status, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
      res.end(req.method === 'HEAD' ? undefined : `${status}\n`);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { Allow: 'GET, HEAD' });
    const rawPath = String(req.url || '').split('?')[0];
    const m = /^\/([0-9a-f]{32})\/([^/]+)$/.exec(rawPath);
    if (!m) return send(404);
    const key = byToken.get(m[1]);
    const obj = key ? byKey.get(key) : null;
    if (!obj) return send(404);
    let decoded = null;
    try { decoded = decodeURIComponent(m[2]); } catch { /* malformed escape */ }
    if (m[2] !== obj.enc && decoded !== obj.name) return send(404);
    if (!obj.expiresAt) return send(404);         // put but never handed out
    if (now() >= obj.expiresAt) return send(410);
    const size = obj.bytes.byteLength;
    const range = req.headers['if-range'] != null ? null : parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') return send(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    const start = range ? range.start : 0;
    const end = range ? range.end + 1 : size;     // exclusive
    res.writeHead(range ? 206 : 200, {
      'Content-Type': obj.mime,
      'Content-Length': String(end - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${size}` } : {}),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(obj.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    // Credit the bytes only once the whole response body has been handed off. The body is
    // streamed in chunks WITH backpressure: one huge res.end(buffer) reports 'finish' at once
    // on Windows even when the client never reads, which would fake a "served".
    res.once('finish', () => { if (byKey.get(key) === obj) addCoverage(obj, start, end); });
    let off = start;
    const pump = () => {
      while (off < end) {
        if (res.destroyed) return;
        const next = Math.min(off + CHUNK_BYTES, end);
        const ok = res.write(obj.bytes.subarray(off, next));
        off = next;
        if (!ok) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  }

  async function startServer() {
    if (server) return;
    const s = http.createServer(handler);
    s.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { s.off('error', reject); resolve(undefined); });
    });
    server = s;
    const addr = /** @type {import('node:net').AddressInfo} */ (s.address());
    localOrigin = `http://127.0.0.1:${addr.port}`;
  }

  // Resolve (and, first time, download) the binary once; failures are not cached.
  let resolvedBin = null;
  let resolving = null;
  async function ensureBinary(onProgress) {
    if (binaryPath) return binaryPath;
    if (resolvedBin) return resolvedBin;
    resolving ||= (async () => {
      const found = await resolveBinary({ onProgress });
      if (!found?.path) throw Object.assign(new Error(found?.error || NOT_INSTALLED_MESSAGE), { code: 'cloudflared-missing' });
      resolvedBin = found.path;
      return resolvedBin;
    })().finally(() => { resolving = null; });
    return resolving;
  }

  /** Get the link tool ready (downloads it on first use). Reports `download-tool` progress. */
  async function prepare({ onProgress } = {}) {
    if (closed) throw new Error('Temporary link host is closed.');
    await ensureBinary(onProgress);
  }

  async function startTunnel() {
    const bin = await ensureBinary();
    return new Promise((resolve, reject) => {
      let settled = false;
      let url = null;
      let graceTimer = null;
      let tail = '';
      const proc = spawnImpl(bin, ['tunnel', '--no-autoupdate', '--url', localOrigin], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      child = proc;
      liveChildren.add(proc);
      installExitHook();
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (err) {
          killTree(proc).catch(() => {});
          if (child === proc) child = null;
          reject(err);
        } else resolve(value);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error(
        `The temporary link did not start within ${Math.round(startupTimeoutMs / 1000)} s. Check the internet connection and try again.`),
        { code: 'tunnel-start-timeout' })),
      startupTimeoutMs);
      const onData = chunk => {
        if (settled) return;
        tail = (tail + chunk.toString('utf8')).slice(-8192);
        if (!url) {
          const m = QUICK_URL_RE.exec(tail);
          if (m) {
            url = `https://${m[1].toLowerCase()}.trycloudflare.com`;
            graceTimer = setTimeout(() => finish(null, url), REGISTER_GRACE_MS);
          }
        }
        if (url && REGISTERED_RE.test(tail)) finish(null, url);
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', err => finish(Object.assign(new Error(
        err?.code === 'ENOENT' ? NOT_INSTALLED_MESSAGE : `cloudflared could not start: ${err?.message || err}`),
        { code: err?.code === 'ENOENT' ? 'cloudflared-missing' : 'tunnel-start-timeout' })));
      proc.once('exit', code => {
        liveChildren.delete(proc);
        if (child === proc) { child = null; publicBase = null; starting = null; readyBase = null; }
        if (!settled) {
          const last = tail.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-1)[0] || '';
          const detail = last.replace(/https?:\/\/\S+/g, '[url]').slice(0, 200);
          finish(Object.assign(new Error(`cloudflared exited before the temporary link was ready (code ${code})${detail ? `: ${detail}` : ''}.`),
            { code: 'tunnel-start-timeout' }));
        }
      });
    });
  }

  async function ensureStarted() {
    if (closed) throw new Error('Temporary link host is closed.');
    if (publicBase && child) return publicBase;
    starting ||= (async () => {
      await startServer();
      publicBase = await startTunnel();
      return publicBase;
    })();
    try {
      return await starting;
    } catch (err) {
      starting = null;
      throw err;
    }
  }

  function getObj(key) {
    const obj = typeof key === 'string' ? byKey.get(key) : null;
    if (!obj) throw new Error('Temporary link host: unknown object key');
    return obj;
  }

  async function put(name, bytes, mime) {
    if (closed) throw new Error('Temporary link host is closed.');
    let buf;
    // Views share the job's bytes (no copy: listings can be up to 2 GiB).
    if (bytes instanceof ArrayBuffer) buf = Buffer.from(bytes);
    else if (ArrayBuffer.isView(bytes)) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new Error('Temporary link host: put() needs bytes (ArrayBuffer / Uint8Array / Buffer)');
    const token = String(randomToken());
    if (!/^[0-9a-f]{32}$/.test(token) || byToken.has(token)) throw new Error('Temporary link host: bad random token');
    const safe = safeFileName(name);
    const key = `obj${++seq}`;
    byKey.set(key, {
      token, name: safe, enc: encodeSegment(safe),
      mime: typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream',
      bytes: buf, expiresAt: 0, ranges: [], served: false,
    });
    byToken.set(token, key);
    return { key };
  }

  async function presignGet(key, expiresSec = DEFAULT_PRESIGN_SEC) {
    const obj = getObj(key);
    const n = Number(expiresSec);
    if (!Number.isFinite(n) || n < 1) throw new Error('Temporary link host: expiresSec must be a positive number of seconds');
    const base = await ensureStarted();
    obj.expiresAt = now() + Math.min(Math.floor(n), MAX_PRESIGN_SEC) * 1000;
    return `${base}/${obj.token}/${obj.enc}`;
  }

  async function remove(key) {
    const obj = typeof key === 'string' ? byKey.get(key) : null;
    if (!obj) return;
    byKey.delete(key);
    byToken.delete(obj.token);
  }

  // One DoH lookup: true when the resolver answers NOERROR (Status 0) with an A/AAAA/CNAME.
  async function dohResolves(makeUrl, hostname) {
    try {
      const res = await dohFetchImpl(makeUrl(hostname), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const j = await res.json();
      return j?.Status === 0 && Array.isArray(j.Answer) && j.Answer.some(x => x && (x.type === 1 || x.type === 28 || x.type === 5));
    } catch { return false; }
  }

  let readyBase = null;   // public base already proven reachable (cleared when the tunnel dies)

  /**
   * Readiness gate: resolves once the tunnel's public hostname resolves on BOTH DoH resolvers
   * for 2 consecutive polls AND a hidden probe object round-trips byte-identical through the
   * public URL. Rejects with code 'tunnel-not-public' after `timeoutMs`. Starts the tunnel if
   * it is not running (a died tunnel is restarted: callers must re-presign afterwards).
   * @param {{ timeoutMs?: number, onProgress?: (p: { phase: 'dns'|'probe' }) => void, cancelled?: () => boolean }} [o]
   */
  async function waitUntilPublic({ timeoutMs = DEFAULT_PUBLIC_TIMEOUT_MS, onProgress, cancelled } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const base = await ensureStarted();
    if (readyBase === base && child) return { base, dnsMs: 0, probeMs: 0 };
    const hostname = new URL(base).hostname;
    const t0 = now();
    const deadline = t0 + Math.max(0, timeoutMs);
    let last = 'dns';
    const fail = () => Object.assign(new Error(
      `The temporary link is not reachable from the internet yet (${last}). Wait a moment and retry.`), { code: 'tunnel-not-public' });
    const stop = () => { if (cancelled?.()) throw Object.assign(new Error('Publish cancelled'), { cancelled: true, code: 'cancelled' }); };
    const note = p => { try { onProgress?.(p); } catch { /* a listener must not break the gate */ } };

    note({ phase: 'dns' });
    let stable = 0;
    for (;;) {
      stop();
      const oks = await Promise.all(DOH_URLS.map(u => dohResolves(u, hostname)));
      stable = oks.every(Boolean) ? stable + 1 : 0;
      last = oks.every(Boolean) ? 'dns settling' : 'dns';
      if (stable >= DNS_STABLE_POLLS) break;
      if (now() >= deadline) throw fail();
      await sleep(DNS_POLL_MS);
    }
    const tDns = now();

    note({ phase: 'probe' });
    const body = crypto.randomBytes(32);
    const token = crypto.randomBytes(16).toString('hex');
    const probeKey = `probe${++seq}`;
    byKey.set(probeKey, {
      token, name: 'probe.bin', enc: 'probe.bin', mime: 'application/octet-stream', bytes: body,
      expiresAt: now() + 10 * 60 * 1000, ranges: [], served: false, hidden: true,
    });
    byToken.set(token, probeKey);
    try {
      const url = `${base}/${token}/probe.bin`;
      for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
        stop();
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          const got = Buffer.from(await res.arrayBuffer());
          if (res.status === 200 && got.equals(body)) {
            readyBase = base;
            return { base, dnsMs: tDns - t0, probeMs: now() - tDns };
          }
          last = res.status === 200 ? 'probe bytes differ' : `HTTP ${res.status}`;
        } catch (err) {
          last = String(err?.cause?.code || err?.name || 'network error');
        }
        if (now() >= deadline || attempt === PROBE_ATTEMPTS - 1) break;
        await sleep(PROBE_BACKOFF_MS);
      }
      throw fail();
    } finally {
      byKey.delete(probeKey);
      byToken.delete(token);
    }
  }

  // Proves the PUBLIC link works (the same gate the publish job uses).
  async function testConnection() {
    try {
      await waitUntilPublic({ timeoutMs: probeTimeoutMs });
      return { ok: true, message: 'Temporary link works: files can be downloaded from this computer while MIXOMESH is open.' };
    } catch (err) {
      return { ok: false, message: String(err?.message || err).replace(/https?:\/\/\S+/g, '[url]') };
    }
  }

  /** Ingestion evidence: how many stored objects have been fully delivered at least once. */
  function stats() {
    let served = 0;
    let total = 0;
    for (const obj of byKey.values()) {
      if (obj.hidden) continue;                 // readiness probe: not part of the listing
      total++;
      if (obj.served) served++;
    }
    return { served, total };
  }

  async function close() {
    closed = true;
    byKey.clear();
    byToken.clear();
    const proc = child;
    child = null; publicBase = null; starting = null; readyBase = null;
    if (proc) await killTree(proc);
    const s = server;
    server = null; localOrigin = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise(resolve => s.close(() => resolve(undefined)));
    }
  }

  return Object.freeze({
    requiresUptime: true,
    put, presignGet, remove, testConnection, waitUntilPublic, prepare, close, stats,
    /** Local origin of the loopback server (null until started). Diagnostics / tests only. */
    get localOrigin() { return localOrigin; },
    get running() { return !!child && !closed; },
    get closed() { return closed; },
  });
}

module.exports = {
  createTunnelFileHost, findCloudflared, resolveCloudflared, downloadedPath, NOT_INSTALLED_MESSAGE, DOWNLOADING_MESSAGE, DOWNLOAD_FAILED_MESSAGE,
  _internal: Object.freeze({ safeFileName, contentDisposition, QUICK_URL_RE, parseRange, addCoverage }),
};
