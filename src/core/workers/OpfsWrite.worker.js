// OPFS write fallback (task 8.2) for WebKit builds without a main-thread
// `FileSystemFileHandle.createWritable()`: sync access handles exist only in
// dedicated workers. The main thread (OpfsStorageAdapter.writeFile) posts the
// file's OPFS path, the sibling temp name to stage the bytes in, and a COPY
// of the bytes.
//
// Write-temp-then-swap (cia B-05): the bytes go to a sibling temp file first,
// so a quota error or a terminated worker mid-write leaves the previous save
// untouched. The swap is `move()` where the engine has it (atomic rename);
// otherwise the complete temp is copied over the target and the temp removed.
// Progress carries the phase: 'temp' = previous file intact, 'swap' = the
// target is being replaced (the temp still holds the whole new document).

import { serveTask } from './serveTask.js';

async function writeAll(handle, bytes, onProgress) {
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let at = 0;
    while (at < bytes.byteLength) {
      const n = access.write(bytes.subarray(at), { at });
      if (!(n > 0)) throw new Error('OPFS write made no progress');
      at += n;
      onProgress(at);
    }
    access.flush();
  } finally {
    try { access.close(); } catch { /* already closed */ }
  }
}

async function remove(dir, name) {
  try { await dir.removeEntry(name); } catch { /* never existed */ }
}

serveTask(async ({ path, tempName, bytes } = {}, { progress } = {}) => {
  if (!Array.isArray(path) || !path.length) throw new Error('No OPFS path');
  if (typeof tempName !== 'string' || !tempName) throw new Error('No temp name for the OPFS write');
  let dir = await navigator.storage.getDirectory();
  for (const seg of path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  const name = path[path.length - 1];
  const total = bytes.byteLength;

  const temp = await dir.getFileHandle(tempName, { create: true });
  progress?.({ stage: 'temp', loaded: 0, total });
  try {
    await writeAll(temp, bytes, loaded => progress?.({ stage: 'temp', loaded, total }));
  } catch (err) {
    await remove(dir, tempName);
    throw err;
  }

  progress?.({ stage: 'swap', loaded: total, total });
  if (typeof temp.move === 'function') {
    await temp.move(name);
    return true;
  }
  const target = await dir.getFileHandle(name, { create: true });
  await writeAll(target, bytes, () => {});
  await remove(dir, tempName);
  return true;
});
