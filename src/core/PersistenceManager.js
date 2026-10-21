// Persistence façade — thin surface over ./persist/* (house pattern:
// AssetLoader over ./assets/*, PrintManager over ./print/*). Save-side
// document assembly lives in persist/ProjectSerializer.js, tiered asset
// resolution in persist/AssetResolver.js, the load pipeline + relink in
// persist/ProjectLoader.js, recents in persist/RecentProjects.js, autosave in
// persist/Autosave.js, dirty tracking in persist/DirtyTracker.js. This module
// owns only the file-handle lifecycle (save / saveAs / open / newProject /
// openRecent) and re-exports the public API + headless-test surface. Every
// picker / write / ref restore goes through the StorageAdapter (task 4.4):
// `_fileRef` is an adapter-owned opaque ref (browser handle / desktop token).

import { EVENTS } from './events.js';
import { getState, setState, dispatch } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { SettingsStore } from './SettingsStore.js';
import { clear as historyClear } from './HistoryManager.js';
import { Toast } from '../ui/Toast.js';
import { t } from '../i18n/index.js';
import { sha256Hex } from './hash.js';
import { FILE_EXT, SILENT } from './persist/constants.js';
import { mintProjectId } from './persist/ProjectId.js';
import { deleteAutosave } from './persist/AutosaveKeys.js';
import { b64FromBuf, bufFromB64, extOf, buildDocument } from './persist/ProjectSerializer.js';
import { resolveAssetBlob, scanDirForHash, fileHandleAtPath } from './persist/AssetResolver.js';
import {
  loadProject, resetWorld, relinkAsset, isLoading, assertNoImportInFlight,
  migrate, resolveLoadedExportRatios, resolveLoadedExportTargets, arrToMap,
} from './persist/ProjectLoader.js';
import { isDesktop } from './storage/capabilities.js';
import { storage } from './storage/StorageAdapter.js';
import { pushRecent, getRecentProjects } from './persist/RecentProjects.js';
import { startAutosave, stopAutosave, recoverAutosave } from './persist/Autosave.js';
import {
  isDirty, clearDirty, confirmDirty, init, runExclusiveSave, isSaving, whenSaveIdle, beginSave, commitSave,
} from './persist/DirtyTracker.js';

// ── Re-exported surface (unchanged for callers/tests) ────────────────────

export { relinkAsset, getRecentProjects, isLoading };
export { startAutosave, stopAutosave, recoverAutosave };
export { isDirty, init, isSaving };

// Module-local — not persisted.
let _fileRef = null;        // adapter-owned opaque ref of the open .mixo

// ── Public API ───────────────────────────────────────────

/**
 * Write to the currently-open file, or prompt if none. Saves run one at a
 * time; a second Save queues behind the first.
 * @returns {Promise<boolean>} true when bytes hit disk; false when the user
 *   cancelled the save picker. Callers in "save then continue" flows MUST
 *   abort on false — proceeding discards the project the user asked to keep
 *   (review H9).
 */
export function save() {
  return runExclusiveSave(_save);
}

async function _save() {
  // The target is read ONCE: the write goes to the file bound when this save
  // started, whatever gets bound meanwhile (cia A-08).
  const target = _fileRef;
  if (!target) return _saveAs(null);
  const attempt = beginSave();   // same tick as buildDocument's state snapshot
  const text = JSON.stringify(await buildDocument());
  await storage.writeFile(target, text);   // the adapter never commits a half file (see OpfsWrite.worker.js for the sync-handle tier)
  await _afterWrite(attempt, target);
  return true;
}

// Ask the browser to exempt origin storage (IndexedDB recents / autosave) from
// eviction — once, on the first successful save, web only (Electron's storage is
// not evictable). Fire-and-forget: never blocks or fails the save.
let _persistRequested = false;
function _requestPersistentStorage() {
  if (_persistRequested || isDesktop()) return;
  _persistRequested = true;
  try {
    const p = globalThis.navigator?.storage?.persist?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* unsupported — best effort */ }
}

