// Position-based dirty tracking (Blueprint §5): dirty ⇔ history position
// differs from the position recorded at save/load/new, OR a non-undoable
// mutation fired PROJECT_DIRTY since then (sticky). Command-driven dirty
// events arrive while HistoryManager.isApplying() — the position diff already
// covers those, so they must NOT stick (undo would never read clean otherwise).

import { EVENTS } from '../events.js';
import { dispatch, subscribe } from '../StateManager.js';
import {
  getPosition as historyPosition,
  isApplying as historyIsApplying,
} from '../HistoryManager.js';

let _dirty         = false;
let _savedPosition = 0;
let _sticky        = false;

function _baseline() {
  _savedPosition = historyPosition();
  _sticky = false;
  _dirty = false;
}

function _recomputeDirty() {
  const next = _sticky || historyPosition() !== _savedPosition;
  if (next === _dirty) return;
  _dirty = next;
  // Announce the transition so StatusBar/ProjectMenu track undo-driven
  // changes too (undo/redo suppress PROJECT_DIRTY via withoutDirty).
  dispatch(next ? EVENTS.PROJECT_DIRTY : EVENTS.PROJECT_SAVED, {});
}

/** @returns {boolean} current dirty state (position-based + sticky). */
export function isDirty() {
  return _dirty;
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
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'dirtyConfirm',
      blocking: true,
      onClose: (r) => resolve(r || 'cancel'),
    });
  });
}

/** Wire dirty tracking. Call once at boot. */
export function init() {
  subscribe(EVENTS.PROJECT_DIRTY, () => {
    if (!historyIsApplying()) _sticky = true;
    _dirty = true;
  });
  subscribe(EVENTS.PROJECT_SAVED,  _baseline);
  subscribe(EVENTS.PROJECT_LOADED, _baseline);
  subscribe(EVENTS.PROJECT_NEW,    _baseline);
  subscribe(EVENTS.HISTORY_PUSHED, _recomputeDirty);
  subscribe(EVENTS.HISTORY_UNDONE, _recomputeDirty);
  subscribe(EVENTS.HISTORY_REDONE, _recomputeDirty);
}
