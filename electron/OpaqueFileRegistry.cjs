const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;

// Stable keys minted by persistRef: `dir_` / `file_` + 32 hex of sha256(path).
const STABLE_KEY_RE = /^(dir|file)_[0-9a-f]{32}$/;
const DEFAULT_FIND_LIMIT = 4000;
const MAX_FIND_LIMIT = 20000;

/** In-memory store with the KvStore surface (tests / no persistence configured). */
function createMemoryStore() {
  const map = new Map();
  return {
    get: async key => (map.has(key) ? map.get(key) : null),
    set: async (key, value) => { map.set(key, value); },
    delete: async key => { map.delete(key); },
  };
}

/**
 * Main-process-only registry. Renderer code receives random session tokens
 * (`mount_*` / `ref_*`) and stable keys (`dir_*` / `file_*`); operating-system
 * paths remain inside this closure and the main-process ref store.
 *
 * deps (all optional, injectable for tests): randomUUID, readdir, readFile,
 * stat, access, platform, store ({get,set,delete} — KvStore in production).
 */
function createOpaqueFileRegistry(deps = {}) {
  const makeId = deps.randomUUID ?? randomUUID;
  const readdir = deps.readdir ?? fs.readdir;
  const readFile = deps.readFile ?? fs.readFile;
  const stat = deps.stat ?? fs.stat;
  const access = deps.access ?? fs.access;
  const platform = deps.platform ?? process.platform;
  const store = deps.store ?? createMemoryStore();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const refs = new Map();       // token → {kind, absolutePath, name}
  const tokenByPath = new Map(); // `${kind}\0${normalisedPath}` → token (bounded re-registration)

  const normalise = absolutePath => {
    const resolved = pathApi.resolve(absolutePath);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  function register(kind, absolutePath, name, prefix = 'ref') {
    const identity = `${kind}\0${normalise(absolutePath)}`;
    const existing = tokenByPath.get(identity);
    if (existing && refs.has(existing)) return existing;
    const ref = `${prefix}_${makeId()}`;
    refs.set(ref, { kind, absolutePath, name });
    tokenByPath.set(identity, ref);
    return ref;
  }

  function requireRef(ref, kind) {
    const entry = typeof ref === 'string' ? refs.get(ref) : undefined;
    if (!entry || (kind && entry.kind !== kind)) throw new Error(`Unknown ${kind ?? 'file or directory'} reference`);
    return entry;
  }

  /** Exists + right kind + readable — false on any failure (fail closed). */
  async function isUsable(kind, absolutePath) {
    try {
      const info = await stat(absolutePath);
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) return false;
      await access(absolutePath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Stored record for a stable key, re-validated now; null when missing/unusable. */
  async function storedRecord(key) {
    if (typeof key !== 'string' || !STABLE_KEY_RE.test(key)) return null;
    const rec = await store.get(key);
    if (!rec || typeof rec.absolutePath !== 'string' || (rec.kind !== 'directory' && rec.kind !== 'file')) return null;
    if ((rec.kind === 'directory') !== key.startsWith('dir_')) return null;
    return (await isUsable(rec.kind, rec.absolutePath)) ? rec : null;
  }

  /** Join a renderer-supplied relative path under root; throws if it escapes. */
  function containedPath(root, relPath) {
    const raw = String(relPath ?? '');
    if (!raw || pathApi.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) {
      throw new Error('Invalid relative path');
    }
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some(p => p === '.' || p === '..')) throw new Error('Invalid relative path');
    const target = pathApi.resolve(root, ...parts);
    const rootResolved = pathApi.resolve(root);
    const rel = pathApi.relative(rootResolved, target);
    if (!rel || rel.startsWith('..') || pathApi.isAbsolute(rel)) throw new Error('Invalid relative path');
    return target;
  }

  async function readPayload(absolutePath, name) {
    const bytes = await readFile(absolutePath);
    const copy = Uint8Array.from(bytes);
    return { name, bytes: copy.buffer };
  }

  return {
    registerMount(absolutePath, name = pathApi.basename(absolutePath)) {
      return { ref: register('directory', absolutePath, name, 'mount'), name };
    },

    /** Register one file the MAIN process chose (dialog / drop) → opaque token. */
    registerFile(absolutePath, name = pathApi.basename(absolutePath)) {
      return { ref: register('file', absolutePath, name, 'ref'), name };
    },

    async listDirectory(ref, parentPath = '') {
      const directory = requireRef(ref, 'directory');
      const children = await readdir(directory.absolutePath, { withFileTypes: true });
      return children
        .filter(child => child.isDirectory() || child.isFile())
        .map(child => {
          const kind = child.isDirectory() ? 'directory' : 'file';
          return {
            name: child.name,
            path: parentPath ? `${parentPath}/${child.name}` : child.name,
            kind,
            ref: register(kind, pathApi.join(directory.absolutePath, child.name), child.name),
          };
        })
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    },

    async readFile(ref) {
      const file = requireRef(ref, 'file');
      return readPayload(file.absolutePath, file.name);
    },

    /**
     * Session token → stable key persisted in the ref store. Same absolute
     * path ⇒ same key across restarts. Throws for unknown tokens.
     */
    async persistRef(ref) {
      const entry = requireRef(ref);
      const digest = createHash('sha256').update(normalise(entry.absolutePath)).digest('hex').slice(0, 32);
      const key = `${entry.kind === 'directory' ? 'dir' : 'file'}_${digest}`;
      await store.set(key, { kind: entry.kind, absolutePath: entry.absolutePath, name: entry.name });
      return key;
    },

    /** Stable key → fresh session token after re-validation, else null. */
    async restoreRef(key) {
      const rec = await storedRecord(key);
      if (!rec) return null;
      return register(rec.kind, rec.absolutePath, rec.name, rec.kind === 'directory' ? 'mount' : 'ref');
    },

    async deleteRef(key) {
      if (typeof key !== 'string' || !STABLE_KEY_RE.test(key)) return;
      await store.delete(key);
    },

    /**
     * Read through a stable key: folder keys need a relative path that stays
     * inside the folder; file keys take none. Null when the source is missing.
     */
    async readStoredFile(key, relPath = null) {
      const rec = await storedRecord(key);
      if (!rec) return null;
      if (rec.kind === 'file') {
        if (relPath) throw new Error('Invalid relative path');
        try { return await readPayload(rec.absolutePath, rec.name); } catch { return null; }
      }
      const target = containedPath(rec.absolutePath, relPath);
      if (!(await isUsable('file', target))) return null;
      try { return await readPayload(target, pathApi.basename(target)); } catch { return null; }
    },

    /**
     * Explicit, user-invoked hash walk of a persisted folder (never on load).
     * Symlinks are skipped (no escaping the folder, no cycles).
     * @returns {Promise<{path:string|null, name?:string, bytes?:ArrayBuffer, scanned:number}>}
     */
    async findMoved(args = {}, onProgress) {
      const { refKey, contentHash } = args;
      if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('Invalid content hash');
      const ext = typeof args.ext === 'string' ? args.ext.toLowerCase() : '';
      const limit = Math.min(Math.max(1, Number(args.limit) || DEFAULT_FIND_LIMIT), MAX_FIND_LIMIT);
      const rec = await storedRecord(refKey);
      if (!rec || rec.kind !== 'directory') return { path: null, scanned: 0 };
      let scanned = 0;
      const visit = async (absDir, relDir) => {
        let children;
        try { children = await readdir(absDir, { withFileTypes: true }); } catch { return null; }
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (scanned >= limit) return null;
          if (child.isSymbolicLink?.()) continue;
          const rel = relDir ? `${relDir}/${child.name}` : child.name;
          const abs = pathApi.join(absDir, child.name);
          if (child.isDirectory()) {
            const hit = await visit(abs, rel);
            if (hit) return hit;
            continue;
          }
          if (!child.isFile()) continue;
          if (ext && pathApi.extname(child.name).toLowerCase() !== ext) continue;
          scanned++;
          let bytes = null;
          try { bytes = await readFile(abs); } catch { bytes = null; }
          const hit = bytes && createHash('sha256').update(bytes).digest('hex') === contentHash;
          if (typeof onProgress === 'function') onProgress({ scanned });
          if (hit) return { path: rel, name: child.name, bytes: Uint8Array.from(bytes).buffer };
        }
        return null;
      };
      const hit = await visit(rec.absolutePath, '');
      return hit ? { ...hit, scanned } : { path: null, scanned };
    },
  };
}

module.exports = { createOpaqueFileRegistry, createMemoryStore };
