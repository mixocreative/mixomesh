'use strict';
// Automation API server (plan API.4, ADR 0005). Pure factory: no Electron import,
// every side effect (net, fs, crypto, timers, renderer dispatch, file registry) is
// injected. NDJSON JSON-RPC 2.0 over a per-user Windows named pipe.
//
// Security model (main reviews this line by line):
//  * The pipe name is per-user, but the pipe is NOT the trust boundary. The trust
//    boundary is the 32-byte session token in `<userData>/api/session.json`, which
//    only the same Windows user can read (the per-user profile ACL covers
//    %APPDATA%; the file is also created with mode 0o600 where the OS honours it).
//  * The FIRST frame of every connection must be `hello` with the exact token
//    (crypto.timingSafeEqual). Anything else -> error frame, socket closed.
//  * Absolute OS paths exist only in this module. Path-typed params are validated
//    with validateLaunchPath, then replaced by opaque registry refs ({ref,name}) or
//    dropped (outputs). The renderer-bound params never contain a path; a defensive
//    scan rejects drive/UNC-looking strings in anything forwarded.
//  * Bytes returned by the renderer are written HERE (temp file + rename in the same
//    folder), to a path validated by this module, refusing to overwrite unless the
//    caller passed overwrite:true. Error messages carry basenames only.
//  * Never logs or echoes the token or file contents.

const nodePath = require('node:path').win32;
const {
  validateLaunchPath, MAX_API_IMPORTS, OUTPUT_EXTENSIONS,
} = require('./LaunchArgs.cjs');
const { MAX_WRITE_BYTES } = require('./OpaqueFileRegistry.cjs');

// ---- constants mirrored from src/core/api (ES modules not shipped in the asar);
// ---- tests/api-server.test.mjs pins every one of these equal to the source.
const API_VERSION = 1;
const ERROR_CODES = Object.freeze({
  E_INVALID_PARAMS: -32602,
  E_METHOD_NOT_FOUND: -32601,
  E_INTERNAL: -32603,
  E_NOT_FOUND: -32000,
  E_PATH_REJECTED: -32001,
  E_BUSY: -32002,
  E_CONFIRM_REQUIRED: -32003,
  E_DIRTY: -32004,
  E_CANCELLED: -32005,
  E_UNSUPPORTED: -32006,
  E_EXPORT_GATE: -32007,
  E_LIMIT: -32008,
  E_TIMEOUT: -32009,
});
const METHOD_NAMES = Object.freeze([
  'app.info', 'app.capabilities', 'app.ping',
  'project.new', 'project.open', 'project.save', 'project.saveAs', 'project.info',
  'scene.list', 'scene.get', 'scene.import', 'scene.remove', 'scene.select', 'scene.transform',
  'library.mount', 'library.list',
  'printer.list', 'printer.get', 'printer.set',
  'validate.run', 'repair.run', 'readiness.get', 'cost.quote',
  'export.run', 'render.png', 'render.thumbnail',
  'events.subscribe',
]);
const EVENT_TYPES = Object.freeze([
  'objectAdded', 'objectRemoved', 'selectionChanged', 'validationDone',
  'exportDone', 'projectOpened', 'projectSaved', 'busy',
]);
// Standard JSON-RPC protocol codes outside the fixed application error model.
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;

// Path-typed methods. `pathKey` is removed from the forwarded params; `allow` is the
// exhaustive set of OTHER keys that may be forwarded (unknown keys are refused so a
// stray path can never ride along in a field the renderer would see).
const PATH_METHODS = Object.freeze({
  'scene.import': { pathKey: 'files', allow: [] },
  'library.mount': { pathKey: 'dir', allow: [] },
  'project.open': { pathKey: 'file', allow: ['confirm'] },
  'project.saveAs': { pathKey: 'file', allow: ['overwrite'], consume: ['overwrite'] },
  'export.run': { pathKey: 'outDir', allow: ['formats', 'selectedOnly', 'overwrite', 'options'], consume: ['overwrite'] },
  'render.png': { pathKey: 'outFile', allow: ['width', 'height', 'preset', 'overwrite'], consume: ['overwrite'] },
  'render.thumbnail': { pathKey: 'outFile', allow: ['size', 'overwrite'], consume: ['overwrite'] },
});
const SINGLE_OUTPUT_EXT = Object.freeze({ 'project.saveAs': 'mixo', 'render.png': 'png', 'render.thumbnail': 'png' });
// Fields only main knows, merged into the renderer's answer to these methods. Whitelisted
// and typed: never a path, never anything the renderer could have supplied.
const MAIN_INFO_METHODS = Object.freeze(['app.info', 'app.capabilities']);

