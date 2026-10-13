// Tiered asset-byte resolution on load. Every live tier goes through the active
// StorageAdapter (`resolveAsset` / `restoreRef`, task 4.2) — no FSA or IndexedDB
// calls here, so the same resolver serves the browser and the desktop runtime.
// Order: folder source → (legacy) hash scan of that folder → single-file source
//        → embedded base64 → null (ghost).

import { storage } from '../storage/StorageAdapter.js';
import { ASSET_STATUS, fileHandleAtPath } from '../storage/AssetSource.js';
import { directoryRefFacade } from '../assets/DirMounts.js';
import { sha256Hex } from '../hash.js';
import { bufFromB64, extOf } from './ProjectSerializer.js';
import { SCAN_FILE_LIMIT } from './constants.js';

export { fileHandleAtPath };

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
 * The asset's link(s) as adapter `source` descriptors, highest priority first.
 * Schema-3.4 `entry.source` wins; legacy `directoryHandleKey`+`originalPath`
 * and `fileHandleKey` are mapped onto the same shape.
 * @returns {Array<{kind:'folder'|'file', refKey:string, path:string, label:string}>}
 */
export function sourcesOf(entry) {
  const label = entry?.filename ?? '';
  if (entry?.source && typeof entry.source === 'object') return [entry.source];
  const out = [];
  if (entry?.directoryHandleKey && entry.originalPath) {
    out.push({ kind: 'folder', refKey: entry.directoryHandleKey, path: entry.originalPath, label });
  }
  if (entry?.fileHandleKey) out.push({ kind: 'file', refKey: entry.fileHandleKey, path: label, label });
  return out;
}

/**
 * Resolve an asset's bytes for load. Priority:
 *   1. Linked source (folder path, adapter `resolveAsset`).
 *   2. Content-hash scan of that folder (legacy tier, see BLUEPRINT §11).
 *   3. Linked single-file source.
 *   4. Embedded base64 copy.
 *   5. null → ghost.
 * `status` uses the adapter words: 'linked' | 'changed' (live bytes differ from
 * contentHash — still used, flagged) | 'missing' (a link existed but failed;
 * embedded copy used) | 'embedded' (never linked).
 * @param {object} entry  asset library entry
 * @param {{adapter?:import('../storage/StorageAdapter.js').StorageAdapter}} [opts]
 * @returns {Promise<{blob:Blob, live:boolean, status:string}|null>}
 */
export async function resolveAssetBlob(entry, { adapter = storage } = {}) {
  const sources = sourcesOf(entry);
  for (const source of sources) {
    try {
      const r = await adapter.resolveAsset(source, { contentHash: entry.contentHash });
      if (r?.blob && (r.status === ASSET_STATUS.LINKED || r.status === ASSET_STATUS.CHANGED)) {
        return { blob: r.blob, live: true, status: r.status };
      }
      if (source.kind === 'folder' && entry.contentHash) {
        const ref = await adapter.restoreRef(source.refKey);
        if (ref) {
          const f = await scanDirForHash(directoryRefFacade(adapter, ref), entry.contentHash, entry.extension);
          if (f) return { blob: f, live: true, status: ASSET_STATUS.LINKED };
        }
      }
    } catch (err) {
      // Console-only by policy: the tiered resolve falls through to the
      // embedded snapshot, and the unmatchedAssets modal surfaces the miss.
      console.error(`Live resolve failed for ${entry.filename}:`, err);
    }
  }
  const fallbackStatus = sources.length ? ASSET_STATUS.MISSING : ASSET_STATUS.EMBEDDED;
  if (entry.fileData) {
    const bytes = bufFromB64(entry.fileData);
    // M5: the embedded copy must match the hash recorded at import. A mismatch
    // (edited/corrupt .mixo) is unresolvable → ghost, surfaced by the load
    // summary; never throw and tear the whole load. Legacy docs without a
    // contentHash are trusted as before.
    if (entry.contentHash) {
      const actual = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (actual !== entry.contentHash) {
        console.error(`Embedded bytes for ${entry.filename} do not match contentHash `
          + `(expected ${entry.contentHash}, got ${actual}) — treating as unresolvable`);
        return null;
      }
    }
    return { blob: new Blob([bytes]), live: false, status: fallbackStatus };
  }
  return null;
}
