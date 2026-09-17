// Persistence façade — thin surface over ./persist/* (house pattern:
// AssetLoader over ./assets/*, PrintManager over ./print/*). Save-side
// document assembly lives in persist/ProjectSerializer.js, tiered asset
// resolution in persist/AssetResolver.js, the load pipeline + relink in
// persist/ProjectLoader.js, recents in persist/RecentProjects.js, autosave in
// persist/Autosave.js, dirty tracking in persist/DirtyTracker.js. This module
// owns only the file-handle lifecycle (save / saveAs / open / newProject /
// openRecent) and re-exports the public API + headless-test surface.

import { EVENTS } from './events.js';
import { getState, setState, dispatch } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { SettingsStore } from './SettingsStore.js';
import { clear as historyClear } from './HistoryManager.js';
import { Toast } from '../ui/Toast.js';
import { t } from '../i18n/index.js';
import { kvDelete, getFileHandle } from './idb.js';
import { sha256Hex } from './hash.js';
import { FILE_EXT, FILE_TYPES, AUTOSAVE_PREFIX, SILENT } from './persist/constants.js';
import { b64FromBuf, bufFromB64, extOf, buildDocument } from './persist/ProjectSerializer.js';
import { resolveAssetBlob, scanDirForHash, fileHandleAtPath } from './persist/AssetResolver.js';
import {
  loadProject, resetWorld, relinkAsset, isLoading, assertNoImportInFlight,
  migrate, resolveLoadedExportRatios, arrToMap,
} from './persist/ProjectLoader.js';
import { pushRecent, getRecentProjects } from './persist/RecentProjects.js';
import { startAutosave, stopAutosave, recoverAutosave } from './persist/Autosave.js';
import { isDirty, clearDirty, confirmDirty, init } from './persist/DirtyTracker.js';

// ── Re-exported surface (unchanged for callers/tests) ────────────────────

export { relinkAsset, getRecentProjects, isLoading };
export { startAutosave, stopAutosave, recoverAutosave };
export { isDirty, init };

// Module-local — not persisted.
let _fileHandle = null;     // FileSystemFileHandle of the open .mixo

// ── Public API ───────────────────────────────────────────

/**
 * Write to the currently-open file, or prompt if none.
 * @returns {Promise<boolean>} true when bytes hit disk; false when the user
 *   cancelled the save picker. Callers in "save then continue" flows MUST
 *   abort on false — proceeding discards the project the user asked to keep
 *   (review H9).
 */
export async function save() {
  if (!_fileHandle) return saveAs();
  const text = JSON.stringify(await buildDocument());
  await _writeTo(_fileHandle, text);
  await _afterWrite();
  return true;
}

async function _writeTo(handle, text) {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

// Post-write bookkeeping shared by save / saveAs: runs only once bytes are on
// disk. `staleName` = the project name before a saveAs rename, whose autosave
// key is now stale too.
async function _afterWrite(staleName = null) {
  setState(s => ({ ...s, project: { ...s.project, lastSavedAt: new Date().toISOString() } }), SILENT);
  clearDirty();
  dispatch(EVENTS.PROJECT_SAVED, {});
  const name = getState().project.name;
  await pushRecent(name, _fileHandle);
  await kvDelete(`${AUTOSAVE_PREFIX}${name}`);
  if (staleName && staleName !== name) await kvDelete(`${AUTOSAVE_PREFIX}${staleName}`);
  Toast.show(t('toast.projectSaved'), 'success', 2000);
}

/**
 * Prompt for a file location and save there. The document is built and
 * written to the picked handle FIRST; only a successful write binds the
 * handle and renames the project (audit 2026-09-17 M1) — a failed write
 * leaves the previous handle/name untouched instead of adopting a 0-byte file.
 * @returns {Promise<boolean>} true on save, false on picker cancel.
 */
export async function saveAs() {
  const previousName = getState().project.name || 'Untitled';
  const suggested = `${previousName}${FILE_EXT}`;
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    throw err;
  }
  const name = handle.name.replace(/\.mixo$/i, '');
  const doc = await buildDocument();
  doc.project = { ...doc.project, name };   // the file carries its own name
  await _writeTo(handle, JSON.stringify(doc));   // throws → nothing below runs
  _fileHandle = handle;
  setState(s => ({ ...s, project: { ...s.project, name } }), SILENT);
  await _afterWrite(previousName);
  return true;
}

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

/** Prompt for a .mixo file and load it. */
export async function open() {
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  const file = await handle.getFile();
  const doc  = _parseDoc(await file.text());
  await _loadAndBind(doc, handle);
}

// Bind the save target only once the loaded state is coherent. Binding
// BEFORE loadProject meant a torn load (world already reset, then a throw)
// left Ctrl+S pointing at the user's good file with an empty scene — one
// keystroke from overwriting their only copy (audit 2026-09-17, C1).
async function _loadAndBind(doc, handle) {
  _fileHandle = null;
  await loadProject(doc);
  _fileHandle = handle;
}

/** Reset to a blank project (confirm if dirty). */
export async function newProject() {
  assertNoImportInFlight();   // F20: an import mid-flight would mint objects into the blank project
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  historyClear();
  resetWorld();
  _fileHandle = null;
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
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  const handle = await getFileHandle(rec.handleKey);
  if (!handle) { Toast.show(t('toast.recentHandleLost'), 'error', 4000); return; }
  if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
    Toast.show(t('toast.filePermissionDenied'), 'warning', 4000);
    return;
  }
  const file = await handle.getFile();
  await _loadAndBind(_parseDoc(await file.text()), handle);
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
  init, isDirty, isLoading,
  save, saveAs, open, newProject, requestClose,
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
  _buildDocument: buildDocument, _loadProject: loadProject,
};