// Post-write bookkeeping shared by save / saveAs: runs only once bytes are on
// disk. `attempt` = the dirty baseline captured when the document was built;
// `staleId` = the project id before a saveAs (which mints a new id — the new
// file is a new document), whose autosave is now stale too.
async function _afterWrite(attempt, target, staleId = null) {
  setState(s => ({ ...s, project: { ...s.project, lastSavedAt: new Date().toISOString() } }), SILENT);
  commitSave(attempt);   // announces PROJECT_SAVED; stays dirty if the user edited during the write
  const name = getState().project.name;
  _requestPersistentStorage();
  Toast.show(t('toast.projectSaved'), 'success', 2000);
  // The bytes are on disk: bookkeeping failures (recents list, autosave key
  // cleanup) are reported but must never reject save().
  try {
    await pushRecent(name, target);
    const id = getState().project.id;
    await deleteAutosave(id);
    if (staleId && staleId !== id) await deleteAutosave(staleId);
  } catch (err) {
    console.error('Post-save bookkeeping failed (file was saved):', err);
    Toast.show(`${t('toast.operationFailed')}: ${err?.message ?? err}`, 'warning', 4000);
  }
}

/**
 * Prompt for a file location and save there. The document is built and
 * written to the picked handle FIRST; only a successful write binds the
 * handle and renames the project (audit 2026-09-17 M1) — a failed write
 * leaves the previous handle/name untouched instead of adopting a 0-byte file.
 * @returns {Promise<boolean>} true on save, false on picker cancel.
 */
export function saveAs(presetTarget = null) {
  return runExclusiveSave(() => _saveAs(presetTarget));
}

async function _saveAs(presetTarget) {
  const previousName = getState().project.name || 'Untitled';
  const suggested = `${previousName}${FILE_EXT}`;
  // presetTarget = an already-validated `{ref, name}` (automation API: the host
  // resolved the destination, a hidden window must not open a picker).
  const picked = presetTarget ?? await storage.pickSaveProject(suggested);
  if (!picked) return false;
  const name = picked.name.replace(/\.mixo$/i, '');
  const previousId = getState().project.id ?? null;
  const id = mintProjectId();   // a Save As copy is a new document (own autosave identity)
  const attempt = beginSave();
  const doc = await buildDocument();
  doc.project = { ...doc.project, name, id };   // the file carries its own name + id
  await storage.writeFile(picked.ref, JSON.stringify(doc));   // throws → nothing below runs
  _fileRef = picked.ref;
  setState(s => ({ ...s, project: { ...s.project, name, id } }), SILENT);
  await _afterWrite(attempt, picked.ref, previousId);
  return true;
}

/** True when Save has a bound file (otherwise save() would open the Save As picker). */
export function hasSaveTarget() { return _fileRef != null; }

/**
 * Parse .mixo text. JSON errors become a user-readable message instead of a
 * raw SyntaxError (H1); shape/version checks live in loadProject.
 */
function _parseDoc(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Not a .mixo file or the file is corrupt', { cause: err });
  }
}

/** Prompt for a .mixo file and load it (after any save in flight). */
export async function open() {
  await whenSaveIdle();
  assertNoImportInFlight();   // F20: refuse BEFORE the dirty confirm, not after the user answered it
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  const picked = await storage.pickOpenProject();
  if (!picked) return;
  const doc = _parseDoc(await picked.file.text());
  await _loadAndBind(doc, picked.ref);
}

/**
 * Open an already-picked project (`{ref, file}` from `storage.pickOpenProject`)
 * with the same dirty-confirm and load pipeline as {@link open}. The phone
 * viewer (8.6) uses it for its own file input / project list.
 * @param {{ref:any, file:File|Blob}} picked
 */
export async function openPicked(picked) {
  await whenSaveIdle();
  assertNoImportInFlight();
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;
  }
  await _loadAndBind(_parseDoc(await picked.file.text()), picked.ref);
}

