const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;

// Stable keys minted by persistRef: `dir_` / `file_` + 32 hex of sha256(path).
const STABLE_KEY_RE = /^(dir|file)_[0-9a-f]{32}$/;
const DEFAULT_FIND_LIMIT = 4000;
const MAX_FIND_LIMIT = 20000;
// Upper bound for one renderer-initiated write (project save / export) — task 4.4.
const MAX_WRITE_BYTES = 1024 * 1024 * 1024;
// One chunk of a streamed export save (renderer slices big Blobs to this).
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

// ── Dialog descriptors (task 6.2) ──
// The renderer describes a save dialog with `{suggestedName, ext?, description?}`
// ONLY; main sanitises every field before it reaches the native dialog.
/** Extensions an export save dialog may offer (PrintPackaging + Scene renders). */
const EXPORT_EXTENSIONS = Object.freeze(['3mf', 'obj', 'stl', 'ply', 'wrl', 'zip', 'png', 'mp4', 'webm']);
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 80;
// Windows reserved device names (with or without an extension).
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const RESERVED_CHARS_RE = /[<>:"|?*]/g;

/**
 * Renderer-suggested file name → a bare, Windows-safe file name. Directory
 * parts (either separator), drive prefixes, control and reserved characters
 * are dropped; leading/trailing dots and spaces trimmed; device names and
 * empty results fall back. The result can never steer the dialog to a folder.
 */
function sanitizeSuggestedName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    .replace(/^[a-zA-Z]:/, '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(RESERVED_CHARS_RE, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!cleaned || RESERVED_NAME_RE.test(cleaned)) return fallback;
  return cleaned;
}

/** `name` ending in `.ext` (case-insensitive); appended when missing. */
function withExtension(name, ext) {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/**
 * Export save-dialog descriptor → `{ext, defaultName, filters}`. The extension
 * must be on EXPORT_EXTENSIONS (anything else throws — main never offers an
 * arbitrary file type); the description is plain text, capped.
 */
function exportDialogOptions(opts) {
  const ext = typeof opts?.ext === 'string' ? opts.ext.trim().replace(/^\./, '').toLowerCase() : '';
  if (!EXPORT_EXTENSIONS.includes(ext)) throw new Error(`Export type ".${ext}" is not allowed`);
  const rawDesc = typeof opts?.description === 'string' ? opts.description : '';
  const description = rawDesc.replace(CONTROL_CHARS_RE, '').trim().slice(0, MAX_DESCRIPTION_CHARS)
    || `${ext.toUpperCase()} file`;
  return {
    ext,
    defaultName: withExtension(sanitizeSuggestedName(opts?.suggestedName, 'export'), ext),
    filters: [{ name: description, extensions: [ext] }],
  };
}

/** text | ArrayBuffer | view → Buffer, or null for anything else. */
function toWriteBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

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
 * writeFile, rename, unlink, stat, access, platform, store ({get,set,delete} —
 * KvStore in production), maxWriteBytes.
 *
 * WRITABLE tokens (task 4.4 / 6.2): only files the MAIN process registered with
 * `{writable:true}` — the project open/save dialogs, or a restored key that was
 * persisted from such a token — accept `writeFile`. Writability is part of a
 * token's identity: choosing a path in a project dialog mints a SEPARATE
 * writable token and never upgrades a read-only token the renderer already
 * holds for that path (import / mount listing / drop stay read-only). Export
 * saves mint no token at all (`writeDialogTarget`, main-only).
 */
function createOpaqueFileRegistry(deps = {}) {
  const makeId = deps.randomUUID ?? randomUUID;
  const readdir = deps.readdir ?? fs.readdir;
  const readFile = deps.readFile ?? fs.readFile;
  const writeFileFs = deps.writeFile ?? fs.writeFile;
  const rename = deps.rename ?? fs.rename;
  const unlink = deps.unlink ?? fs.unlink;
  const stat = deps.stat ?? fs.stat;
  const access = deps.access ?? fs.access;
  const platform = deps.platform ?? process.platform;
  const store = deps.store ?? createMemoryStore();
  const maxWriteBytes = deps.maxWriteBytes ?? MAX_WRITE_BYTES;
  const maxChunkBytes = deps.maxChunkBytes ?? MAX_CHUNK_BYTES;
  const openFs = deps.open ?? fs.open;
  // Streamed export saves: opaque session id → { owner, target, tmp, handle, bytes }.
  const saves = new Map();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const refs = new Map();       // token → {kind, absolutePath, name, writable}
  const tokenByPath = new Map(); // `${kind}\0${normalisedPath}` → token (bounded re-registration)

  const normalise = absolutePath => {
    const resolved = pathApi.resolve(absolutePath);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  function register(kind, absolutePath, name, prefix = 'ref', writable = false) {
    // Writability is part of the identity: a read-only token is never upgraded.
    const identity = `${kind}\0${writable ? 'w' : 'r'}\0${normalise(absolutePath)}`;
    const existing = tokenByPath.get(identity);
    if (existing && refs.has(existing)) return existing;
    const ref = `${prefix}_${makeId()}`;
    refs.set(ref, { kind, absolutePath, name, writable: !!writable });
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

  /** Atomic temp-file + rename write, size-capped. Main-only callers. */
  async function writeAtomic(absolutePath, data) {
    const bytes = toWriteBuffer(data);
    if (!bytes) throw new TypeError('writeFile expects text or bytes');
    if (bytes.byteLength > maxWriteBytes) throw new Error('File is too large to write');
    const tmp = `${absolutePath}.${makeId()}.tmp`;
    try {
      await writeFileFs(tmp, bytes);
      await rename(tmp, absolutePath);
    } catch (err) {
      try { await unlink(tmp); } catch { /* temp never created / already moved */ }
      throw err;
    }
    return true;
  }

  /** Run `fn` after the session's previous call; a session that already
   *  ended (commit/abort/oversize) rejects every later call. */
  function enqueue(id, save, fn) {
    const run = save.queue.then(() => {
      if (saves.get(id) !== save) throw new Error('Unknown save session');
      return fn();
    });
    save.queue = run.catch(() => {});
    return run;
  }

  function requireSave(id, owner) {
    const save = saves.get(id);
    if (!save || save.owner !== owner) throw new Error('Unknown save session');
    return save;
  }

  /** Close the temp file, then rename it into place (commit) or delete it. */
  async function endSave(id, save, commit) {
    saves.delete(id);
    try { await save.handle.close(); } catch { /* already closed */ }
    if (commit) {
      try {
        await rename(save.tmp, save.target);
      } catch (err) {
        try { await unlink(save.tmp); } catch { /* gone */ }
        throw err;
      }
      return true;
    }
    try { await unlink(save.tmp); } catch { /* never created / already gone */ }
    return true;
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

    /**
     * Register one file the MAIN process chose (dialog / drop) → opaque token.
     * `writable` only for project open/save dialogs (task 4.4).
     */
    registerFile(absolutePath, name = pathApi.basename(absolutePath), opts = {}) {
      return { ref: register('file', absolutePath, name, 'ref', !!opts.writable), name };
    },

    /**
     * Atomically replace a WRITABLE file token's bytes: temp file in the same
     * folder, then rename over the target (a crash never leaves a half file).
     * Unknown / read-only tokens and oversize payloads are refused.
     */
    async writeFile(ref, data) {
      const file = requireRef(ref, 'file');
      if (!file.writable) throw new Error('This file is read-only to the app');
      return writeAtomic(file.absolutePath, data);
    },

    /**
     * MAIN-ONLY (never wired to an IPC channel that takes a path): write the
     * file the user just chose in an export save dialog. No token is minted,
     * so the renderer gains no write access to that path.
     */
    async writeDialogTarget(absolutePath, data) {
      if (typeof absolutePath !== 'string' || !pathApi.isAbsolute(absolutePath)) throw new Error('Invalid save target');
      return writeAtomic(absolutePath, data);
    },

    /**
     * MAIN-ONLY start of a streamed export save to a path the user just chose
     * in the dialog. Writes go to a temp file beside it; commitWrite renames
     * it over the target, abortWrite deletes it. The renderer only ever sees
     * the opaque session id, and only `owner` (the sender's webContents id)
     * may append / commit / abort.
     */
    async beginDialogWrite(absolutePath, owner) {
      if (typeof absolutePath !== 'string' || !pathApi.isAbsolute(absolutePath)) throw new Error('Invalid save target');
      const tmp = `${absolutePath}.${makeId()}.tmp`;
      const handle = await openFs(tmp, 'w');
      const id = `save_${makeId()}`;
      saves.set(id, { owner, target: absolutePath, tmp, handle, bytes: 0, queue: Promise.resolve() });
      return id;
    },

    /** Append one chunk. Calls on a session run strictly in order (a commit
     *  sent while a write is in flight waits for it; the size cap counts
     *  every queued write). */
    appendWrite(id, data, owner) {
      let save;
      try { save = requireSave(id, owner); } catch (err) { return Promise.reject(err); }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes) return Promise.reject(new TypeError('appendWrite expects bytes'));
      if (bytes.byteLength > maxChunkBytes) return Promise.reject(new Error('Save chunk is too large'));
      return enqueue(id, save, async () => {
        if (save.bytes + bytes.byteLength > maxWriteBytes) {
          await endSave(id, save, false);
          throw new Error('File is too large to write');
        }
        try {
          await save.handle.write(bytes);
        } catch (err) {
          await endSave(id, save, false);
          throw err;
        }
        save.bytes += bytes.byteLength;
        return true;
      });
    },

    commitWrite(id, owner) {
      let save;
      try { save = requireSave(id, owner); } catch (err) { return Promise.reject(err); }
      return enqueue(id, save, () => endSave(id, save, true));
    },

    async abortWrite(id, owner) {
      const save = saves.get(id);
      if (!save || save.owner !== owner) return false;
      await enqueue(id, save, () => endSave(id, save, false)).catch(() => {});
      return true;
    },

    /** A window closed or its renderer died: abort every save it left open.
     *  Returns how many were aborted. */
    async abortAllFor(owner) {
      const ids = [...saves].filter(([, save]) => save.owner === owner).map(([id]) => id);
      await Promise.all(ids.map(id => this.abortWrite(id, owner)));
      return ids.length;
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
      // Persisting a read-only token for the same file keeps an earlier
      // project-dialog grant (recents must reopen writable); it never adds one.
      const prev = await store.get(key);
      const writable = entry.writable || (prev?.writable === true && prev.kind === entry.kind
        && typeof prev.absolutePath === 'string' && normalise(prev.absolutePath) === normalise(entry.absolutePath));
      await store.set(key, {
        kind: entry.kind, absolutePath: entry.absolutePath, name: entry.name,
        ...(writable ? { writable: true } : {}),
      });
      return key;
    },

    /** Stable key → fresh session token after re-validation, else null. */
    async restoreRef(key) {
      const rec = await storedRecord(key);
      if (!rec) return null;
      return register(rec.kind, rec.absolutePath, rec.name, rec.kind === 'directory' ? 'mount' : 'ref',
        rec.kind === 'file' && rec.writable === true);
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

module.exports = {
  createOpaqueFileRegistry,
  createMemoryStore,
  MAX_WRITE_BYTES,
  EXPORT_EXTENSIONS,
  sanitizeSuggestedName,
  exportDialogOptions,
  withExtension,
};
