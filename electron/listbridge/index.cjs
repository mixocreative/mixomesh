// Listbridge runner wiring for the Electron main process (ADR 0004, plan PB.4).
//
// registerListbridgeIpc(handle, deps) registers the `publish:*` channels through main.cjs's
// trusted-sender `handle()` wrapper. Secrets stay here: the renderer can ask whether an
// account is saved, save / clear it, and test it — no channel ever returns a credential.
// The renderer sends a listing as { manifest, images: [bytes], files: [bytes] } (typed
// arrays / ArrayBuffers, never file paths); it is rebuilt with the portable core and
// validated before a job exists. Progress goes back to the SAME webContents on
// `publish:progress`.
//
// Creates are journaled on disk (journal.cjs, cia B-04/F-01): a window that reloads or crashes
// mid-publish, or an app restart, finds the outcome with `publish:pending(projectKey)` and
// settles it with `publish:resolvePending(jobId, 'ack' | 'check' | 'discard')`. While a project
// has an unsettled create (or a publish still running), `publish:start` for it creates nothing
// and answers { ok:false, status:'pending', pending }.
//
// No Electron import here (safeStorage / userData come in through deps) so the wiring is
// unit-testable under plain node. The portable core (src/listbridge, ESM) is loaded with
// dynamic import() by loadCore().

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCredentialStore } = require('./credentials.cjs');
const { createTransport } = require('./transport.cjs');
const { createPublishRunner } = require('./jobs.cjs');
const { createJournal } = require('./journal.cjs');
const { createS3FileHost } = require('./filehosts/s3.cjs');
const { createTunnelFileHost, resolveCloudflared } = require('./filehosts/tunnel.cjs');

const CREDENTIALS_FILE = 'listbridge-credentials.bin';
const JOURNAL_FILE = 'listbridge-journal.json';
const MAX_ITEM_BYTES = 1024 * 1024 * 1024;          // 1 GiB per file / image
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;     // 2 GiB per listing
const MAX_ITEMS = 64;
const MAX_FIELD_LEN = 4096;

// Confirm / hold policy for the runner (plan PB.12). intervalMs is both the adapter confirm
// poll and the hold poll; holdMs = how long a temporary link waits for the platform to fetch
// everything; retryWindowMs = how long a failed job's temporary links stay up for a Retry.
const CONFIRM_OPTIONS = Object.freeze({
  polls: 10, intervalMs: 5000, holdMs: 15 * 60 * 1000, retryWindowMs: 15 * 60 * 1000,
});

// File host types and their credential fields (required, optional).
// `tunnel` (PB.5b) is the DEFAULT for transfer:'url' platforms: temporary links served from
// this computer through a Cloudflare quick tunnel; no account, no credentials (the id
// `filehost:tunnel` always "has" credentials). `s3` stays as the advanced option.
const TUNNEL_ID = 'tunnel';
const FILEHOST_TYPES = Object.freeze({
  tunnel: {
    label: 'Temporary link from this computer (no account needed)',
    required: [],
    optional: [],
    noCredentials: true,
    requiresUptime: true,
  },
  s3: {
    label: 'S3-compatible (Cloudflare R2, AWS S3, …)',
    required: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    optional: ['prefix', 'style'],
  },
});

const LIST_OPTIONS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACCOUNT = 'default';   // the one account slot per platform (PublishModel.ACCOUNT_ID)

const ID_PART = /^[A-Za-z0-9._@-]{1,128}$/;
const PLATFORM_PART = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// Default loader for the ESM core. In a packaged build src/listbridge/ is shipped next to
// electron/ (electron-builder.yml `files`), so the same relative path resolves inside app.asar.
const defaultLoadCore = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'listbridge', 'index.js')).href);

