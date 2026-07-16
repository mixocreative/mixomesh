// Mounted-directory handles (File System Access API). Session-scoped map,
// persisted to IndexedDB so a later session can re-mount after permission
// re-grant. Kept across project switches (BLUEPRINT §14.2).

import { putHandle, getHandle } from '../idb.js';

const _dirHandles = new Map();    // key → FileSystemDirectoryHandle (session)

/**
 * Prompt the user to mount a directory via the File System Access API.
 * Persists the handle in IndexedDB for session restoration (Phase 6).
 * @returns {Promise<{handle: FileSystemDirectoryHandle, key: string}>}
 */
export async function mountDirectory() {
  const handle = await window.showDirectoryPicker();
  const key = `dir_${handle.name}_${Date.now()}`;
  _dirHandles.set(key, handle);
  await putHandle(key, handle);
  return { handle, key };
}

/**
 * Restore a previously-mounted directory handle (requires re-grant of permission).
 * @param {string} key
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function restoreDirectory(key) {
  const handle = await getHandle(key);
  if (!handle) return null;
  const granted = await handle.requestPermission({ mode: 'read' });
  if (granted !== 'granted') return null;
  _dirHandles.set(key, handle);
  return handle;
}

/** @param {string} key */
export function getDirectoryHandle(key) {
  return _dirHandles.get(key) ?? null;
}