const LIMITS = Object.freeze({
  maxClients: 4,
  maxFrameBytes: 1024 * 1024,
  maxPreAuthFrameBytes: 16 * 1024,
  requestTimeoutMs: 10 * 60 * 1000,
  helloTimeoutMs: 10 * 1000,
  maxPendingPerClient: 64,
  eventsPerSecond: 50,
  closeGraceMs: 2000,
});

const DRIVE_OR_UNC_RE = /^[a-zA-Z]:[\\/]|^[\\/]{2}/;

const apiError = (code, message, data) => {
  const known = Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
  const sym = known ? code : 'E_INTERNAL';
  return { code: ERROR_CODES[sym], message: String(message || sym), data: { ...(data || {}), code: sym } };
};
const isApiError = e => !!e && typeof e === 'object' && typeof e.code === 'number'
  && !!e.data && typeof e.data === 'object'
  && Object.entries(ERROR_CODES).some(([k, v]) => v === e.code && k === e.data.code);
const baseName = raw => nodePath.basename(String(raw).replace(/\0/g, '')) || '(empty)';
const rejected = v => apiError('E_PATH_REJECTED', `${v.name}: ${v.reason}`, { name: v.name });

/** Does any string inside `value` look like a drive / UNC path? (depth-limited) */
function containsAbsolutePath(value, depth = 0) {
  if (typeof value === 'string') return DRIVE_OR_UNC_RE.test(value);
  if (depth > 8 || !value || typeof value !== 'object') return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some(v => containsAbsolutePath(v, depth + 1));
}

const isBytes = b => Buffer.isBuffer(b) || b instanceof Uint8Array || b instanceof ArrayBuffer || ArrayBuffer.isView(b);
function toBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b));
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && !isBytes(v);

