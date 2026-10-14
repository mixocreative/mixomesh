// Listbridge credential store (ADR 0004 "Security", plan PB.4).
//
// One encrypted file holds every account record: platform accounts keyed
// `${platform}:${accountId}` (e.g. `cults3d:mixo`) and file hosts keyed `filehost:${id}`.
// The whole JSON object is encrypted with Electron's safeStorage (DPAPI on Windows) and
// written atomically (temp file + rename). If OS encryption is unavailable the store
// REFUSES to save — it never falls back to plaintext.
//
// `get()` is for the main process only: index.cjs never returns a record to the renderer
// (only has / listIds / ok flags). Pure Node: safeStorage is injected, so tests pass a fake.

const fs = require('node:fs/promises');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}:[A-Za-z0-9._@-]{1,128}$/;
const MAX_FIELDS = 32;
const MAX_VALUE_LEN = 8192;

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error('Listbridge credentials: id must look like "<platform>:<account>" or "filehost:<id>"');
  }
  return id;
}

// A record is a flat object of string / boolean / number values — no nesting, bounded size.
function assertSecretObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Listbridge credentials: record must be a plain object');
  }
  const entries = Object.entries(obj);
  if (entries.length < 1 || entries.length > MAX_FIELDS) throw new Error('Listbridge credentials: record has no fields or too many');
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(`Listbridge credentials: invalid field name "${k}"`);
    if (typeof v === 'string') {
      if (v.length > MAX_VALUE_LEN) throw new Error(`Listbridge credentials: field "${k}" is too long`);
    } else if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`Listbridge credentials: field "${k}" must be a string, number or boolean`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath  e.g. <userData>/listbridge-credentials.bin
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} opts.safeStorage
 * @param {object} [opts.io] fs overrides for tests ({ readFile, writeFile, rename, unlink })
 */
function createCredentialStore({ filePath, safeStorage, io: ioOverrides = {} } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('createCredentialStore: filePath is required');
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function'
      || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new TypeError('createCredentialStore: safeStorage is required');
  }
  const io = { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, ...ioOverrides };
  let chain = Promise.resolve();
  let tmpSeq = 0;

  const enqueue = task => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Listbridge credentials: OS encryption (safeStorage) is not available — '
        + 'credentials cannot be stored safely on this system, so they are not stored at all.');
    }
  };

  async function load() {
    let blob;
    try {
      blob = await io.readFile(filePath);
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
    if (!blob || blob.length === 0) return {};
    requireEncryption();
    let parsed;
    try {
      parsed = JSON.parse(safeStorage.decryptString(Buffer.from(blob)));
    } catch {
      // Never include the decrypted text (it may be partially valid secret JSON).
      throw new Error('Listbridge credentials: the credential file cannot be decrypted or is damaged. '
        + 'Clear the saved accounts and connect again.');
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  async function save(records) {
    requireEncryption();
    const blob = safeStorage.encryptString(JSON.stringify(records));
    const tmp = `${filePath}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      await io.writeFile(tmp, blob);
      await io.rename(tmp, filePath);
    } catch (err) {
      try { await io.unlink(tmp); } catch { /* temp already gone */ }
      throw err;
    }
  }

  return Object.freeze({
    has: id => enqueue(async () => Object.hasOwn(await load(), assertId(id))),
    set: (id, secretObject) => enqueue(async () => {
      assertId(id);
      const record = assertSecretObject(secretObject);
      requireEncryption();
      const records = await load();
      records[id] = record;
      await save(records);
    }),
    /** Main-process only: the decrypted record, or null. */
    get: id => enqueue(async () => {
      const records = await load();
      return Object.hasOwn(records, assertId(id)) ? { ...records[id] } : null;
    }),
    clear: id => enqueue(async () => {
      assertId(id);
      const records = await load();
      if (!Object.hasOwn(records, id)) return false;
      delete records[id];
      await save(records);
      return true;
    }),
    listIds: () => enqueue(async () => Object.keys(await load()).sort()),
  });
}

module.exports = { createCredentialStore, CREDENTIAL_ID_RE: ID_RE };
