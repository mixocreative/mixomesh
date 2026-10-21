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
import { isDirty, whenSaveIdle, isSaving, saveGeneration } from './DirtyTracker.js';
import { AUTOSAVE_PREFIX, SILENT } from './constants.js';
import { mintProjectId } from './ProjectId.js';
import {
  autosaveKey, autosaveImageKey, autosaveImagePrefix, projectIdFromAutosaveKey, deleteAutosave,
  isImageStored, markImageStored,
  AUTOSAVE_PAUSED_AFTER_SKIPS, autosaveStatus, setAutosaveStatus,
} from './AutosaveKeys.js';

export { autosaveStatus };

let _autosaveTimer  = null;
let _autosaveWarned = false;   // toast once per session; the status bar keeps showing it (B-02)
let _ticking        = false;   // one snapshot at a time (a slow build must not overlap the next tick)

// A tick that could not run. Three in a row while the project is dirty means
// no snapshot is being written for minutes: say so on the status bar (B-02).
function _skipped(reason) {
  const skips = autosaveStatus().skips + 1;
  setAutosaveStatus({ skips, reason });
  if (skips >= AUTOSAVE_PAUSED_AFTER_SKIPS) {
    setAutosaveStatus({ state: 'paused' });
    dispatch(EVENTS.AUTOSAVE_FAILED, autosaveStatus());
  }
  return false;
}

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
  if (!isDirty()) {   // nothing to protect: a clean project is not a stalled autosave
    if (autosaveStatus().state !== 'written') setAutosaveStatus({ state: 'idle' });
    setAutosaveStatus({ skips: 0, reason: null });
    return false;
  }
  if (_ticking) return _skipped('slow');
  // M2: never snapshot a half-built world. Mid-load the state is a mix of
  // old and new project; mid-import the container is registered but its
  // objects are not minted yet — either would write a torn autosave that
  // the next boot offers to "recover". A Save in flight will leave the file
  // newer than anything this tick could write.
  if (_worldBusy() || isSaving()) return _skipped('busy');
  _ticking = true;
  try {
    const projectId = ensureProjectId();
    const generation = saveGeneration();
    const doc = await buildDocument({ skipEmbed: true, skipTextureImages: true });   // A9 + 0.11
    // The build is async: a load/import/New that started meanwhile makes the
    // snapshot torn or stale — drop it (the check wraps the whole build).
    const stale = () => _worldBusy() || getState().project.id !== projectId || saveGeneration() !== generation;
    if (stale()) return false;
    await _storeTextureImages(projectId);
    await storage.kvSet(autosaveKey(projectId), {
      savedAt: new Date().toISOString(), name: getState().project.name, doc,
    });
    // A Save that completed during the write already deleted this key once;
    // the snapshot predates the file, so take it back out (A-07).
    if (stale()) { await deleteAutosave(projectId); return false; }
    setAutosaveStatus({ state: 'written', lastWrittenAt: new Date().toISOString(), failures: 0, lastError: null, skips: 0, reason: null });
    dispatch(EVENTS.AUTOSAVE_WRITTEN, autosaveStatus());
    _autosaveWarned = false;
    return true;
  } catch (err) {
    setAutosaveStatus({ state: 'failing', failures: autosaveStatus().failures + 1, lastError: err?.message ?? String(err) });
    dispatch(EVENTS.AUTOSAVE_FAILED, autosaveStatus());
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
 * Boot check (task 4.7, Decision 4): the newest autosave that is newer than
 * its project's last real save, or null. Stale snapshots (not newer than the
 * file) are deleted silently. Never opens UI and never touches the world —
 * the boot banner renders the offer; `recoverAutosave(offer)` applies it.
 * A store that cannot be read is `{ unreadable }`, never null: "blind" must
 * not look like "clean" (cia B-03), or a crash plus a blocked IndexedDB shows
 * the same screen as no unsaved work and the snapshot is never offered again.
 * @returns {Promise<{key:string, projectId:string, savedAt:string, name:string}|{unreadable:Error}|null>}
 */
export async function findRecoverableAutosave() {
  let newest = null;
  try {
    const keys = await storage.kvKeys();
    const auto = (keys || []).filter(k => typeof k === 'string' && k.startsWith(AUTOSAVE_PREFIX));
    if (!auto.length) return null;
    for (const k of auto) {
      const v = await storage.kvGet(k);
      if (v?.savedAt && (!newest || v.savedAt > newest.savedAt)) newest = { key: k, ...v };
    }
  } catch (err) {
    return { unreadable: err instanceof Error ? err : new Error(String(err)) };
  }
  if (!newest) return null;

  const projectId = projectIdFromAutosaveKey(newest.key);
  const lastSaved = newest.doc?.project?.lastSavedAt;
  if (lastSaved && newest.savedAt <= lastSaved) {   // nothing newer than the file
    await deleteAutosave(projectId);
    return null;
  }
  return {
    key: newest.key, projectId, savedAt: newest.savedAt,
    name: newest.name ?? newest.doc?.project?.name ?? '',
  };
}

/**
 * Recover an autosave (the banner's "Recover" action; with no `offer` the
 * newest recoverable one is looked up first). A recovered project re-attaches
 * its stored texture images and stays DIRTY (it is unsaved work) so closing
 * still prompts and the next tick re-snapshots it.
 * @param {{key:string, projectId:string}|null} [offer]  from findRecoverableAutosave()
 * @returns {Promise<boolean>} true if a project was recovered
 */
export async function recoverAutosave(offer = null) {
  await whenSaveIdle();       // a save still writing must finish before the world is replaced (A-08)
  assertNoImportInFlight();   // F20: recovery resets the world like any load
  const target = offer ?? await findRecoverableAutosave();
  if (!target) return false;
  if (target.unreadable) throw target.unreadable;   // a fault, not "nothing to recover"
  const { projectId } = target;
  try {
    const snap = await storage.kvGet(target.key);
    if (!snap?.doc) return false;   // discarded / superseded since the offer
    const keys = (await storage.kvKeys()) || [];
    await loadProject(await _withStoredImages(projectId, snap.doc, keys));
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

/**
 * Drop an offered autosave (snapshot + its stored images) without loading it.
 * @param {{projectId:string}|null} offer
 */
export async function discardAutosave(offer) {
  if (offer?.projectId) await deleteAutosave(offer.projectId);
}
