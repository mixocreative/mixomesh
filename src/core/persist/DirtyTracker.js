// Position-based dirty tracking (Blueprint §5): dirty ⇔ history position
// differs from the position recorded at save/load/new, OR a non-undoable
// mutation fired PROJECT_DIRTY since then (sticky). Command-driven dirty
// events arrive while HistoryManager.isApplying() — the position diff already
// covers those, so they must NOT stick (undo would never read clean otherwise).

import { EVENTS } from '../events.js';
import { dispatch, subscribe } from '../StateManager.js';
import { beginBusy } from '../BusyRegistry.js';
import {
  getPosition as historyPosition,
  isApplying as historyIsApplying,
} from '../HistoryManager.js';

let _dirty         = false;
let _savedPosition = 0;
let _sticky        = false;
let _stickyGen     = 0;       // bumps on every sticky (non-undoable) change
let _saveGen       = 0;       // bumps on every committed file write
let _announcing    = false;   // our own PROJECT_SAVED dispatch must not re-baseline

function _baseline() {
  _savedPosition = historyPosition();
  _sticky = false;
  _dirty = false;
}

function _announceSaved() {
  _announcing = true;
  try { dispatch(EVENTS.PROJECT_SAVED, {}); } finally { _announcing = false; }
}

function _recomputeDirty() {
  const next = _sticky || historyPosition() !== _savedPosition;
  if (next === _dirty) return;
  _dirty = next;
  // Announce the transition so StatusBar/ProjectMenu track undo-driven
  // changes too (undo/redo suppress PROJECT_DIRTY via withoutDirty).
  if (next) dispatch(EVENTS.PROJECT_DIRTY, {}); else _announceSaved();
}

/** @returns {boolean} current dirty state (position-based + sticky). */
export function isDirty() {
  return _dirty;
}

// ── Save attempt ────────────────────────────────────────
// The written document is built from the state at the START of a save, so the
// baseline must be that state, not the state when the bytes landed: an edit
// made while the file was writing is not in the file and keeps the project
// dirty (cia A-01).

/**
 * Capture the baseline for a save, synchronously, right before the document
 * is built from live state.
 * @returns {{position:number, stickyGen:number}}
 */
export function beginSave() {
  return { position: historyPosition(), stickyGen: _stickyGen };
}

/**
 * The bytes for `attempt` are on disk: baseline to the captured state and
 * announce PROJECT_SAVED. Listeners that read isDirty() in that event get
 * the post-save answer whatever their subscription order.
 * @param {{position:number, stickyGen:number}} attempt
 */
export function commitSave(attempt) {
  _savedPosition = attempt.position;
  _sticky = _stickyGen !== attempt.stickyGen;
  _dirty = _sticky || historyPosition() !== _savedPosition;
  _saveGen++;
  _announceSaved();
}

/**
 * Serial of the last committed file write. A snapshot built under one
 * generation is stale once it moves (the file is newer), so the autosave
 * tick drops it instead of offering pre-save content as "recoverable" (A-07).
 */
export function saveGeneration() {
  return _saveGen;
}

/**
 * Force-clean without touching the baseline. save/load/new call this right
 * before dispatching PROJECT_SAVED so the flag is correct even when init()
 * isn't wired (headless __test._loadProject path); with init() wired the
 * PROJECT_SAVED subscription then re-baselines.
 */
export function clearDirty() {
  _dirty = false;
}

/** Blocking save/discard/cancel modal for unsaved changes. */
export function confirmDirty() {
  const end = beginBusy('dialog');
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'dirtyConfirm',
      blocking: true,
      onClose: (r) => { end(); resolve(r || 'cancel'); },
    });
  });
}

// ── Save in flight ──────────────────────────────────────
// One save writes at a time, and nothing replaces the world (open / new /
// recent / recover) while it writes: a load that finished mid-save used to
// rebind the save target, so the old project was written into the file the
// user had just opened (cia A-08).

let _saveInFlight = null;

/**
 * Run `fn` as the one save in flight: it starts after any earlier save settled,
 * and `whenSaveIdle()` waits for it. Rejections reach the caller untouched.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export function runExclusiveSave(fn) {
  const end = beginBusy('save');
  const run = whenSaveIdle().then(fn);
  const settled = run.then(() => {}, () => {}).then(() => {
    end();
    if (_saveInFlight === settled) _saveInFlight = null;
  });
  _saveInFlight = settled;
  return run;
}

/** @returns {boolean} true while a save is building or writing. */
export function isSaving() {
  return _saveInFlight !== null;
}

/** Resolves once no save is in flight (immediately when none is). */
export function whenSaveIdle() {
  return _saveInFlight ?? Promise.resolve();
}

/** Wire dirty tracking. Call once at boot. */
export function init() {
  subscribe(EVENTS.PROJECT_DIRTY, () => {
    if (!historyIsApplying()) { _sticky = true; _stickyGen++; }
    _dirty = true;
  });
  subscribe(EVENTS.PROJECT_SAVED,  () => { if (!_announcing) _baseline(); });
  subscribe(EVENTS.PROJECT_LOADED, _baseline);
  subscribe(EVENTS.PROJECT_NEW,    _baseline);
  subscribe(EVENTS.HISTORY_PUSHED, _recomputeDirty);
  subscribe(EVENTS.HISTORY_UNDONE, _recomputeDirty);
  subscribe(EVENTS.HISTORY_REDONE, _recomputeDirty);
}
