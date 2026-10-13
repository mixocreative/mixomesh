// Tiered asset-byte resolution on load. Every live tier goes through the active
// StorageAdapter (`resolveAsset` / `restoreRef`, task 4.2) — no FSA or IndexedDB
// calls here, so the same resolver serves the browser and the desktop runtime.
// Order: folder source → single-file source → embedded base64 → null (ghost).
// Load never scans (Decision 3); the hash search is the explicit findMovedForAsset.

import { storage } from '../storage/StorageAdapter.js';
import { ASSET_STATUS, fileHandleAtPath } from '../storage/AssetSource.js';
import { getState, setState, dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';
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
 * Resolve an asset's bytes for load. LOAD NEVER SCANS (Decision 3): the only
 * live reads are one `adapter.resolveAsset` per link. Priority:
 *   1. Linked source (folder path, then single file) whose bytes match.
 *   2. Embedded base64 copy — also used when a link is `changed` (bytes differ
 *      from contentHash) or `missing`; the status is recorded so the UI can
 *      offer Refresh / "Find moved file…". Bytes are never silently swapped.
 *   3. A `changed` live file, only when there is no embedded copy to prefer.
 *   4. null → ghost.
 * `status` uses the adapter words: 'linked' | 'changed' | 'missing' | 'embedded'.
 * @param {object} entry  asset library entry
 * @param {{adapter?:import('../storage/StorageAdapter.js').StorageAdapter}} [opts]
 * @returns {Promise<{blob:Blob, live:boolean, status:string}|null>}
 */
export async function resolveAssetBlob(entry, { adapter = storage } = {}) {
  const sources = sourcesOf(entry);
  let changedBlob = null;
  for (const source of sources) {
    try {
      const r = await adapter.resolveAsset(source, { contentHash: entry.contentHash });
      if (r?.blob && r.status === ASSET_STATUS.LINKED) {
        _recordStatus(entry, ASSET_STATUS.LINKED);
        return { blob: r.blob, live: true, status: r.status };
      }
      if (r?.blob && r.status === ASSET_STATUS.CHANGED && !changedBlob) changedBlob = r.blob;
    } catch (err) {
      // Console-only by policy: the tiered resolve falls through to the
      // embedded snapshot, and the unmatchedAssets modal surfaces the miss.
      console.error(`Live resolve failed for ${entry.filename}:`, err);
    }
  }
  const fallbackStatus = changedBlob ? ASSET_STATUS.CHANGED
    : sources.length ? ASSET_STATUS.MISSING : ASSET_STATUS.EMBEDDED;
  _recordStatus(entry, fallbackStatus);
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
  if (changedBlob) return { blob: changedBlob, live: true, status: ASSET_STATUS.CHANGED };
  return null;
}

// ── Per-session resolution status (not persisted) ───────────────────────────
const _statusById = new Map();
function _recordStatus(entry, status) { if (entry?.id) _statusById.set(entry.id, status); }

/** Last resolution status for an asset ('linked'|'changed'|'missing'|'embedded'), or null. */
export function getAssetStatus(assetId) { return _statusById.get(assetId) ?? null; }
/** True when the asset has a link that failed or drifted — "Find moved file…" applies. */
export function canFindMoved(assetId) {
  const st = getAssetStatus(assetId);
  return st === ASSET_STATUS.MISSING || st === ASSET_STATUS.CHANGED;
}
export function clearAssetStatuses() { _statusById.clear(); }

/**
 * Explicit, user-invoked hash search for a moved/renamed file (the only walk;
 * never called during load). Returns the adapter result.
 * @returns {Promise<{source:object|null, blob:Blob|null, scanned:number}>}
 */
export async function findMovedForAsset(assetId, { adapter = storage, onProgress, limit } = {}) {
  const entry = getState().scene.assetLibrary[assetId];
  const all = entry ? sourcesOf(entry) : [];
  const source = all.find(s => s.kind === 'folder') ?? all[0];
  if (!entry || !source || !entry.contentHash) return { source: null, blob: null, scanned: 0 };
  return adapter.findMoved(source, { contentHash: entry.contentHash, onProgress, limit, refKey: source.refKey });
}

/**
 * Point an asset at the file `findMoved` located. Seam for 4.5's
 * RelinkAssetCommand to wrap. Updates `source` plus the legacy keys that the
 * serializer still treats as authoritative.
 * @returns {boolean} true when the entry was updated
 */
export function applyFoundSource(assetId, result) {
  const found = result?.source;
  const entry = getState().scene.assetLibrary[assetId];
  if (!entry || !found) return false;
  setState(s => {
    const next = { ...s.scene.assetLibrary[assetId], source: { ...found } };
    if (found.kind === 'folder') { next.directoryHandleKey = found.refKey; next.originalPath = found.path; }
    return { ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: next } } };
  });
  _statusById.set(assetId, ASSET_STATUS.LINKED);
  dispatch(EVENTS.ASSET_RELINKED, { assetId });
  return true;
}
