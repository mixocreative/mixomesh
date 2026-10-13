// StorageAdapter — the single seam for filesystem / persistence / asset resolution
// (ADR 0001). Domain-level interface with OPAQUE refs (browser wraps a
// FileSystemHandle, desktop wraps a main-process registry token; callers never inspect a ref, and refs
// never cross runtimes). What crosses (and lives in `.mixo`) is a serialisable
// DESCRIPTOR `{path?, contentHash, handleKey?}`; `resolveAsset(descriptor)` turns
// it back into bytes via whatever tiers the runtime supports.
//
// Boot picks the impl by runtime; app code branches on `storage.caps.*` FLAGS,
// never on ad-hoc "is Electron" checks. The desktop impl (Node fs via Electron IPC)
// is injected in Phase 2 — until then the browser impl is the only one.
//
// Directory mounting/listing/reading, cross-session KV and the asset-ref surface
// (task 4.2: resolveAsset / persistRef / restoreRef / deleteRef / findMoved) are
// implemented on both impls. Project pickers migrate in 4.4 (see ADR 0001).
//
// Asset refs: `persistRef(ref)` returns a STABLE key (same folder/file → same key
// after a restart); `restoreRef(key)` re-validates and returns a fresh session ref
// or null. `resolveAsset(source, {contentHash})` reads ONE source and classifies it
// ('embedded' | 'linked' | 'changed' | 'missing') — it never scans (Decision 3).
// `findMoved` is the only hash walk and is user-invoked only.

import { caps, isDesktop } from './capabilities.js';
import { DesktopStorageAdapter } from './DesktopStorageAdapter.js';
import {
  ASSET_STATUS, FIND_MOVED_LIMIT, extOfName, fileHandleAtPath, normalizeSource,
  resolveVia, stableKeyFor, walkForHash,
} from './AssetSource.js';

/** @typedef {import('./capabilities.js').Capabilities} Capabilities */

/**
 * @typedef {Object} StorageAdapter
 * @property {'browser'|'desktop'} kind
 * @property {Capabilities} caps
 * Cross-session key/value (autosave / recent / settings):
 * @property {(key:string, value:any)=>Promise<void>} kvSet
 * @property {(key:string)=>Promise<any>} kvGet
 * @property {(key:string)=>Promise<void>} kvDelete
 * @property {()=>Promise<string[]>} kvKeys
 * @property {()=>Promise<{ref:any,name:string}>} mountDirectory
 * @property {(ref:any, parentPath?:string)=>Promise<Array<{name:string,path:string,kind:'file'|'directory',ref:any}>>} listDirectory
 * @property {(ref:any)=>Promise<File|Blob|any>} readFile
 * Asset refs (task 4.2, plan §4.4):
 * @property {(source:AssetSource|null, opts?:{contentHash?:string})=>Promise<AssetResolution>} resolveAsset
 * @property {(ref:any)=>Promise<string>} persistRef        ref → stable key (persisted)
 * @property {(key:string)=>Promise<any|null>} restoreRef    key → re-validated session ref | null
 * @property {(key:string)=>Promise<void>} deleteRef
 * @property {(source:AssetSource, opts:FindMovedOptions)=>Promise<FindMovedResult>} findMoved
 * — Declared, routed as LEAF sites migrate (task 4.4): —
 * pickOpenProject / pickSaveProject / readProject / writeProject
 * pickImportAssets / readAsset / watchAsset / saveExport / recentProjects
 */

/**
 * @typedef {{kind:'folder'|'file', refKey:string, path?:string, label?:string}} AssetSource
 * @typedef {{status:'embedded'|'linked'|'changed'|'missing', blob:Blob|null}} AssetResolution
 * @typedef {{contentHash:string, onProgress?:(p:{scanned:number})=>void, limit?:number, refKey?:string}} FindMovedOptions
 *   `refKey` = search this persisted folder instead of the source's own folder.
 * @typedef {{source:AssetSource|null, blob:Blob|null, scanned:number}} FindMovedResult
 */

const MAX_KEY_SUFFIX = 50;

async function _idb() { return import('../idb.js'); }

async function _sameEntry(a, b) {
  if (a === b) return true;
  try { return typeof a?.isSameEntry === 'function' && await a.isSameEntry(b); }
  catch { return false; }
}

