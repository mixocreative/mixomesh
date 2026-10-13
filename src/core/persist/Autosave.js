// Interval autosave to idb (skipEmbed — arch A9) + boot-time crash recovery.
// Keyed by project.id (task 0.11); texture images stored once per hash.

import { EVENTS } from '../events.js';
import { getState, setState, dispatch } from '../StateManager.js';
import { storage } from '../storage/StorageAdapter.js';
import { reportError } from '../../ui/Status.js';
import { t } from '../../i18n/index.js';
import { AssetLoader } from '../AssetLoader.js';
import { buildDocument, referencedTextureImages, serialiseTextureImage } from './ProjectSerializer.js';
import { loadProject, assertNoImportInFlight } from './ProjectLoader.js';
import { isLoading } from './LoadGate.js';
import { isDirty } from './DirtyTracker.js';
import { AUTOSAVE_PREFIX, SILENT } from './constants.js';
import { mintProjectId } from './ProjectId.js';
import {
  autosaveKey, autosaveImageKey, autosaveImagePrefix, projectIdFromAutosaveKey, deleteAutosave,
  isImageStored, markImageStored,
} from './AutosaveKeys.js';

let _autosaveTimer  = null;
let _autosaveWarned = false;   // warn once per session, not every 60 s tick
let _ticking        = false;   // one snapshot at a time (a slow build must not overlap the next tick)

/** The live project's id, minting one first if the project has none yet. */
export function ensureProjectId() {
  let id = getState().project.id;
  if (!id) {
    id = mintProjectId();
    setState(s => ({ ...s, project: { ...s.project, id } }), SILENT);
  }
  return id;
}

const _worldBusy = () => isLoading() || AssetLoader.isImporting();

/** Write every referenced texture image not yet stored for this project. */
async function _storeTextureImages(projectId) {
  for (const image of referencedTextureImages()) {
    if (isImageStored(projectId, image.hash)) continue;
    await storage.kvSet(autosaveImageKey(projectId, image.hash), await serialiseTextureImage(image));
    markImageStored(projectId, image.hash);
  }
}

/** One autosave snapshot. Exported for tests; the interval calls it. */
export async function autosaveTick() {
  if (_ticking || !isDirty()) return false;
  // M2: never snapshot a half-built world. Mid-load the state is a mix of
  // old and new project; mid-import the container is registered but its
  // objects are not minted yet — either would write a torn autosave that
  // the next boot offers to "recover".
  if (_worldBusy()) return false;
  _ticking = true;
  try {
    const projectId = ensureProjectId();
    const doc = await buildDocument({ skipEmbed: true, skipTextureImages: true });   // A9 + 0.11
    // The build is async: a load/import/New that started meanwhile makes the
    // snapshot torn or stale — drop it (the check wraps the whole build).
    if (_worldBusy() || getState().project.id !== projectId) return false;
    await _storeTextureImages(projectId);
    await storage.kvSet(autosaveKey(projectId), {
      savedAt: new Date().toISOString(), name: getState().project.name, doc,
    });
    dispatch(EVENTS.AUTOSAVE_WRITTEN, {});
    _autosaveWarned = false;
    return true;
  } catch (err) {
    if (_autosaveWarned) {
      console.error('Autosave failed:', err);
    } else {
      _autosaveWarned = true;
      reportError(err, { title: t('toast.autosaveFailed') });
    }
    return false;
  } finally {
    _ticking = false;
  }
}

export function startAutosave(ms = 60000) {
  stopAutosave();
  _autosaveTimer = setInterval(() => autosaveTick(), ms);
}

export function stopAutosave() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
}

/** Re-attach a snapshot's separately stored texture images to its doc. */
async function _withStoredImages(projectId, doc, keys) {
  const prefix = autosaveImagePrefix(projectId);
  const images = [...(Array.isArray(doc.textureImages) ? doc.textureImages : [])];
  const have = new Set(images.map(i => i?.hash));
  for (const k of keys) {
    if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
    const image = await storage.kvGet(k);
    if (image?.hash && !have.has(image.hash)) { images.push(image); have.add(image.hash); }
  }
  return { ...doc, textureImages: images };
}

/**
 * On boot, offer to recover the newest autosave if one exists and it is newer
 * than that project's last real save. A recovered project stays DIRTY (it is
 * unsaved work) so closing still prompts and the next tick re-snapshots it.
 * @returns {Promise<boolean>} true if a project was recovered
 */
export async function recoverAutosave() {
  assertNoImportInFlight();   // F20: recovery resets the world like any load
  let keys;
  try { keys = await storage.kvKeys(); } catch { return false; }
  keys = keys || [];
  const auto = keys.filter(k => typeof k === 'string' && k.startsWith(AUTOSAVE_PREFIX));
  if (!auto.length) return false;

  let newest = null;
  for (const k of auto) {
    const v = await storage.kvGet(k);
    if (v?.savedAt && (!newest || v.savedAt > newest.savedAt)) newest = { key: k, ...v };
  }
  if (!newest) return false;

  const lastSaved = newest.doc?.project?.lastSavedAt;
  if (lastSaved && newest.savedAt <= lastSaved) {   // nothing newer than the file
    await deleteAutosave(projectIdFromAutosaveKey(newest.key));
    return false;
  }

  const choice = await new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'recoverAutosave',
      savedAt: newest.savedAt,
      onClose: (r) => resolve(r || 'discard'),
    });
  });
  const projectId = projectIdFromAutosaveKey(newest.key);
  if (choice === 'recover') {
    try {
      await loadProject(await _withStoredImages(projectId, newest.doc || {}, keys));
      // Recovered ≠ saved: stay dirty, and re-snapshot now — the load just
      // cleared this project's autosave keys like any successful load.
      dispatch(EVENTS.PROJECT_DIRTY, {});
      autosaveTick();
      return true;
    } catch (err) {
      // M2: a poisoned autosave (torn write, schema from another build) must
      // not be re-offered on every boot — drop the key and say why.
      await deleteAutosave(projectId);
      reportError(err, { title: t('toast.autosaveRecoverFailed') });
      return false;
    }
  }
  await deleteAutosave(projectId);
  return false;
}
