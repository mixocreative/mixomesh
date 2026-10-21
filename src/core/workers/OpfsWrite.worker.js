// OPFS write fallback (task 8.2) for WebKit builds without a main-thread
// `FileSystemFileHandle.createWritable()`: sync access handles exist only in
// dedicated workers. The main thread (OpfsStorageAdapter.writeFile) posts the
// file's OPFS path + a COPY of the bytes; this replaces the file contents.
// Not atomic (truncate + write) — the createWritable path is preferred whenever present.

import { serveTask } from './serveTask.js';

serveTask(async ({ path, bytes } = {}) => {
  let access = null;
  try {
    if (!Array.isArray(path) || !path.length) throw new Error('No OPFS path');
    let dir = await navigator.storage.getDirectory();
    for (const seg of path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    const handle = await dir.getFileHandle(path[path.length - 1], { create: true });
    access = await handle.createSyncAccessHandle();
    access.truncate(0);
    let at = 0;
    while (at < bytes.byteLength) {
      const n = access.write(bytes.subarray(at), { at });
      if (!(n > 0)) throw new Error('OPFS write made no progress');
      at += n;
    }
    access.flush();
    return true;
  } finally {
    try { access?.close(); } catch { /* already closed */ }
  }
});
