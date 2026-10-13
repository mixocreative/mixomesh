// Mounted-directory opaque refs. Browser refs are File System Access handles,
// desktop refs are main-process session tokens. Both are persisted through the
// adapter (`persistRef` → STABLE key, Decision 10 / task 4.2) and restored with
// `restoreRef`, so a mount key written into a project survives a restart on
// either runtime. Kept across project switches (BLUEPRINT §14.2).

import { storage } from '../storage/StorageAdapter.js';

const _dirRefs = new Map();    // key → adapter-owned opaque ref (session)

/**
 * Prompt through the active adapter. `handle` remains as a compatibility alias
 * while callers migrate to the runtime-neutral `ref` field.
 * @returns {Promise<{ref:any, handle:any, key:string, name:string}|null>}
 */
export async function mountDirectory() {
  const mounted = await storage.mountDirectory();
  if (!mounted) return null;
  let key;
  try {
    key = await storage.persistRef(mounted.ref);
  } catch (err) {
    // Still usable this session; it just won't relink after a restart.
    console.error(`Could not persist the mount for ${mounted.name}:`, err);
    key = `session_dir_${Date.now()}`;
  }
  _dirRefs.set(key, mounted.ref);
  return { ref: mounted.ref, handle: mounted.ref, key, name: mounted.name };
}

/**
 * Restore a previously-mounted directory by its stable key. The adapter
 * re-validates (browser: permission re-grant; desktop: exists + readable).
 * @param {string} key
 * @returns {Promise<any|null>} adapter-owned opaque ref, or null when missing
 */
export async function restoreDirectory(key) {
  const ref = await storage.restoreRef(key);
  if (!ref) return null;
  _dirRefs.set(key, ref);
  return ref;
}

/** @param {string} key */
export function getDirectoryHandle(key) {
  const ref = _dirRefs.get(key);
  return ref ? directoryRefFacade(storage, ref) : null;
}

/**
 * Legacy handle-shaped view over opaque adapter refs. Keeps OBJ sibling and
 * restore walkers runtime-neutral while their public API migrates by leaf.
 */
export function directoryRefFacade(adapter, ref) {
  const list = () => adapter.listDirectory(ref, '');
  const fileFacade = file => ({ kind: 'file', name: file.name, getFile: () => adapter.readFile(file.ref) });
  return {
    kind: 'directory',
    async getDirectoryHandle(name) {
      const child = (await list()).find(row => row.kind === 'directory' && row.name === name);
      if (!child) throw new Error(`Directory not found: ${name}`);
      return directoryRefFacade(adapter, child.ref);
    },
    async getFileHandle(name) {
      const child = (await list()).find(row => row.kind === 'file' && row.name === name);
      if (!child) throw new Error(`File not found: ${name}`);
      return fileFacade(child);
    },
    async *entries() {
      for (const child of await list()) {
        yield [child.name, child.kind === 'directory'
          ? directoryRefFacade(adapter, child.ref)
          : fileFacade(child)];
      }
    },
  };
}
