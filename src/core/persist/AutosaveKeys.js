// Autosave key layout (task 0.11), shared by Autosave / ProjectLoader /
// PersistenceManager without an import cycle (Autosave imports the loader).
//   autosave_<projectId>               → { savedAt, name, doc }   (doc.textureImages = [])
//   autosaveimg_<projectId>_<hash>     → one serialised texture image, written ONCE per hash
// The image prefix deliberately does NOT start with AUTOSAVE_PREFIX, so the
// boot scan for `autosave_*` never mistakes an image for a snapshot.

import { storage } from '../storage/StorageAdapter.js';
import { AUTOSAVE_PREFIX, AUTOSAVE_IMG_PREFIX } from './constants.js';

export const autosaveKey = (projectId) => `${AUTOSAVE_PREFIX}${projectId}`;
export const autosaveImagePrefix = (projectId) => `${AUTOSAVE_IMG_PREFIX}${projectId}_`;
export const autosaveImageKey = (projectId, hash) => `${autosaveImagePrefix(projectId)}${hash}`;

// `${projectId}:${hash}` images already written this session — skip re-encoding.
// Cleared per project by deleteAutosave so a deleted snapshot rewrites them.
const _storedImages = new Set();
export const isImageStored = (projectId, hash) => _storedImages.has(`${projectId}:${hash}`);
export const markImageStored = (projectId, hash) => { _storedImages.add(`${projectId}:${hash}`); };

/** Project id encoded in an `autosave_<id>` key. */
export const projectIdFromAutosaveKey = (key) => key.slice(AUTOSAVE_PREFIX.length);

/**
 * Delete a project's autosave snapshot AND its stored texture images.
 * Best effort per key; never throws.
 * @param {string|null|undefined} projectId
 */
export async function deleteAutosave(projectId) {
  if (!projectId) return;
  for (const tag of _storedImages) if (tag.startsWith(`${projectId}:`)) _storedImages.delete(tag);
  try { await storage.kvDelete(autosaveKey(projectId)); } catch { /* best effort */ }
  let keys = [];
  try { keys = await storage.kvKeys(); } catch { return; }
  const prefix = autosaveImagePrefix(projectId);
  for (const k of keys || []) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      try { await storage.kvDelete(k); } catch { /* best effort */ }
    }
  }
}
