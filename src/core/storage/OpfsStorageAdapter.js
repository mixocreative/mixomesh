// OPFS StorageAdapter tier (overhaul task 8.2, Phase 8 "Responsive + touch").
//
// For WebKit (Safari, and EVERY iOS / iPadOS browser): no File System Access
// pickers, no getAsFileSystemHandle — but the Origin Private File System
// (`navigator.storage.getDirectory()`) and IndexedDB exist. Same adapter surface
// as BrowserStorageAdapter (ADR 0001); the differences:
//
// - Projects live in OPFS under `Projects/`. `pickSaveProject(name)` shows NO OS
//   dialog: it reserves `Projects/<name>.mixo` (" (2)", " (3)"… on collision)
//   after an optional in-app name prompt (`setSaveNamePrompt`). `listProjects()`
//   feeds an in-app chooser; `pickOpenProject({ref|name})` opens one of them, and
//   `pickOpenProject()` with no target falls back to `<input type=file
//   accept=.mixo>` and COPIES the picked file into OPFS (`importProjectFile`).
// - Imports: hidden `<input type=file multiple>`; refs are the picked `File`s
//   (read-only; `readFile(file)` returns it, `persistRef(file)` throws → callers
//   keep the bytes embedded, exactly like a ref-less drop).
// - Exports: Web Share sheet (`navigator.share({files})`) when the platform can
//   share files and is a touch Apple device (iOS "Save to Files" lives there),
//   else an anchor download. `hint.share` true/false forces either way.
// - No live links: `mountDirectory` throws, `resolveAsset` is always
//   `{status:'embedded', blob:null}` (the .mixo carries every byte), `findMoved`
//   never finds, `refForDrop` → null (drops hand over `File`s; caller reads bytes).
// - Refs (`persistRef`) are OPFS handles only; the key is derived from the OPFS
//   path (`dir_`/`file_` + 32 hex, stable across restarts) and the record
//   `{opfs:1, kind, path}` lives in the IndexedDB `handles` store. `restoreRef`
//   re-walks the path from the OPFS root (null when gone / unreadable).
// - `writeFile`: `createWritable()` (atomic swap file) when the engine has it;
//   older WebKit (no createWritable on the main thread) writes through a worker
//   with `createSyncAccessHandle` — truncate + write + flush, NOT atomic.
//
// Everything browser-global is touched at CALL time only (headless-safe import).

import { caps, setCapabilities, storageUnavailable } from './capabilities.js';
import { ASSET_STATUS, stableKeyFor } from './AssetSource.js';

/** Folder (inside the OPFS root) holding every project file. */
export const OPFS_PROJECTS_DIR = 'Projects';
const PROJECT_EXT = '.mixo';
const MAX_NAME_SUFFIX = 999;
const IDB_PROBE_MS = 5000;
const REVOKE_DELAY_MS = 60_000;   // iOS reads the object URL after click() returns

async function _idb() { return import('../idb.js'); }

const _nav = () => globalThis.navigator;

async function _root() {
  const getDirectory = _nav()?.storage?.getDirectory;
  if (typeof getDirectory !== 'function') throw new Error('Origin Private File System is unavailable');
  return getDirectory.call(_nav().storage);
}

async function _projectsDir() {
  return (await _root()).getDirectoryHandle(OPFS_PROJECTS_DIR, { create: true });
}

const _isHandle = ref => !!ref && (ref.kind === 'file' || ref.kind === 'directory')
  && typeof ref.name === 'string' && !(typeof Blob !== 'undefined' && ref instanceof Blob);

/** OPFS path segments of a handle, or null when it is not inside this origin's OPFS. */
async function _pathOf(handle) {
  const root = await _root();
  if (await _sameEntry(root, handle)) return [];
  try { return (await root.resolve(handle)) ?? null; }
  catch { return null; }
}

async function _sameEntry(a, b) {
  if (a === b) return true;
  try { return typeof a?.isSameEntry === 'function' && await a.isSameEntry(b); }
  catch { return false; }
}

