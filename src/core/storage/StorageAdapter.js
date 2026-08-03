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
// Directory mounting/listing/reading and cross-session KV are implemented. Remaining
// project picker and asset-resolution leaves migrate incrementally (see ADR 0001 +
// HANDOFF.md); today PersistenceManager / AssetImport still own those operations.

import { caps, isDesktop } from './capabilities.js';
import { DesktopStorageAdapter } from './DesktopStorageAdapter.js';

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
 * — Declared, routed as LEAF sites migrate (Phase 1b continuation): —
 * pickOpenProject / pickSaveProject / readProject / writeProject
 * pickImportAssets / readAsset / resolveAsset / watchAsset
 * persistRef / restoreRef / deleteRef / saveExport / recentProjects
 */

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
};

/**
 * The active StorageAdapter for this runtime. Desktop (Node fs) is injected at boot
 * in Phase 2; `isDesktop()` gates that swap. Browser is the only impl today.
 * @type {StorageAdapter}
 */
export const storage = isDesktop() ? DesktopStorageAdapter : BrowserStorageAdapter;
