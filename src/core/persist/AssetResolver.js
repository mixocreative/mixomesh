// Tiered asset-byte resolution on load: live path → content-hash scan →
// persisted single-file handle → embedded base64 → null (ghost).

import { getFileHandle } from '../idb.js';
import { sha256Hex } from '../hash.js';
import { bufFromB64, extOf } from './ProjectSerializer.js';
import { SCAN_FILE_LIMIT } from './constants.js';

export async function fileHandleAtPath(dirHandle, path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  let dir = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir.getFileHandle(parts[parts.length - 1]);
}

export async function scanDirForHash(dirHandle, hash, ext, budget = { n: 0 }) {
  for await (const [, h] of dirHandle.entries()) {
    if (budget.n > SCAN_FILE_LIMIT) return null;
    if (h.kind === 'file') {
      if (ext && extOf(h.name) !== ext) continue;
      budget.n++;
      try {
        const f   = await h.getFile();
        const buf = await f.arrayBuffer();
        if (await sha256Hex(buf) === hash) return f;
      } catch { /* unreadable — skip */ }
    } else if (h.kind === 'directory') {
      const found = await scanDirForHash(h, hash, ext, budget);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve an asset's bytes for load. Priority:
 *   1. Live file at originalPath inside a re-granted mounted directory.
 *   2. Live file found by content-hash scan of that directory (moved/renamed).
 *   3. Embedded base64 copy (static / unlinked).
 *   4. null → ghost.
 * @returns {Promise<{blob:Blob, live:boolean}|null>}
 */
export async function resolveAssetBlob(entry) {
  if (entry.directoryHandleKey && entry.originalPath) {
    try {
      const dir = await getFileHandle(entry.directoryHandleKey);
      if (dir && (await dir.requestPermission({ mode: 'read' })) === 'granted') {
        try {
          const fh = await fileHandleAtPath(dir, entry.originalPath);
          if (fh) return { blob: await fh.getFile(), live: true };
        } catch { /* path miss → hash fallback */ }
        if (entry.contentHash) {
          const f = await scanDirForHash(dir, entry.contentHash, entry.extension);
          if (f) return { blob: f, live: true };
        }
      }
    } catch (err) {
      // Console-only by policy: the tiered resolve falls through to the
      // embedded snapshot, and the unmatchedAssets modal surfaces the miss.
      console.error(`Live resolve failed for ${entry.filename}:`, err);
    }
  }
  // Loose drag-drop: no directory, but a persisted single-file handle. Lower
  // priority than a mounted directory (a dir also gives the hash-rescan
  // relink) but above the frozen embedded snapshot — a dragged file can stay
  // live across reloads in the same browser profile.
  if (entry.fileHandleKey) {
    try {
      const fh = await getFileHandle(entry.fileHandleKey);
      if (fh && (await fh.requestPermission({ mode: 'read' })) === 'granted') {
        return { blob: await fh.getFile(), live: true };
      }
    } catch (err) {
      // Console-only by policy: falls through to the embedded snapshot.
      console.error(`File-handle resolve failed for ${entry.filename}:`, err);
    }
  }
  if (entry.fileData) {
    return { blob: new Blob([bufFromB64(entry.fileData)]), live: false };
  }
  return null;
}