/** Walk `path` from the OPFS root; null when any segment is missing / unreadable / wrong kind. */
async function _walk(path, kind) {
  try {
    let dir = await _root();
    if (!path.length) return kind === 'directory' ? dir : null;
    for (const seg of path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    const last = path[path.length - 1];
    return kind === 'directory' ? await dir.getDirectoryHandle(last) : await dir.getFileHandle(last);
  } catch { return null; }
}

async function _exists(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch {
    try { await dir.getDirectoryHandle(name); return true; } catch { return false; }
  }
}

/**
 * In-app project name → safe OPFS file name ending `.mixo`. Strips folder
 * separators / reserved + control characters; empty → `Untitled.mixo`.
 * @param {string} name
 */
export function sanitizeProjectName(name) {
  let base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  if (base.toLowerCase().endsWith(PROJECT_EXT)) base = base.slice(0, -PROJECT_EXT.length);
  base = base.replace(/[. ]+$/, '').trim();
  if (!base || /^\.+$/.test(base)) base = 'Untitled';
  return `${base.slice(0, 120)}${PROJECT_EXT}`;
}

/** `name.mixo` → first free of `name.mixo`, `name (2).mixo`, `name (3).mixo`… in `dir`. */
export async function uniqueProjectName(dir, name) {
  const safe = sanitizeProjectName(name);
  if (!await _exists(dir, safe)) return safe;
  const stem = safe.slice(0, -PROJECT_EXT.length).replace(/ \(\d+\)$/, '');
  for (let i = 2; i <= MAX_NAME_SUFFIX; i++) {
    const candidate = `${stem} (${i})${PROJECT_EXT}`;
    if (!await _exists(dir, candidate)) return candidate;
  }
  throw new Error('Too many projects share this name');
}

/** string | Blob | ArrayBuffer | view → Uint8Array. */
async function _bytesOf(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('writeFile expects text, a Blob or bytes');
}

/** Older WebKit: no main-thread createWritable → sync access handle in a worker. */
async function _writeViaWorker(path, data) {
  const bytes = await _bytesOf(data);
  const copy = bytes.slice();   // own buffer → transferable without detaching the caller's
  const worker = new Worker(new URL('../workers/OpfsWrite.worker.js', import.meta.url), { type: 'module' });
  try {
    await new Promise((resolve, reject) => {
      worker.onmessage = e => (e.data?.ok ? resolve(undefined) : reject(new Error(e.data?.error || 'OPFS write failed')));
      worker.onerror = e => reject(new Error(e?.message || 'OPFS write worker failed'));
      worker.postMessage({ path, bytes: copy }, [copy.buffer]);
    });
  } finally { worker.terminate(); }
}

/**
 * Hidden `<input type=file>` → picked Files ([] when the user cancels — the
 * `cancel` event). Must run inside the user gesture that asked for it.
 * @param {{accept?:string, multiple?:boolean}} opts
 * @returns {Promise<File[]>}
 */
function _pickFiles({ accept = '', multiple = false } = {}) {
  const doc = globalThis.document;
  if (!doc?.createElement) return Promise.resolve([]);
  return new Promise(resolve => {
    const input = doc.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = 'none';
    let settled = false;
    const done = files => {
      if (settled) return;
      settled = true;
      input.remove?.();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    doc.body?.appendChild(input);   // WebKit only opens pickers for connected inputs
    input.click();
  });
}

function _anchorDownload(blob, name) {
  const doc = globalThis.document;
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove?.();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** iPhone / iPad (incl. iPadOS's desktop-class "MacIntel" UA with touch). */
export function isTouchApple(nav = _nav()) {
  if (!nav) return false;
  const ua = String(nav.userAgent ?? '');
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return String(nav.platform ?? '') === 'MacIntel' && Number(nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Share sheet vs download for an export (`hint.share` overrides; default =
 * share only on touch Apple devices whose `canShare({files})` accepts it).
 * @param {File} file
 * @param {{share?:boolean}} [hint]
 * @returns {boolean}
 */
export function shouldShare(file, hint = {}) {
  if (hint.share === false) return false;
  const nav = _nav();
  if (typeof nav?.share !== 'function' || typeof nav?.canShare !== 'function') return false;
  let ok = false;
  try { ok = !!nav.canShare({ files: [file] }); } catch { ok = false; }
  if (!ok) return false;
  return hint.share === true || isTouchApple(nav);
}

function _asFile(blob, name) {
  if (typeof File !== 'undefined' && blob instanceof File && blob.name === name) return blob;
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

/** @type {null | ((suggestedName:string) => Promise<string|{name:string, overwrite?:boolean}|null>|string|{name:string, overwrite?:boolean}|null)} */
let _saveNamePrompt = null;

/**
 * OPFS adapter. `ref` = an OPFS FileSystemHandle (projects, listed folders) or
 * a picked `File` (imports, read-only).
 * @type {import('./StorageAdapter.js').StorageAdapter & {
 *   listProjects: () => Promise<Array<{name:string, ref:any, size:number, lastModified:number}>>,
 *   importProjectFile: (file:File|Blob, name?:string) => Promise<{ref:any, name:string, file:File}>,
 *   deleteProject: (refOrName:any) => Promise<boolean>,
 *   setSaveNamePrompt: (fn:typeof _saveNamePrompt) => void,
 * }}
 */
export const OpfsStorageAdapter = {
  kind: 'opfs',
  caps,
  async kvSet(key, value) { return (await _idb()).kvSet(key, value); },
  async kvGet(key) { return (await _idb()).kvGet(key); },
  async kvDelete(key) { return (await _idb()).kvDelete(key); },
  async kvKeys() { return (await _idb()).kvKeys(); },

  async mountDirectory() { throw new Error('Directory mounting is unavailable'); },

  async listDirectory(ref, parentPath = '') {
    const entries = [];
    for await (const [name, childRef] of ref.entries()) {
      if (childRef.kind !== 'directory' && childRef.kind !== 'file') continue;
      entries.push({ name, path: parentPath ? `${parentPath}/${name}` : name, kind: childRef.kind, ref: childRef });
    }
    return entries.sort((a, b) => (
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1
    ));
  },

  async readFile(ref) {
    if (typeof Blob !== 'undefined' && ref instanceof Blob) return ref;   // picked File
    return ref.getFile();
  },

  // No live links in this tier: the project's embedded copy is the only source.
  async resolveAsset() { return { status: ASSET_STATUS.EMBEDDED, blob: null }; },
  async findMoved() { return { source: null, blob: null, scanned: 0 }; },

  async persistRef(ref) {
    if (!_isHandle(ref)) throw new TypeError('persistRef: expected an OPFS file or directory handle');
    const path = await _pathOf(ref);
    if (!path) throw new TypeError('persistRef: handle is not inside the origin private file system');
    const key = await stableKeyFor(ref.kind === 'directory' ? 'dir' : 'file', ['opfs', ...path]);
    await (await _idb()).putHandle(key, { opfs: 1, kind: ref.kind, path });
    return key;
  },

  async restoreRef(key) {
    if (typeof key !== 'string' || !key) return null;
    const rec = await (await _idb()).getHandle(key);
    if (!rec || rec.opfs !== 1 || !Array.isArray(rec.path)) return null;
    return _walk(rec.path, rec.kind);
  },

  async deleteRef(key) { return (await _idb()).deleteHandle(key); },

  async hasRef(key) {
    if (typeof key !== 'string' || !key) return false;
    const rec = await (await _idb()).getHandle(key);
    return !!rec && rec.opfs === 1;
  },

  /**
   * Boot gate for this tier: OPFS must open (it does not in some private
   * modes) and hold the Projects folder. IndexedDB failing is NOT blocking
   * (same as the browser tier: recents/autosave degrade, persistAssets=false).
   * Also asks for persistent storage — OPFS is the ONLY copy of a project here,
   * and WebKit otherwise evicts origin storage after weeks without a visit.
   */
  async ready() {
    if (typeof _nav()?.storage?.getDirectory !== 'function') {
      throw storageUnavailable('Browser not supported',
        'This browser has neither File System Access nor the Origin Private File System.');
    }
    try { await _projectsDir(); }
    catch (err) {
      throw storageUnavailable('Storage unavailable',
        'MIXOMESH could not open this browser\'s private file storage (Private Browsing may block it).', err);
    }
    try {
      const p = _nav().storage.persist?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* best effort */ }
    if (!caps.persistAssets) return;
    let timer;
    try {
      await Promise.race([
        OpfsStorageAdapter.kvKeys(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IndexedDB did not open')), IDB_PROBE_MS); }),
      ]);
    } catch (err) {
      console.error('Browser storage (IndexedDB) unavailable — recents/autosave disabled:', err);
      setCapabilities({ persistAssets: false });
    } finally { clearTimeout(timer); }
  },

  /** Saved projects, newest first (empty reservations from an unfinished save are hidden). */
  async listProjects() {
    const dir = await _projectsDir();
    const out = [];
    for await (const [name, ref] of dir.entries()) {
      if (ref.kind !== 'file' || !name.toLowerCase().endsWith(PROJECT_EXT)) continue;
      const file = await ref.getFile();
      if (!file.size) continue;
      out.push({ name, ref, size: file.size, lastModified: file.lastModified ?? 0 });
    }
    return out.sort((a, b) => (b.lastModified - a.lastModified) || a.name.localeCompare(b.name));
  },

  /** Copy an outside `.mixo` (Files app pick / drop) into Projects/ under a free name. */
  async importProjectFile(file, name) {
    const dir = await _projectsDir();
    const finalName = await uniqueProjectName(dir, name ?? file?.name ?? 'Untitled');
    const ref = await dir.getFileHandle(finalName, { create: true });
    try { await OpfsStorageAdapter.writeFile(ref, file); }
    catch (err) {
      try { await dir.removeEntry(finalName); } catch { /* leave the empty reservation */ }
      throw err;
    }
    return { ref, name: finalName, file: await ref.getFile() };
  },

  async deleteProject(refOrName) {
    const name = typeof refOrName === 'string' ? sanitizeProjectName(refOrName) : refOrName?.name;
    if (!name) return false;
    const dir = await _projectsDir();
    try { await dir.removeEntry(name); return true; } catch { return false; }
  },

  /**
   * In-app name step for "Save As" (the UI's rename sheet). The hook gets the
   * suggested name and answers a name (collision → " (n)" suffix), `{name,
   * overwrite:true}` (replace that project), or null (cancel). No hook → the
   * suggested name is used as-is.
   */
  setSaveNamePrompt(fn) { _saveNamePrompt = typeof fn === 'function' ? fn : null; },

  /**
   * Project open. `{ref}` / `{name}` → that OPFS project (the in-app chooser
   * fed by `listProjects`); no target → `<input type=file accept=.mixo>` and
   * the picked file is imported (copied) into OPFS first.
   * @param {{ref?:any, name?:string}} [target]
   */
  async pickOpenProject(target) {
    if (target?.ref || target?.name) {
      let ref = target.ref;
      if (!ref) {
        try { ref = await (await _projectsDir()).getFileHandle(sanitizeProjectName(target.name)); }
        catch { return null; }
      }
      return { ref, name: ref.name, file: await ref.getFile() };
    }
    const [file] = await _pickFiles({ accept: `${PROJECT_EXT},application/json`, multiple: false });
    if (!file) return null;
    return OpfsStorageAdapter.importProjectFile(file, file.name);
  },

  async pickSaveProject(suggestedName) {
    let answer = suggestedName;
    if (_saveNamePrompt) answer = await _saveNamePrompt(suggestedName);
    if (answer == null) return null;
    const { name, overwrite } = typeof answer === 'object' ? answer : { name: answer, overwrite: false };
    if (!String(name ?? '').trim()) return null;
    const dir = await _projectsDir();
    const finalName = overwrite ? sanitizeProjectName(name) : await uniqueProjectName(dir, name);
    // Reserve the name now (an empty file listProjects hides) so two saves
    // can never pick the same free name.
    const ref = await dir.getFileHandle(finalName, { create: true });
    return { ref, name: finalName };
  },

  async writeFile(ref, data) {
    if (!_isHandle(ref) || ref.kind !== 'file') throw new TypeError('writeFile: expected an OPFS file handle (picked files are read-only)');
    if (typeof ref.createWritable === 'function') {
      const w = await ref.createWritable();
      try {
        await w.write(data);
        await w.close();
      } catch (err) {
        try { await w.abort?.(); } catch { /* already closed / aborted */ }
        throw err;
      }
      return;
    }
    const path = await _pathOf(ref);
    if (!path) throw new TypeError('writeFile: handle is not inside the origin private file system');
    await _writeViaWorker(path, data);
  },

  async pickImportAssets(opts = {}) {
    const files = await _pickFiles({ multiple: opts.multiple !== false });
    return files.map(file => ({ ref: file, name: file.name }));
  },

  /**
   * Share sheet (touch Apple) or anchor download. Share dismissed → false
   * (cancel). Share refused (e.g. user activation expired during a long
   * export) → falls back to the download.
   * @param {Blob} blob @param {string} suggestedName @param {{share?:boolean, forceDownload?:boolean}} [hint]
   */
  async saveExport(blob, suggestedName, hint = {}) {
    if (!hint.forceDownload) {
      const file = _asFile(blob, suggestedName);
      if (shouldShare(file, hint)) {
        try {
          await _nav().share({ files: [file], title: suggestedName });
          return true;
        } catch (err) {
          if (err?.name === 'AbortError') return false;
          console.warn('Share sheet unavailable, downloading instead:', err);
        }
      }
    }
    _anchorDownload(blob, suggestedName);
    return true;
  },

  // Not async (same contract as the other tiers). WebKit has no
  // getAsFileSystemHandle: drops carry Files only; the caller reads the bytes.
  refForDrop() { return Promise.resolve(null); },
  // Launch integration (LI.4): desktop-only; no-op here.
  pullLaunchRequests() { return Promise.resolve(null); },
  onLaunchRequests() { return () => {}; },
  // Automation API (API.6): desktop-only; no-op here.
  onApiRequest() { return () => {}; },
  respondApi() { return Promise.resolve(); },
  notifyApi() { return Promise.resolve(); },
  getApiStatus() { return Promise.resolve({ enabled: false, running: false }); },
  setApiEnabled() { return Promise.resolve({ enabled: false, running: false }); },
};
