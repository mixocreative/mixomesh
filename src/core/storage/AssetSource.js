// Runtime-neutral helpers shared by BOTH StorageAdapter impls (overhaul task 4.2,
// plan §4.4): the asset `source` descriptor, the four plain status words, the
// relative-path guard, stable-key derivation and the explicit hash walk used by
// the browser `findMoved`. No FSA / IndexedDB / IPC here — impls pass in how to
// read; this module only decides what the bytes MEAN.
//
// source = { kind:'folder'|'file', refKey:string, path?:string, label?:string }
//   folder: refKey = persisted folder key, path = '/'-separated path INSIDE it
//   file:   refKey = persisted single-file key (path/label are display only)

import { sha256Hex } from '../hash.js';

/** Plain status words (plan §4.4): Embedded copy / Linked / Changed on disk / Missing. */
export const ASSET_STATUS = Object.freeze({
  EMBEDDED: 'embedded',
  LINKED: 'linked',
  CHANGED: 'changed',
  MISSING: 'missing',
});

/** Hard cap for an explicit Find-moved-file walk (files hashed). */
export const FIND_MOVED_LIMIT = 4000;

const STABLE_KEY_RE = /^(dir|file)_[0-9a-f]{32}(_\d{1,3})?$/;

/** True for keys minted by `persistRef` on either runtime. */
export function isStableKey(key) {
  return typeof key === 'string' && STABLE_KEY_RE.test(key);
}

/**
 * `<prefix>_<first 32 hex of sha256(parts joined by NUL)>` — deterministic, so the
 * same folder/file yields the same key after a restart (Decision 10).
 * @param {'dir'|'file'} prefix
 * @param {Array<string|number>} parts
 */
export async function stableKeyFor(prefix, parts) {
  const bytes = new TextEncoder().encode(parts.map(String).join('\0'));
  return `${prefix}_${(await sha256Hex(bytes)).slice(0, 32)}`;
}

/**
 * Split a path inside a mounted folder into safe segments. Rejects absolute
 * paths, drive letters, `.`/`..` and empty input — a source can never walk out
 * of the folder it names.
 * @param {string} relPath
 * @returns {string[]}
 */
export function safeSegments(relPath) {
  const raw = String(relPath ?? '');
  if (!raw || /^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('Invalid relative path');
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some(p => p === '.' || p === '..' || p.includes('\0'))) {
    throw new Error('Invalid relative path');
  }
  return parts;
}

/** Lower-cased `.ext` of a name/path, '' when none. */
export function extOfName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** Validate + normalise a source descriptor; null for anything unusable. */
export function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.kind !== 'folder' && source.kind !== 'file') return null;
  if (typeof source.refKey !== 'string' || !source.refKey) return null;
  if (source.kind === 'folder') {
    try { safeSegments(source.path); } catch { return null; }
  }
  return {
    kind: source.kind,
    refKey: source.refKey,
    path: String(source.path ?? ''),
    label: String(source.label ?? source.path ?? ''),
  };
}

/** Walk a handle-shaped directory along a relative path to a file handle. */
export async function fileHandleAtPath(dirHandle, relPath) {
  const parts = safeSegments(relPath);
  let dir = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function _bufferOf(blob) {
  if (blob instanceof ArrayBuffer) return blob;
  return blob.arrayBuffer();
}

/**
 * Shared status classification: `readSource(source)` returns the on-disk
 * Blob/File or null (unreachable). Never scans (Decision 3).
 * @returns {Promise<{status:'embedded'|'linked'|'changed'|'missing', blob:Blob|null}>}
 */
export async function resolveVia(readSource, source, { contentHash } = {}) {
  if (source == null) return { status: ASSET_STATUS.EMBEDDED, blob: null };
  const src = normalizeSource(source);
  if (!src) return { status: ASSET_STATUS.MISSING, blob: null };   // malformed / escaping link
  let blob = null;
  try { blob = await readSource(src); } catch { blob = null; }
  if (!blob) return { status: ASSET_STATUS.MISSING, blob: null };
  if (contentHash) {
    const actual = await sha256Hex(await _bufferOf(blob));
    if (actual !== contentHash) return { status: ASSET_STATUS.CHANGED, blob };
  }
  return { status: ASSET_STATUS.LINKED, blob };
}

/**
 * Explicit hash walk over adapter `listDirectory` / `readFile` (browser
 * `findMoved`). Depth-first, extension-filtered, capped at `limit` hashed files;
 * `onProgress({scanned})` after every hashed file.
 * @returns {Promise<{path:string|null, blob:Blob|null, scanned:number}>}
 */
export async function walkForHash(adapter, rootRef, { contentHash, ext = '', limit = FIND_MOVED_LIMIT, onProgress } = {}) {
  const state = { scanned: 0 };
  const visit = async (ref, parentPath) => {
    for (const row of await adapter.listDirectory(ref, parentPath)) {
      if (state.scanned >= limit) return null;
      if (row.kind === 'directory') {
        const hit = await visit(row.ref, row.path);
        if (hit) return hit;
        continue;
      }
      if (ext && extOfName(row.name) !== ext) continue;
      state.scanned++;
      let blob = null;
      try { blob = await adapter.readFile(row.ref); } catch { blob = null; }
      const hit = blob && (await sha256Hex(await _bufferOf(blob))) === contentHash;
      if (typeof onProgress === 'function') onProgress({ scanned: state.scanned });
      if (hit) return { path: row.path, blob };
    }
    return null;
  };
  const hit = contentHash ? await visit(rootRef, '') : null;
  return { path: hit?.path ?? null, blob: hit?.blob ?? null, scanned: state.scanned };
}