/** Decision 10: folder key = sha256(name + first entry name); file key = sha256(name+size+mtime). */
async function _browserBaseKey(ref) {
  if (ref.kind === 'directory') {
    const names = [];
    for await (const [name] of ref.entries()) names.push(name);
    names.sort();
    return stableKeyFor('dir', [ref.name, names[0] ?? '']);
  }
  const file = await ref.getFile();
  return stableKeyFor('file', [ref.name, file?.size ?? 0, file?.lastModified ?? 0]);
}

async function _browserRestore(key) {
  if (typeof key !== 'string' || !key) return null;
  const handle = await (await _idb()).getHandle(key);
  if (!handle) return null;
  const perm = typeof handle.requestPermission === 'function'
    ? await handle.requestPermission({ mode: 'read' })
    : 'granted';
  return perm === 'granted' ? handle : null;
}

async function _browserReadSource(src) {
  const ref = await _browserRestore(src.refKey);
  if (!ref) return null;
  if (src.kind === 'folder') {
    if (ref.kind !== 'directory') return null;
    return (await fileHandleAtPath(ref, src.path)).getFile();
  }
  return ref.kind === 'file' ? ref.getFile() : null;
}

/**
 * Browser adapter — File System Access + IndexedDB (current behaviour). `ref` = FileSystemHandle.
 * KV delegates to `idb` via a lazy import so importing this module never drags IndexedDB
 * into a headless graph.
 * @type {StorageAdapter}
 */
export const BrowserStorageAdapter = {
  kind: 'browser',
  caps,
  async kvSet(key, value) { return (await import('../idb.js')).kvSet(key, value); },
  async kvGet(key) { return (await import('../idb.js')).kvGet(key); },
  async kvDelete(key) { return (await import('../idb.js')).kvDelete(key); },
  async kvKeys() { return (await import('../idb.js')).kvKeys(); },
  async mountDirectory() {
    if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
      throw new Error('Directory mounting is unavailable');
    }
    const ref = await window.showDirectoryPicker();
    return { ref, name: ref.name };
  },
  async listDirectory(ref, parentPath = '') {
    const entries = [];
    for await (const [name, childRef] of ref.entries()) {
      if (childRef.kind !== 'directory' && childRef.kind !== 'file') continue;
      entries.push({
        name,
        path: parentPath ? `${parentPath}/${name}` : name,
        kind: childRef.kind,
        ref: childRef,
      });
    }
    return entries.sort((a, b) => (
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1
    ));
  },
  async readFile(ref) { return ref.getFile(); },

  async resolveAsset(source, opts = {}) {
    return resolveVia(_browserReadSource, source, opts);
  },

  async persistRef(ref) {
    if (!ref || (ref.kind !== 'directory' && ref.kind !== 'file')) {
      throw new TypeError('persistRef: expected a file or directory handle');
    }
    const idb = await _idb();
    const base = await _browserBaseKey(ref);
    // A different entry already owns the derived key (same name + first entry):
    // suffix instead of overwriting someone else's link.
    for (let i = 1; i <= MAX_KEY_SUFFIX; i++) {
      const key = i === 1 ? base : `${base}_${i}`;
      const existing = await idb.getHandle(key);
      if (!existing || await _sameEntry(existing, ref)) {
        await idb.putHandle(key, ref);
        return key;
      }
    }
    throw new Error('persistRef: too many distinct entries share one key');
  },

  async restoreRef(key) { return _browserRestore(key); },

  async deleteRef(key) { return (await _idb()).deleteHandle(key); },

  async findMoved(source, opts = {}) {
    const src = normalizeSource(source);
    const folderKey = opts.refKey ?? (src?.kind === 'folder' ? src.refKey : null);
    const root = folderKey ? await _browserRestore(folderKey) : null;
    if (!src || !root || root.kind !== 'directory' || !opts.contentHash) {
      return { source: null, blob: null, scanned: 0 };
    }
    const hit = await walkForHash(BrowserStorageAdapter, root, {
      contentHash: opts.contentHash,
      ext: extOfName(src.path || src.label),
      limit: opts.limit ?? FIND_MOVED_LIMIT,
      onProgress: opts.onProgress,
    });
    return {
      source: hit.path ? { kind: 'folder', refKey: folderKey, path: hit.path, label: src.label } : null,
      blob: hit.blob,
      scanned: hit.scanned,
    };
  },
};

export { ASSET_STATUS };

/**
 * The active StorageAdapter for this runtime. Desktop (Node fs) is injected at boot
 * in Phase 2; `isDesktop()` gates that swap. Browser is the only impl today.
 * @type {StorageAdapter}
 */
export const storage = isDesktop() ? DesktopStorageAdapter : BrowserStorageAdapter;
