// Mounted-directory opaque refs. Browser refs are File System Access handles and
// can be restored from IndexedDB; desktop refs are main-process-only tokens and
// are intentionally session-scoped. Kept across project switches (BLUEPRINT §14.2).

import { putHandle, getHandle } from '../idb.js';
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
  const key = `dir_${mounted.name}_${Date.now()}`;
  _dirRefs.set(key, mounted.ref);
  if (storage.kind === 'browser') await putHandle(key, mounted.ref);
  return { ref: mounted.ref, handle: mounted.ref, key, name: mounted.name };
}

/**
 * Restore a previously-mounted directory handle (requires re-grant of permission).
 * @param {string} key
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function restoreDirectory(key) {
  if (storage.kind !== 'browser') return null;
  const handle = await getHandle(key);
  if (!handle) return null;
  const granted = await handle.requestPermission({ mode: 'read' });
  if (granted !== 'granted') return null;
  _dirRefs.set(key, handle);
  return handle;
}

/** @param {string} key */
export function getDirectoryHandle(key) {
  return _dirRefs.get(key) ?? null;
}