/** Per-user pipe name: first 16 hex chars of sha256(username + userDataDir). */
function pipeNameFor(crypto, username, userDataDir) {
  const h = crypto.createHash('sha256').update(String(username) + String(userDataDir)).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\mixomesh-${h}`;
}

/**
 * Read + shape-check this user's session file (<userData>/api/session.json) for the --job client
 * (API.7). Returns {pipe, token, pid, apiVersion}; throws if absent or malformed. Callers must
 * never log the result (it holds the token).
 */
async function readSessionFile(fs, userDataDir) {
  const doc = JSON.parse(await fs.readFile(nodePath.join(userDataDir, 'api', 'session.json'), 'utf8'));
  if (!isPlainObject(doc) || typeof doc.pipe !== 'string' || typeof doc.token !== 'string') throw new Error('malformed session file');
  return doc;
}

const API_KV_KEY = 'api_enabled';

/**
 * Startup read of the Preferences API switch: absent = on, false = off, but only from a file
 * that read cleanly. An unreadable or quarantined file fails closed (the user may have turned
 * the API off), and a quarantined one gets an explicit false so the next start stays off too.
 */
async function readApiEnabled(kv) {
  const off = { enabled: false, notice: 'settings-unreadable' };
  let value;
  try { value = await kv.get(API_KV_KEY); } catch { return off; }
  if (kv.damaged()) {
    await kv.set(API_KV_KEY, false).catch(() => {});
    return off;
  }
  return { enabled: value !== false, notice: null };
}

/**
 * @param {object} deps
 *  net {createServer}, fs {mkdir,writeFile,rename,unlink,realpath,stat,access},
 *  crypto {randomBytes,createHash,timingSafeEqual}, setTimeout, clearTimeout,
 *  dispatch(method, params) -> Promise<result>, registerFile, registerMount,
 *  userDataDir, username, pid?, mainInfo?() -> {appVersion, platform, pid},
 *  limits? (overrides, tests only)
 */
function createApiServer(deps) {
  const {
    net, fs, crypto, dispatch, registerFile, registerMount, userDataDir, username,
  } = deps;
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const limits = { ...LIMITS, ...(deps.limits || {}) };
  const sessionDir = nodePath.join(userDataDir, 'api');
  const sessionFile = nodePath.join(sessionDir, 'session.json');
  const pipe = pipeNameFor(crypto, username, userDataDir);
  const fsApi = { realpath: fs.realpath, stat: fs.stat, access: fs.access };

  let server = null;
  let token = null;
  let started = false;
  const clients = new Set();

  // ---------------------------------------------------------------- framing
  const frame = obj => `${JSON.stringify(obj)}\n`;
  const send = (client, obj) => {
    if (client.closed || client.socket.destroyed) return;
    try { client.socket.write(frame(obj)); } catch { /* peer gone */ }
  };
  const sendError = (client, id, error) => send(client, { jsonrpc: '2.0', id: id ?? null, error });

  function closeClient(client, finalFrame) {
    if (client.closed) return;
    client.closed = true;
    if (client.helloTimer) { clearT(client.helloTimer); client.helloTimer = null; }
    clients.delete(client);
    try {
      if (finalFrame) client.socket.end(frame(finalFrame)); else client.socket.end();
    } catch { /* already closed */ }
    const t = setT(() => { try { client.socket.destroy(); } catch { /* ok */ } }, limits.closeGraceMs);
    if (t && typeof t.unref === 'function') t.unref();
  }

  const failAndClose = (client, id, error) => closeClient(client, { jsonrpc: '2.0', id: id ?? null, error });

  // ------------------------------------------------------------------ hello
  /** Constant-time token comparison; length mismatch still burns a compare. */
  function tokenMatches(given) {
    if (typeof given !== 'string' || token === null) return false;
    const expected = Buffer.from(token, 'utf8');
    const got = Buffer.from(given, 'utf8');
    if (got.length !== expected.length) {
      crypto.timingSafeEqual(expected, expected);
      return false;
    }
    return crypto.timingSafeEqual(got, expected);
  }

  function handleHello(client, msg) {
    const id = msg && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || msg.method !== 'hello' || id === null) {
      return failAndClose(client, id, apiError('E_INVALID_PARAMS', 'hello is required as the first frame', { reason: 'hello-required' }));
    }
    const p = msg.params;
    if (!isPlainObject(p) || !tokenMatches(p.token)) {
      return failAndClose(client, id, apiError('E_INVALID_PARAMS', 'authentication failed', { reason: 'bad-token' }));
    }
    if (p.apiVersion !== API_VERSION) {
      return failAndClose(client, id, apiError('E_UNSUPPORTED', `unsupported apiVersion (server speaks ${API_VERSION})`, { apiVersion: API_VERSION }));
    }
    client.authed = true;
    if (client.helloTimer) { clearT(client.helloTimer); client.helloTimer = null; }
    send(client, { jsonrpc: '2.0', id, result: { apiVersion: API_VERSION, authenticated: true } });
  }

  // ------------------------------------------------------ request execution
  /** Build the renderer-bound params; throws an apiError. Never contains a path. */
  function pickForwarded(method, params, spec) {
    const out = {};
    for (const k of Object.keys(params)) {
      if (k === spec.pathKey) continue;
      if (!spec.allow.includes(k)) throw apiError('E_INVALID_PARAMS', `${method}: "${k}" is not a known parameter`, { field: k });
      if (spec.consume && spec.consume.includes(k)) continue;
      out[k] = params[k];
    }
    return out;
  }

  const requireAbsolute = raw => {
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
      return { ok: false, name: baseName(raw), reason: 'empty or invalid path' };
    }
    if (!nodePath.isAbsolute(raw)) return { ok: false, name: baseName(raw), reason: 'path must be absolute' };
    return null;
  };

  async function validatePath(raw, kind) {
    const pre = requireAbsolute(raw);
    if (pre) return pre;
    try {
      return await validateLaunchPath(raw, { kind, cwd: userDataDir, ...fsApi });
    } catch {
      return { ok: false, name: baseName(raw), reason: 'could not be checked' };
    }
  }

  async function writeAtomic(abs, bytes) {
    const buf = toBuffer(bytes);
    if (buf.byteLength > MAX_WRITE_BYTES) throw apiError('E_LIMIT', `${baseName(abs)}: file too large to write`, { limit: MAX_WRITE_BYTES });
    const tmp = `${abs}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, buf, { flag: 'wx' });
      await fs.rename(tmp, abs);
    } catch {
      try { await fs.unlink(tmp); } catch { /* never created / moved */ }
      throw apiError('E_INTERNAL', `${baseName(abs)}: could not be written`);
    }
    return buf.byteLength;
  }

  /** Re-validate right before writing; refuse when it now exists and !overwrite. */
  async function recheckOutput(abs, overwrite) {
    const v = await validatePath(abs, 'outputFile');
    if (!v.ok) throw rejected(v);
    if (v.exists && !overwrite) throw existsError(v.name);
    return v.absolutePath;
  }
  const existsError = name => apiError('E_PATH_REJECTED', `${name}: already exists (pass overwrite:true to replace it)`, { name, exists: true });

  /**
   * Rewrite one request. Returns {forward, finish(result)}: `forward` is the exact
   * params object handed to dispatch; `finish` turns the dispatch result into the
   * caller's response (writing any bytes to the validated outputs).
   */
  async function prepare(method, rawParams) {
    const params = rawParams === undefined || rawParams === null ? {} : rawParams;
    if (!isPlainObject(params)) throw apiError('E_INVALID_PARAMS', `${method}: params must be an object`);
    const spec = PATH_METHODS[method];
    const identity = { forward: params, finish: async result => result };

    if (!spec) {
      if (containsAbsolutePath(params)) throw apiError('E_PATH_REJECTED', `${method}: paths are not accepted by this method`);
      return identity;
    }
    if (params[spec.pathKey] === undefined) throw apiError('E_INVALID_PARAMS', `${method}: "${spec.pathKey}" is required`, { field: spec.pathKey });
    const forward = pickForwarded(method, params, spec);
    if (containsAbsolutePath(forward)) throw apiError('E_PATH_REJECTED', `${method}: paths are only accepted in "${spec.pathKey}"`);
    const overwriteRaw = params.overwrite;
    if (overwriteRaw !== undefined && typeof overwriteRaw !== 'boolean') {
      throw apiError('E_INVALID_PARAMS', `${method}: "overwrite" must be a boolean`, { field: 'overwrite' });
    }
    const overwrite = overwriteRaw === true;
    const raw = params[spec.pathKey];

    // ---- inputs: replaced by opaque refs ----
    if (method === 'scene.import') {
      if (!Array.isArray(raw) || raw.length === 0) throw apiError('E_INVALID_PARAMS', 'scene.import: "files" must be a non-empty array', { field: 'files' });
      if (raw.length > MAX_API_IMPORTS) throw apiError('E_LIMIT', `scene.import: more than ${MAX_API_IMPORTS} files`, { field: 'files', limit: MAX_API_IMPORTS });
      const checked = [];
      for (const f of raw) {
        const v = await validatePath(f, 'file');
        if (!v.ok) throw rejected(v);
        if (v.ext === 'mixo') throw rejected({ name: v.name, reason: 'project files are opened with project.open' });
        checked.push(v);
      }
      forward.files = checked.map(v => {
        const r = registerFile(v.absolutePath, v.name, { writable: false });
        return { ref: r.ref, name: r.name };
      });
      return { forward, finish: async result => result };
    }
    if (method === 'library.mount') {
      const v = await validatePath(raw, 'directory');
      if (!v.ok) throw rejected(v);
      const r = registerMount(v.absolutePath, v.name);
      forward.dir = { ref: r.ref, name: r.name };
      return { forward, finish: async result => result };
    }
    if (method === 'project.open') {
      const v = await validatePath(raw, 'file');
      if (!v.ok) throw rejected(v);
      if (v.ext !== 'mixo') throw rejected({ name: v.name, reason: 'not a .mixo project file' });
      const r = registerFile(v.absolutePath, v.name, { writable: true });
      forward.file = { ref: r.ref, name: r.name };
      return { forward, finish: async result => result };
    }

    // ---- outputs: path stays here, renderer gets nothing ----
    if (method === 'export.run') {
      const dir = await validatePath(raw, 'outputDir');
      if (!dir.ok) throw rejected(dir);
      return {
        forward,
        finish: result => finishExport(dir, overwrite, result),
      };
    }
    const file = await validatePath(raw, 'outputFile');
    if (!file.ok) throw rejected(file);
    if (file.ext !== SINGLE_OUTPUT_EXT[method]) throw rejected({ name: file.name, reason: `must be a .${SINGLE_OUTPUT_EXT[method]} file` });
    if (file.exists && !overwrite) throw existsError(file.name);
    if (method === 'project.saveAs') {
      // The renderer saves through PersistenceManager.saveAs so the project stays bound to
      // the file: it gets a WRITABLE token for the (possibly not-yet-existing) validated
      // path, exactly what project:pickSave mints. No bytes come back; nothing is written here.
      const r = registerFile(file.absolutePath, file.name, { writable: true });
      forward.file = { ref: r.ref, name: r.name };
      return { forward, finish: async result => result };
    }
    return {
      forward,
      finish: result => finishSingle(file, overwrite, result),
    };
  }

  function splitResult(result) {
    if (isBytes(result)) return { data: result, rest: {} };
    if (isPlainObject(result) && isBytes(result.bytes)) {
      const { bytes, ...rest } = result;
      return { data: bytes, rest };
    }
    return null;
  }

  async function finishSingle(file, overwrite, result) {
    const parts = splitResult(result);
    if (!parts) throw apiError('E_INTERNAL', 'the app returned no data to write');
    const abs = await recheckOutput(file.absolutePath, overwrite);
    const size = await writeAtomic(abs, parts.data);
    return { ...parts.rest, path: abs, size };
  }

  async function finishExport(dir, overwrite, result) {
    let list = null;
    let rest = {};
    if (Array.isArray(result)) list = result;
    else if (isPlainObject(result) && Array.isArray(result.files)) { const { files, ...r } = result; list = files; rest = r; }
    if (!list) throw apiError('E_INTERNAL', 'the app returned no files to write');
    const seen = new Set();
    const plan = [];
    for (const item of list) {
      if (!isPlainObject(item) || typeof item.name !== 'string' || !isBytes(item.bytes)) {
        throw apiError('E_INTERNAL', 'the app returned an invalid export file');
      }
      const name = item.name;
      if (name === '' || name !== nodePath.basename(name) || name === '.' || name === '..') {
        throw rejected({ name: baseName(name), reason: 'invalid export file name' });
      }
      const key = name.toLowerCase();
      if (seen.has(key)) throw rejected({ name, reason: 'duplicate export file name' });
      seen.add(key);
      const v = await validatePath(nodePath.join(dir.absolutePath, name), 'outputFile');
      if (!v.ok) throw rejected(v);
      if (v.exists && !overwrite) throw existsError(v.name);
      plan.push({ v, bytes: item.bytes });
    }
    // Preflight passed for every file; now write (re-checking each right before).
    const written = [];
    for (const { v, bytes } of plan) {
      const abs = await recheckOutput(v.absolutePath, overwrite);
      const size = await writeAtomic(abs, bytes);
      written.push({ name: v.name, path: abs, size });
    }
    return { ...rest, outDir: dir.absolutePath, files: written };
  }

  /** Full pipeline for one authenticated request. Resolves to the JSON-RPC result. */
  async function execute(method, rawParams, client) {
    if (typeof method !== 'string' || !METHOD_NAMES.includes(method)) {
      throw apiError('E_METHOD_NOT_FOUND', `unknown method "${String(method).slice(0, 64)}"`);
    }
    const job = await prepare(method, rawParams);
    // The renderer keeps ONE subscription set for every client: give it the union of all
    // live clients' types (notify() filters per client), and answer with this client's own.
    // Recorded before the dispatch so a concurrent subscribe from another client already
    // includes it; restored if the renderer rejects the list.
    let ownSubs = null;
    const prevSubs = client?.subs ?? null;
    if (method === 'events.subscribe') {
      const asked = Array.isArray(job.forward.events) ? job.forward.events : [];
      ownSubs = asked.length ? [...new Set(asked)] : [...EVENT_TYPES];
      if (client) client.subs = new Set(ownSubs);
      const union = new Set(ownSubs);
      for (const c of clients) if (c.authed && !c.closed && c.subs) for (const t of c.subs) union.add(t);
      job.forward = { ...job.forward, events: [...union] };
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setT(() => reject(apiError('E_TIMEOUT', `${method}: timed out`)), limits.requestTimeoutMs);
    });
    let result;
    try {
      result = await Promise.race([Promise.resolve().then(() => dispatch(method, job.forward)), timeout]);
    } catch (err) {
      if (ownSubs && client) client.subs = prevSubs;
      throw err;
    } finally {
      if (timer) clearT(timer);
    }
    const out = mergeMainInfo(method, await job.finish(result));
    return ownSubs ? { ...out, subscribed: ownSubs } : out;
  }

  /** app.info / app.capabilities: add the fields only main knows (typed whitelist, no paths). */
  function mergeMainInfo(method, out) {
    if (!MAIN_INFO_METHODS.includes(method) || !isPlainObject(out) || typeof deps.mainInfo !== 'function') return out;
    let info;
    try { info = deps.mainInfo(); } catch { return out; }
    if (!isPlainObject(info)) return out;
    const extra = {};
    if (typeof info.appVersion === 'string' && info.appVersion.length <= 64) extra.appVersion = info.appVersion;
    if (typeof info.platform === 'string' && info.platform.length <= 32) extra.platform = info.platform;
    if (Number.isInteger(info.pid)) extra.pid = info.pid;
    const merged = { ...out, ...extra };
    if (method === 'app.info' && merged.version == null && extra.appVersion) merged.version = extra.appVersion;
    return merged;
  }

  const toWireError = err => (isApiError(err) ? err : apiError('E_INTERNAL', 'internal error'));

  async function handleRequest(client, msg) {
    const id = msg.id;
    if (client.pending >= limits.maxPendingPerClient) {
      return sendError(client, id, apiError('E_LIMIT', 'too many requests in flight', { limit: limits.maxPendingPerClient }));
    }
    client.pending++;
    try {
      const result = await execute(msg.method, msg.params, client);
      send(client, { jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (err) {
      sendError(client, id, toWireError(err));
    } finally {
      client.pending--;
    }
  }

  function handleLine(client, line) {
    let msg;
    try { msg = JSON.parse(line.toString('utf8')); } catch {
      const err = { code: RPC_PARSE_ERROR, message: 'Parse error', data: { code: 'E_PARSE' } };
      return client.authed ? sendError(client, null, err) : failAndClose(client, null, err);
    }
    if (!client.authed) return handleHello(client, msg);
    const validId = msg && (typeof msg.id === 'string' || typeof msg.id === 'number');
    if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return sendError(client, validId ? msg.id : null, { code: RPC_INVALID_REQUEST, message: 'Invalid Request', data: { code: 'E_INVALID_REQUEST' } });
    }
    if (msg.id === undefined) return undefined; // client notification: no response, nothing to do
    if (!validId) {
      return sendError(client, null, { code: RPC_INVALID_REQUEST, message: 'Invalid Request', data: { code: 'E_INVALID_REQUEST' } });
    }
    if (msg.method === 'hello') {
      return send(client, { jsonrpc: '2.0', id: msg.id, result: { apiVersion: API_VERSION, authenticated: true } });
    }
    handleRequest(client, msg).catch(() => { /* handleRequest never rejects; belt and braces */ });
    return undefined;
  }

  function onData(client, chunk) {
    if (client.closed) return;
    let buf = client.buf.length ? Buffer.concat([client.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]) : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const capNow = () => (client.authed ? limits.maxFrameBytes : limits.maxPreAuthFrameBytes);
    const oversize = () => failAndClose(client, null, apiError('E_LIMIT', 'frame too large', { limit: capNow() }));
    let idx = buf.indexOf(10);
    while (idx >= 0 && !client.closed) {
      let line = buf.subarray(0, idx);
      buf = buf.subarray(idx + 1);
      if (line.length > capNow()) return oversize();
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      if (line.length) handleLine(client, line);
      idx = buf.indexOf(10);
    }
    if (client.closed) return undefined;
    if (buf.length > capNow()) return oversize();
    client.buf = buf;
    return undefined;
  }

  function onConnection(socket) {
    if (!started || clients.size >= limits.maxClients) {
      try {
        socket.end(frame({ jsonrpc: '2.0', id: null, error: apiError('E_LIMIT', 'too many clients', { limit: limits.maxClients }) }));
      } catch { /* ok */ }
      const t = setT(() => { try { socket.destroy(); } catch { /* ok */ } }, limits.closeGraceMs);
      if (t && typeof t.unref === 'function') t.unref();
      return;
    }
    const client = {
      socket, buf: Buffer.alloc(0), authed: false, closed: false, pending: 0, subs: null, helloTimer: null,
      events: { windowStart: 0, sent: 0, dropped: 0 },
    };
    clients.add(client);
    client.helloTimer = setT(() => {
      if (!client.authed) failAndClose(client, null, apiError('E_TIMEOUT', 'hello not received in time'));
    }, limits.helloTimeoutMs);
    if (client.helloTimer && typeof client.helloTimer.unref === 'function') client.helloTimer.unref();
    socket.on('data', chunk => onData(client, chunk));
    socket.on('error', () => closeClient(client));
    socket.on('close', () => {
      client.closed = true;
      if (client.helloTimer) { clearT(client.helloTimer); client.helloTimer = null; }
      clients.delete(client);
    });
  }

  // -------------------------------------------------------------- lifecycle
  async function removeSessionFile() {
    try { await fs.unlink(sessionFile); } catch { /* absent */ }
  }

  async function start() {
    if (started) throw new Error('ApiServer already started');
    token = crypto.randomBytes(32).toString('hex');
    started = true;
    server = net.createServer(onConnection);
    try {
      await new Promise((resolve, reject) => {
        server.once?.('error', reject);
        server.listen(pipe, () => { server.removeListener?.('error', reject); resolve(); });
      });
      // The session file is written only AFTER the pipe is listening, so a reader
      // never finds a file pointing at a dead pipe. Temp + rename = no torn reads.
      await fs.mkdir(sessionDir, { recursive: true });
      const tmp = `${sessionFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const body = JSON.stringify({ pipe, token, pid, apiVersion: API_VERSION });
      try {
        await fs.writeFile(tmp, body, { flag: 'wx', mode: 0o600 });
        await fs.rename(tmp, sessionFile);
      } catch (err) {
        try { await fs.unlink(tmp); } catch { /* ok */ }
        throw err;
      }
    } catch (err) {
      await stop();
      throw err;
    }
    return { pipe };
  }

  async function stop() {
    started = false;
    for (const c of [...clients]) {
      c.closed = true;
      if (c.helloTimer) { clearT(c.helloTimer); c.helloTimer = null; }
      try { c.socket.destroy(); } catch { /* ok */ }
    }
    clients.clear();
    const s = server;
    server = null;
    token = null;
    if (s) await new Promise(resolve => { try { s.close(() => resolve()); } catch { resolve(); } });
    await removeSessionFile();
  }

  /**
   * Fan an app event out to subscribed, authenticated clients only, each capped at
   * LIMITS.eventsPerSecond; a client's next delivered event carries what it missed as `dropped`.
   */
  function notify(evt) {
    if (!isPlainObject(evt) || !EVENT_TYPES.includes(evt.type)) return 0;
    const t = now();
    let n = 0;
    for (const c of clients) {
      if (!c.authed || c.closed || !c.subs || !c.subs.has(evt.type)) continue;
      const w = c.events;
      if (t - w.windowStart >= 1000) { w.windowStart = t; w.sent = 0; }
      if (w.sent >= limits.eventsPerSecond) { w.dropped++; continue; }
      w.sent++;
      const params = w.dropped ? { ...evt, dropped: (evt.dropped || 0) + w.dropped } : evt;
      w.dropped = 0;
      send(c, { jsonrpc: '2.0', method: 'event', params });
      n++;
    }
    return n;
  }

  /** Same pipeline as a socket request, minus the socket (for --job, API.7). */
  async function dispatchLocal(method, params) {
    try {
      return { ok: true, result: await execute(method, params, null) };
    } catch (err) {
      return { ok: false, error: toWireError(err) };
    }
  }

  return {
    start, stop, notify, dispatchLocal,
    get pipe() { return pipe; },
    get sessionFile() { return sessionFile; },
    get clientCount() { return clients.size; },
  };
}

module.exports = {
  createApiServer, pipeNameFor, readSessionFile, readApiEnabled, API_KV_KEY, containsAbsolutePath, apiError, LIMITS,
  API_VERSION, ERROR_CODES, METHOD_NAMES, EVENT_TYPES, PATH_METHODS, OUTPUT_EXTENSIONS,
};
