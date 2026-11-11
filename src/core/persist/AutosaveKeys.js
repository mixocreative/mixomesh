// Autosave key layout (task 0.11), shared by Autosave / ProjectLoader /
// PersistenceManager without an import cycle (Autosave imports the loader).
//   autosave_<projectId>               → { savedAt, name, doc }   (doc.textureImages = [])
//   autosaveimg_<projectId>_<hash>     → one serialised texture image, written ONCE per hash
// The image prefix deliberately does NOT start with AUTOSAVE_PREFIX, so the
// boot scan for `autosave_*` never mistakes an image for a snapshot.

import { storage } from '../storage/StorageAdapter.js';
import { AUTOSAVE_PREFIX, AUTOSAVE_IMG_PREFIX, AUTOSAVE_FAILED_PREFIX } from './constants.js';

// ── Autosave liveness (cia B-02) ───────────────────────────
// Lives here, not in Autosave.js, so the status bar can read it without
// importing the loader graph (which reaches the status bar itself).

/** Ticks skipped in a row (busy world, slow snapshot) before the status reads paused. */
export const AUTOSAVE_PAUSED_AFTER_SKIPS = 3;

/**
 * @typedef {{ state: 'idle'|'written'|'failing'|'paused', lastWrittenAt: string|null,
 *   failures: number, lastError: string|null, skips: number, reason: 'busy'|'slow'|null }} AutosaveStatus
 */
/** @type {AutosaveStatus} */
const _status = { state: 'idle', lastWrittenAt: null, failures: 0, lastError: null, skips: 0, reason: null };

/** @returns {AutosaveStatus} a copy of the current autosave status. */
export function autosaveStatus() {
  return { ..._status };
}

/** @param {Partial<AutosaveStatus>} patch */
export function setAutosaveStatus(patch) {
  Object.assign(_status, patch);
}

export const autosaveKey = (projectId) => `${AUTOSAVE_PREFIX}${projectId}`;
export const failedAutosaveKey = (projectId) => `${AUTOSAVE_FAILED_PREFIX}${projectId}`;
export const autosaveImagePrefix = (projectId) => `${AUTOSAVE_IMG_PREFIX}${projectId}_`;
export const autosaveImageKey = (projectId, hash) => `${autosaveImagePrefix(projectId)}${hash}`;

// `${projectId}:${hash}` images already written this session — skip re-encoding.
// Cleared per project by deleteAutosave so a deleted snapshot rewrites them.
const _storedImages = new Set();
export const isImageStored = (projectId, hash) => _storedImages.has(`${projectId}:${hash}`);
export const markImageStored = (projectId, hash) => { _storedImages.add(`${projectId}:${hash}`); };

/** Project id encoded in an `autosave_<id>` key. */
export const projectIdFromAutosaveKey = (key) => key.slice(AUTOSAVE_PREFIX.length);

async function _hasFailedSnapshot(projectId) {
  try { return !!await storage.kvGet(failedAutosaveKey(projectId)); } catch { return false; }
}

/**
 * Move a snapshot a recovery attempt could not load out of the scanned
 * `autosave_` namespace instead of deleting it (cia MX-02, invariant: the app
 * never destroys the user's unsaved work).
 *
 * The bytes — and the texture images they reference — stay in the store under
 * `autosavefailed_<projectId>`, one per project, so a later build, a lighter
 * machine or a support copy still has something to open. The boot scan does
 * not see them, which is the point: re-offering a snapshot that just threw is
 * how a poisoned autosave becomes a failure on every launch.
 *
 * Offered back by the boot banner: `findFailedAutosave` picks the newest kept snapshot when
 * there is no live one, and the banner shows it as what it is — a recovery that FAILED — with
 * Try again and a Discard that asks first. `discardAutosave` is still the only thing that
 * destroys it, and it takes the texture images with it.
 *
 * @param {string|null|undefined} projectId
 * @returns {Promise<boolean>} true when a snapshot was moved
 */
export async function keepFailedAutosave(projectId) {
  if (!projectId) return false;
  try {
    const snap = await storage.kvGet(autosaveKey(projectId));
    if (!snap) return false;
    await storage.kvSet(failedAutosaveKey(projectId), snap);
    await storage.kvDelete(autosaveKey(projectId));
    return true;
  } catch (err) {
    // The store itself is broken. Leaving the live key in place is the safe
    // end: the bytes are still there and the banner will offer them again.
    console.error(`Could not set aside the failed autosave for "${projectId}":`, err);
    return false;
  }
}

/**
 * Delete a project's autosave snapshot AND its stored texture images.
 * Best effort per key; never throws.
 * @param {string|null|undefined} projectId
 */
export async function deleteAutosave(projectId) {
  if (!projectId) return;
  for (const tag of _storedImages) if (tag.startsWith(`${projectId}:`)) _storedImages.delete(tag);
  try { await storage.kvDelete(autosaveKey(projectId)); } catch { /* best effort */ }
  // MX-02: the images are shared with any snapshot kept by a FAILED recovery
  // (same projectId, same hashes). A plain delete runs after every successful
  // load of this project, so sweeping them here would quietly strip the
  // textures off the salvaged copy and leave bytes nothing can restore.
  // Only discardAutosave (the user saying "throw it away") gets that far.
  if (await _hasFailedSnapshot(projectId)) return;
  let keys = [];
  try { keys = await storage.kvKeys(); } catch { return; }
  const prefix = autosaveImagePrefix(projectId);
  for (const k of keys || []) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      try { await storage.kvDelete(k); } catch { /* best effort */ }
    }
  }
}
