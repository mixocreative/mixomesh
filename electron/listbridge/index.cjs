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
// No Electron import here (safeStorage / userData come in through deps) so the wiring is
// unit-testable under plain node. The portable core (src/listbridge, ESM) is loaded with
// dynamic import() by loadCore().

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCredentialStore } = require('./credentials.cjs');
const { createTransport } = require('./transport.cjs');
const { createPublishRunner } = require('./jobs.cjs');
const { createS3FileHost } = require('./filehosts/s3.cjs');

const CREDENTIALS_FILE = 'listbridge-credentials.bin';
const MAX_ITEM_BYTES = 1024 * 1024 * 1024;          // 1 GiB per file / image
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;     // 2 GiB per listing
const MAX_ITEMS = 64;
const MAX_FIELD_LEN = 4096;

// File host types and their credential fields (required, optional).
const FILEHOST_TYPES = Object.freeze({
  s3: {
    label: 'S3-compatible (Cloudflare R2, AWS S3, …)',
    required: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    optional: ['prefix', 'style'],
  },
});

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
 * @param {(record: any) => any} [deps.makeFileHost]
 * @param {(files: any[]) => Promise<Uint8Array>} [deps.zip]
 * @param {any} [deps.transport]
 * @param {any} [deps.credentials]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
function registerListbridgeIpc(handle, deps = {}) {
  const {
    userDataDir, safeStorage, adapters = [], fetchImpl = globalThis.fetch, loadCore = defaultLoadCore,
    zip = defaultZip, sleep,
  } = deps;
  const credentials = deps.credentials || createCredentialStore({
    filePath: path.join(String(userDataDir), CREDENTIALS_FILE), safeStorage,
  });
  const transport = deps.transport || createTransport({ fetchImpl, ...(sleep ? { sleep } : {}) });
  const makeFileHost = deps.makeFileHost || (record => {
    const { type: _type, ...cfg } = record;
    return createS3FileHost({ ...cfg, fetchImpl });
  });

  // Validate adapters eagerly-but-async (the core is ESM); every handler awaits this.
  let readyPromise = null;
  const ready = () => {
    readyPromise ||= (async () => {
      const core = await loadCore();
      for (const a of adapters) core.assertAdapter(a);
      const runner = createPublishRunner({
        adapters, credentials, transport, makeFileHost, zip, core, ...(sleep ? { sleep } : {}),
      });
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
      const type = secret.type ?? 's3';
      const spec = FILEHOST_TYPES[type];
      if (!spec) throw new Error(`unknown file host type "${type}"`);
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
          currencies: d.currencies ? [...d.currencies] : undefined, fields: [...(d.fields || [])],
          credentials: [...(d.credentials || [])], testConnection: typeof a.testConnection === 'function',
        };
      }),
      fileHosts: Object.entries(FILEHOST_TYPES).map(([type, s]) => ({
        type, label: s.label, credentials: [...s.required], optional: [...s.optional],
      })),
    };
  });

  handle('publish:hasCredentials', async (_e, id) => {
    const p = await parseAccountId(id);
    return credentials.has(p.id);
  });

  handle('publish:setCredentials', async (_e, id, secret) => {
    const p = await parseAccountId(id);
    await credentials.set(p.id, checkShape(p, secret));
    return { ok: true };   // never echo the secret back
  });

  handle('publish:clearCredentials', async (_e, id) => {
    const p = await parseAccountId(id);
    return { ok: true, removed: await credentials.clear(p.id) };
  });

  handle('publish:testConnection', async (_e, id) => {
    const p = await parseAccountId(id);
    const record = await credentials.get(p.id);
    if (!record) return { ok: false, message: 'No saved credentials for this account.' };
    try {
      if (p.kind === 'filehost') return await makeFileHost(record).testConnection();
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

  handle('publish:start', async (event, payload) => {
    const { core, runner, byId } = await ready();
    if (!isPlainObject(payload)) throw new Error('publish:start expects an object');
    const platform = str(payload.platform, 'platform', { max: 40 });
    const adapter = byId.get(platform);
    if (!adapter) throw new Error(`unknown platform "${platform}"`);
    const accountId = str(payload.accountId, 'accountId', { max: 128 });
    if (!ID_PART.test(accountId)) throw new Error('accountId has invalid characters');
    const fileHostId = str(payload.fileHostId, 'fileHostId', { required: false, max: 128 });
    if (fileHostId && !ID_PART.test(fileHostId)) throw new Error('fileHostId has invalid characters');
    const remoteId = str(payload.remoteId, 'remoteId', { required: false, max: 256 });
    const pkg = buildPackage(core, payload);
    const d = adapter.describe();
    const issues = [...core.validateListing(pkg, { maxImages: d.maxImages, currencies: d.currencies }), ...(adapter.validate(pkg) || [])];
    if (issues.length) return { ok: false, status: 'invalid', issues };
    const jobId = runner.create({
      platform, accountId, fileHostId, remoteId, pkg, onProgress: progressTo(event.sender), zipName: slugName(pkg.title),
    });
    jobOwner.set(jobId, event.sender?.id);
    return runner.run(jobId);
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

  return { ready, credentials };
}

module.exports = { registerListbridgeIpc, CREDENTIALS_FILE, FILEHOST_TYPES, defaultZip };