// Real zip for over-limit file sets: jszip is a production dependency (bundled in the
// packaged app's node_modules); loaded lazily so the runner starts without it.
async function defaultZip(files) {
  const JSZip = require('jszip');
  const z = new JSZip();
  for (const f of files) z.file(f.name, f.bytes, { binary: true });
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function toBytes(v, label) {
  let u8;
  if (v instanceof Uint8Array) u8 = v;
  else if (v instanceof ArrayBuffer) u8 = new Uint8Array(v);
  else if (ArrayBuffer.isView(v)) u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  else throw new Error(`${label}: expected bytes (ArrayBuffer / Uint8Array), not ${v === null ? 'null' : typeof v}`);
  if (u8.byteLength > MAX_ITEM_BYTES) throw new Error(`${label}: larger than 1 GiB`);
  return u8;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, label, { required = true, max = MAX_FIELD_LEN } = {}) => {
  if (v == null || v === '') {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof v !== 'string' || v.length > max) throw new Error(`${label} must be a string of at most ${max} characters`);
  return v;
};

function slugName(title) {
  const s = String(title || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').toLowerCase().slice(0, 60);
  return `${s || 'files'}.zip`;
}

/**
 * @param {(channel: string, fn: Function) => void} handle main.cjs's trusted-sender wrapper
 * @param {object} deps
 * @param {string} deps.userDataDir
 * @param {any} deps.safeStorage                       Electron safeStorage (or a fake)
 * @param {any[]} [deps.adapters]                      Listbridge adapters to offer
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => Promise<any>} [deps.loadCore]         resolves the portable core module
 * @param {(record: any) => any} [deps.makeFileHost]  S3 (credentialed) host factory
 * @param {() => any} [deps.makeTunnelHost]           temporary-link host factory
 * @param {string|null} [deps.cloudflaredPath]        explicit cloudflared (Listbridge setting, later)
 * @param {(files: any[]) => Promise<Uint8Array>} [deps.zip]
 * @param {any} [deps.transport]
 * @param {any} [deps.credentials]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]                    clock for the listOptions cache (tests)
 * @param {{ polls?: number, intervalMs?: number, holdMs?: number, retryWindowMs?: number }} [deps.confirm]
 *   overrides for CONFIRM_OPTIONS (tests)
 */
function registerListbridgeIpc(handle, deps = {}) {
  const {
    userDataDir, safeStorage, adapters = [], fetchImpl = globalThis.fetch, loadCore = defaultLoadCore,
    zip = defaultZip, sleep, now = Date.now,
  } = deps;
  const confirm = { ...CONFIRM_OPTIONS, ...(deps.confirm || {}) };
  const store = deps.credentials || createCredentialStore({
    filePath: path.join(String(userDataDir), CREDENTIALS_FILE), safeStorage,
  });
  // The tunnel host needs no secret: present a constant record for it so the runner's
  // generic `filehost:<id>` lookup works and nothing is ever written to the store.
  const TUNNEL_CRED = `filehost:${TUNNEL_ID}`;
  const credentials = {
    get: async id => (id === TUNNEL_CRED ? { type: TUNNEL_ID } : store.get(id)),
    has: async id => (id === TUNNEL_CRED ? true : store.has(id)),
    set: (id, rec) => store.set(id, rec),
    clear: id => store.clear(id),
    listIds: () => store.listIds?.(),
  };
  const transport = deps.transport || createTransport({ fetchImpl, ...(sleep ? { sleep } : {}) });
  const journal = deps.journal || createJournal({ filePath: path.join(String(userDataDir), JOURNAL_FILE) });
  const makeS3Host = deps.makeFileHost || (record => {
    const { type: _type, ...cfg } = record;
    return createS3FileHost({ ...cfg, fetchImpl });
  });
  const repoRoot = path.join(__dirname, '..', '..');
  const makeTunnelHost = deps.makeTunnelHost || (() => createTunnelFileHost({
    fetchImpl,
    // cloudflared is not bundled: downloaded once into <userData>/listbridge/ on first use.
    resolveBinary: ({ onProgress } = {}) => resolveCloudflared({
      settingPath: deps.cloudflaredPath || null,
      userDataDir: String(userDataDir),
      repoRoot,
      fetchImpl,
      onProgress,
    }),
  }));
  // Every live tunnel host, so app quit can close them all (closeAll()).
  const liveTunnels = new Set();
  const makeFileHost = record => {
    if (record?.type !== TUNNEL_ID) return makeS3Host(record);
    for (const h of liveTunnels) if (h.closed) liveTunnels.delete(h);
    const host = makeTunnelHost();
    liveTunnels.add(host);
    return host;
  };
  const closeAll = async () => {
    const all = [...liveTunnels];
    liveTunnels.clear();
    await Promise.all(all.map(h => Promise.resolve().then(() => h.close()).catch(() => {})));
  };

  // Validate adapters eagerly-but-async (the core is ESM); every handler awaits this.
  let readyPromise = null;
  let liveRunner = null;   // set once ready() resolved; sync access for the quit / close prompts
  const ready = () => {
    readyPromise ||= (async () => {
      const core = await loadCore();
      for (const a of adapters) core.assertAdapter(a);
      const runner = createPublishRunner({
        adapters, credentials, transport, makeFileHost, zip, core, confirm, journal, ...(sleep ? { sleep } : {}),
      });
      liveRunner = runner;
      return { core, runner, byId: new Map(adapters.map(a => [a.describe().id, a])) };
    })();
    return readyPromise;
  };

  const jobOwner = new Map();   // jobId → webContents id

  // `<platform>:<account>` or `filehost:<id>` → parsed parts + the shape it must have.
  async function parseAccountId(id) {
    if (typeof id !== 'string') throw new Error('account id must be a string');
    const i = id.indexOf(':');
    const kind = id.slice(0, i);
    const rest = id.slice(i + 1);
    if (i < 1 || !PLATFORM_PART.test(kind) || !ID_PART.test(rest)) throw new Error('account id must look like "<platform>:<account>"');
    if (kind === 'filehost') return { id, kind: 'filehost', name: rest };
    const { byId } = await ready();
    const adapter = byId.get(kind);
    if (!adapter) throw new Error(`unknown platform "${kind}"`);
    return { id, kind: 'platform', platform: kind, accountId: rest, adapter };
  }

  function checkShape(parsed, secret) {
    if (!isPlainObject(secret)) throw new Error('credentials must be an object');
    let required; let optional = [];
    let record;
    if (parsed.kind === 'filehost') {
      if (parsed.name === TUNNEL_ID) throw new Error('the temporary-link file host needs no credentials');
      const type = secret.type ?? 's3';
      const spec = FILEHOST_TYPES[type];
      if (!spec || spec.noCredentials) throw new Error(`unknown file host type "${type}"`);
      ({ required, optional } = spec);
      record = { type };
    } else {
      required = parsed.adapter.describe().credentials || [];
      if (!required.length) throw new Error(`${parsed.platform} does not take saved credentials`);
      record = {};
    }
    const allowed = new Set([...required, ...optional, ...(parsed.kind === 'filehost' ? ['type'] : [])]);
    for (const k of Object.keys(secret)) if (!allowed.has(k)) throw new Error(`unexpected credential field "${k}"`);
    for (const k of required) record[k] = str(typeof secret[k] === 'string' ? secret[k].trim() : secret[k], k);
    for (const k of optional) {
      const v = str(secret[k], k, { required: false });
      if (v != null) record[k] = v.trim();
    }
    if (parsed.kind === 'filehost') makeFileHost(record);   // throws on a bad endpoint / bucket (message has no secret)
    return record;
  }

  function buildPackage(core, payload) {
    if (!isPlainObject(payload)) throw new Error('publish:start expects an object');
    const { manifest } = payload;
    if (!isPlainObject(manifest)) throw new Error('publish:start: manifest is required');
    const imgs = Array.isArray(payload.images) ? payload.images : [];
    const fls = Array.isArray(payload.files) ? payload.files : [];
    const mImgs = Array.isArray(manifest.images) ? manifest.images : [];
    const mFls = Array.isArray(manifest.files) ? manifest.files : [];
    if (imgs.length !== mImgs.length || fls.length !== mFls.length) {
      throw new Error('publish:start: byte arrays do not match the manifest entries');
    }
    if (imgs.length + fls.length > MAX_ITEMS) throw new Error(`publish:start: more than ${MAX_ITEMS} items`);
    let total = 0;
    const join = (entries, bytesList, label) => entries.map((m, i) => {
      if (!isPlainObject(m)) throw new Error(`${label} ${i}: entry must be an object`);
      const bytes = toBytes(bytesList[i], `${label} "${m.name}"`);
      if (m.size != null && Number(m.size) !== bytes.byteLength) throw new Error(`${label} "${m.name}": size does not match its bytes`);
      total += bytes.byteLength;
      // Only the fields the core knows; a manifest `path` is never used (no paths over IPC).
      return { name: m.name, mime: m.mime, role: m.role, bytes };
    });
    const images = join(mImgs, imgs, 'image');
    const files = join(mFls, fls, 'file');
    if (total > MAX_TOTAL_BYTES) throw new Error('publish:start: listing is larger than 2 GiB');
    if (typeof manifest.listbridge !== 'number' || manifest.listbridge > core.LISTBRIDGE_FORMAT) {
      throw new Error('publish:start: unsupported listing format');
    }
    return core.createListing({ ...manifest, images, files });
  }

  const progressTo = sender => event => {
    if (sender && !sender.isDestroyed?.()) sender.send('publish:progress', event);
  };
  const assertOwner = (event, jobId) => {
    if (typeof jobId !== 'string' || !jobOwner.has(jobId)) throw new Error('unknown publish job');
    if (jobOwner.get(jobId) !== event.sender?.id) throw new Error('publish job belongs to another window');
  };

  handle('publish:describe', async () => {
    const { byId } = await ready();
    return {
      platforms: [...byId.values()].map(a => {
        const d = a.describe();
        return {
          id: d.id, label: d.label, transfer: d.transfer, maxFiles: d.maxFiles, maxImages: d.maxImages,
          transfers: d.transfers ? [...d.transfers] : undefined,
          visibility: d.visibility ? [...d.visibility] : undefined, drafts: d.drafts === true,
          requires: d.requires ? [...d.requires] : undefined,
          listOptions: typeof a.buildListOptions === 'function',
          currencies: d.currencies ? [...d.currencies] : undefined, fields: [...(d.fields || [])],
          credentials: [...(d.credentials || [])], testConnection: typeof a.testConnection === 'function',
        };
      }),
      fileHosts: Object.entries(FILEHOST_TYPES).map(([type, s]) => ({
        type, label: s.label, credentials: [...s.required], optional: [...s.optional],
        needsCredentials: !s.noCredentials, requiresUptime: !!s.requiresUptime, default: type === TUNNEL_ID,
      })),
      defaultFileHost: TUNNEL_ID,
    };
  });

  handle('publish:hasCredentials', async (_e, id) => {
    const p = await parseAccountId(id);
    return credentials.has(p.id);
  });

  handle('publish:setCredentials', async (_e, id, secret) => {
    const p = await parseAccountId(id);
    await credentials.set(p.id, checkShape(p, secret));
    dropListOptions(p.id);
    return { ok: true };   // never echo the secret back
  });

  handle('publish:clearCredentials', async (_e, id) => {
    const p = await parseAccountId(id);
    dropListOptions(p.id);
    return { ok: true, removed: await credentials.clear(p.id) };
  });

  handle('publish:testConnection', async (_e, id) => {
    const p = await parseAccountId(id);
    const record = await credentials.get(p.id);
    if (!record) return { ok: false, message: 'No saved credentials for this account.' };
    try {
      if (p.kind === 'filehost') {
        const host = makeFileHost(record);
        try { return await host.testConnection(); } finally { if (typeof host.close === 'function') await host.close(); }
      }
      if (typeof p.adapter.testConnection !== 'function') return { ok: false, message: `${p.platform} has no connection test.` };
      const spec = p.adapter.testConnection();
      const auth = typeof p.adapter.authHeaders === 'function' ? p.adapter.authHeaders(record) : {};
      const res = await transport.request({
        url: spec.url, method: spec.method, body: spec.body, headers: { ...(spec.headers || {}), ...auth },
      });
      const gqlErrors = Array.isArray(res.json?.errors) && res.json.errors.length > 0;
      if (res.ok && !gqlErrors) return { ok: true, message: `Connected to ${p.adapter.describe().label}.` };
      return { ok: false, message: res.status === 401 || res.status === 403 ? 'The platform rejected these credentials.' : `Connection failed (HTTP ${res.status}).` };
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  });

  // Category + license lists (needs a saved account). Never throws for platform / network trouble:
  // { ok:false, message } lets the renderer fall back to free-text fields. Cached in memory per
  // platform + locale for LIST_OPTIONS_TTL_MS; saving or clearing the account's credentials drops it.
  const listOptionsCache = new Map();
  handle('publish:listOptions', async (_e, platform, locale) => {
    const { core: _core, byId } = await ready();
    const adapter = byId.get(typeof platform === 'string' ? platform : '');
    if (!adapter) throw new Error(`unknown platform "${platform}"`);
    if (typeof adapter.buildListOptions !== 'function') return { ok: false, message: `${platform} has no category and license lists.` };
    const loc = typeof locale === 'string' && locale.length <= 16 ? locale : 'en';
    const cacheKey = `${platform}|${loc}`;
    const hit = listOptionsCache.get(cacheKey);
    if (hit && now() - hit.at < LIST_OPTIONS_TTL_MS) return hit.value;
    try {
      const record = await credentials.get(`${platform}:${DEFAULT_ACCOUNT}`);
      if (!record) return { ok: false, message: 'No saved credentials for this account.' };
      const auth = typeof adapter.authHeaders === 'function' ? adapter.authHeaders(record) : {};
      const specs = adapter.buildListOptions({ locale: loc });
      const responses = [];
      for (const spec of Array.isArray(specs) ? specs : [specs]) {
        const res = await transport.request({
          url: spec.url, method: spec.method, body: spec.body, headers: { ...(spec.headers || {}), ...auth },
        });
        if (res.status >= 400) {
          return { ok: false, message: res.status === 401 || res.status === 403 ? 'The platform rejected these credentials.' : `The platform answered HTTP ${res.status}.` };
        }
        responses.push(res);
      }
      const value = { ok: true, ...adapter.parseListOptions(responses) };
      listOptionsCache.set(cacheKey, { at: now(), value });
      return value;
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  });
  const dropListOptions = id => { for (const k of [...listOptionsCache.keys()]) if (id.startsWith(`${k.split('|')[0]}:`)) listOptionsCache.delete(k); };

  handle('publish:start', async (event, payload) => {
    const { core, runner, byId } = await ready();
    if (!isPlainObject(payload)) throw new Error('publish:start expects an object');
    const platform = str(payload.platform, 'platform', { max: 40 });
    const adapter = byId.get(platform);
    if (!adapter) throw new Error(`unknown platform "${platform}"`);
    const accountId = str(payload.accountId, 'accountId', { max: 128 });
    if (!ID_PART.test(accountId)) throw new Error('accountId has invalid characters');
    let fileHostId = str(payload.fileHostId, 'fileHostId', { required: false, max: 128 });
    if (fileHostId && !ID_PART.test(fileHostId)) throw new Error('fileHostId has invalid characters');
    // URL-only platforms default to the temporary-link host (no account needed).
    if (!fileHostId && adapter.describe().transfer === 'url') fileHostId = TUNNEL_ID;
    const remoteId = str(payload.remoteId, 'remoteId', { required: false, max: 256 });
    const projectKey = str(payload.projectKey, 'projectKey', { required: false, max: 128 });
    if (projectKey && !ID_PART.test(projectKey)) throw new Error('projectKey has invalid characters');
    const pkg = buildPackage(core, payload);
    const d = adapter.describe();
    const issues = [...core.validateListing(pkg, { maxImages: d.maxImages, currencies: d.currencies }), ...(adapter.validate(pkg) || [])];
    if (issues.length) return { ok: false, status: 'invalid', issues };
    if (projectKey && !remoteId) {
      const pending = await pendingFor(runner, projectKey);
      if (pending.length) return { ok: false, status: 'pending', pending };
    }
    const jobId = runner.create({
      platform, accountId, fileHostId, remoteId, pkg, onProgress: progressTo(event.sender), zipName: slugName(pkg.title),
      projectKey,
    });
    jobOwner.set(jobId, event.sender?.id);
    return runner.run(jobId);
  });

  // Unsettled creates of a project, plus publishes of it still running (no journal entry yet).
  async function pendingFor(runner, projectKey) {
    const running = runner.runningJobs().filter(j => j.projectKey === projectKey);
    const live = new Set(running.map(j => j.jobId));
    const entries = (await journal.list()).filter(e => e.projectKey === projectKey).map(e => pendingView(e, live.has(e.jobId)));
    for (const j of running) if (!entries.some(e => e.jobId === j.jobId)) entries.push({ jobId: j.jobId, platform: j.platform, state: 'running', running: true });
    return entries;
  }

  // A 'creating' entry whose job is gone (crash, quit, restart) is unknown: the request may have landed.
  const pendingView = (e, running) => ({
    jobId: e.jobId, platform: e.platform, accountId: e.accountId, title: e.title ?? '', listing: e.listing ?? null,
    state: e.state === 'creating' && !running ? 'unknown' : e.state, running,
    ...(e.remoteId ? { remoteId: e.remoteId, url: e.url ?? '', status: e.status ?? null } : {}),
  });

  handle('publish:pending', async (_e, projectKey) => {
    const { runner } = await ready();
    if (typeof projectKey !== 'string' || !ID_PART.test(projectKey)) throw new Error('publish:pending needs a project key');
    return pendingFor(runner, projectKey);
  });

  // 'ack' = the listing record is saved in the project; 'check' = look the listing up on the platform;
  // 'discard' = the seller checked the platform and wants to publish anew (never while it runs).
  handle('publish:resolvePending', async (_e, jobId, action) => {
    const { runner } = await ready();
    if (typeof jobId !== 'string' || !ID_PART.test(jobId)) throw new Error('publish:resolvePending needs a job id');
    const entry = await journal.get(jobId);
    if (!entry) return { ok: true, state: 'gone' };
    const running = runner.runningJobs().some(j => j.jobId === jobId);
    if (action === 'ack') {
      if (entry.state !== 'created') throw new Error('only a created listing can be acknowledged');
      await journal.remove(jobId);
      return { ok: true, state: 'gone' };
    }
    if (running) return { ok: false, ...pendingView(entry, true) };
    if (action === 'discard') {
      await journal.remove(jobId);
      return { ok: true, state: 'gone' };
    }
    if (action !== 'check') throw new Error(`unknown action "${action}"`);
    if (entry.state === 'created') return { ok: true, ...pendingView(entry, false) };
    const found = await runner.findCreated({
      platform: entry.platform, accountId: entry.accountId, title: entry.title, locale: entry.locale, knownIds: entry.knownIds,
    });
    if (!found) return { ok: false, ...pendingView(entry, false) };
    return { ok: true, ...pendingView(await journal.put(jobId, { state: 'created', ...found }), false) };
  });

  handle('publish:retry', async (event, jobId) => {
    const { runner } = await ready();
    assertOwner(event, jobId);
    return runner.retry(jobId, { onProgress: progressTo(event.sender) });
  });

  handle('publish:cancel', async (event, jobId) => {
    const { runner } = await ready();
    assertOwner(event, jobId);
    return runner.cancel(jobId);
  });

  // "Keep waiting" (decision D2): extend a temporary-link hold by up to 60 min per call.
  handle('publish:extendHold', async (event, jobId, ms) => {
    const { runner } = await ready();
    assertOwner(event, jobId);
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) throw new Error('publish:extendHold needs a positive number of milliseconds');
    return runner.extendHold(jobId, ms);
  });

  // App close / quit safety (PB.14): is a publish still transferring, and cancel them all
  // (hosted copies removed, temporary links closed) when the user chose to quit anyway.
  const hasRunningJobs = () => !!liveRunner?.hasRunningJobs();
  const runningJobs = () => (liveRunner ? liveRunner.runningJobs() : []);
  const cancelAll = async () => {
    if (!liveRunner) return;
    await Promise.all(liveRunner.runningJobs().map(j => liveRunner.cancel(j.jobId).catch(() => {})));
  };

  return { ready, credentials, closeAll, hasRunningJobs, runningJobs, cancelAll };
}

module.exports = { registerListbridgeIpc, CREDENTIALS_FILE, JOURNAL_FILE, FILEHOST_TYPES, TUNNEL_ID, CONFIRM_OPTIONS, defaultZip, loadListbridgeCore: defaultLoadCore };