// Bind the save target only once the loaded state is coherent. Binding
// BEFORE loadProject meant a torn load (world already reset, then a throw)
// left Ctrl+S pointing at the user's good file with an empty scene — one
// keystroke from overwriting their only copy (audit 2026-09-17, C1).
// The dirty confirm above may have been answered while a Save (queued by the
// "save" answer, or Ctrl+S) was still writing: wait for it again here.
async function _loadAndBind(doc, ref) {
  await whenSaveIdle();
  _fileRef = null;
  await loadProject(doc);
  _fileRef = ref;
}

/** Reset to a blank project (confirm if dirty). */
export async function newProject() {
  await whenSaveIdle();
  assertNoImportInFlight();   // F20: an import mid-flight would mint objects into the blank project
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  await whenSaveIdle();
  historyClear();
  resetWorld();
  _fileRef = null;
  setState(s => ({ ...s, project: { ...s.project, id: mintProjectId(), lastSavedAt: null, listings: [] } }), SILENT);
  // New starts from the user's last-used settings, not raw factory (File-wins
  // applies to OPENING a .mixo, not to New). seedBootState merges the persisted
  // per-user settings onto the fresh factory state; applyToScene pushes the
  // whole look (render/grid/overlays/bed/gizmo/pivot) to the engine.
  SettingsStore.seedBootState();
  SettingsStore.applyToScene();
  SceneManager.setCursorFromState(getState().scene.cursor3d);
  dispatch(EVENTS.PROJECT_NEW, {});
  clearDirty();
  dispatch(EVENTS.PROJECT_SAVED, {});
  Toast.show(t('toast.newProject'), 'info', 2000);
}

/** Open a recent project by its stored entry. */
export async function openRecent(rec) {
  await whenSaveIdle();
  assertNoImportInFlight();   // F20: refuse BEFORE the dirty confirm
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  // The key may still be stored while permission is refused (browser) — tell
  // the two apart so the toast says which one happened.
  if (!rec?.handleKey || !(await storage.hasRef(rec.handleKey))) {
    Toast.show(t('toast.recentHandleLost'), 'error', 4000);
    return;
  }
  const ref = await storage.restoreRef(rec.handleKey);   // re-validates (browser: read permission)
  if (!ref) {
    Toast.show(t('toast.filePermissionDenied'), 'warning', 4000);
    return;
  }
  const file = await storage.readFile(ref);
  await _loadAndBind(_parseDoc(await file.text()), ref);
}

/**
 * Resolve an app-window close through the shared save/discard/cancel vocabulary.
 * @returns {Promise<{action:'save'|'discard'|'cancel', saved?:boolean}>}
 */
export async function requestClose() {
  if (!isDirty()) return { action: 'discard' };
  const choice = await confirmDirty();
  const action = choice === 'save' || choice === 'discard' ? choice : 'cancel';
  if (action !== 'save') return { action };
  const saved = await save();
  return { action: 'save', saved };
}

// NOT frozen — monkey-patching this object is the established headless-test
// seam (same rationale as AssetLoader, bundle-1 plan 2026-06-11).
export const PersistenceManager = {
  init, isDirty, isLoading, isSaving,
  save, saveAs, open, openPicked, newProject, requestClose, hasSaveTarget,
  getRecentProjects, openRecent, relinkAsset,
  startAutosave, stopAutosave, recoverAutosave,
};

// Headless-test surface only. These are pure, browser-API-light helpers that
// carry the milestone-critical invariants (byte-exact embed, asset-resolution
// priority, migration). Not part of the public API — do not call from app code.
export const __test = {
  _b64FromBuf: b64FromBuf, _bufFromB64: bufFromB64, _sha256Hex: sha256Hex, _extOf: extOf,
  _resolveAssetBlob: resolveAssetBlob, _scanDirForHash: scanDirForHash, _fileHandleAtPath: fileHandleAtPath,
  _arrToMap: arrToMap, _migrate: migrate, _resolveLoadedExportRatios: resolveLoadedExportRatios,
  _resolveLoadedExportTargets: resolveLoadedExportTargets,
  _buildDocument: buildDocument, _loadProject: loadProject,
};
