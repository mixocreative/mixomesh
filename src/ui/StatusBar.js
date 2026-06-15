import { EVENTS } from '../core/events.js';
import { subscribe } from '../core/StateManager.js';
import { getUndoLabel, getRedoLabel } from '../core/HistoryManager.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { t } from '../i18n/index.js';

let _elLeft   = null;
let _elCenter = null;
let _elRight  = null;
let _isDirty  = false;
let _leftDefault = true;

function _updateRight() {
  const undoLabel = getUndoLabel();
  const redoLabel = getRedoLabel();

  const undoPart = undoLabel
    ? `<span class="sb-label">${escapeHtml(t('status.undo'))}: <span>${escapeHtml(undoLabel)}</span></span>`
    : `<span class="sb-label" style="color:var(--text-2)">${escapeHtml(t('status.undo'))}: ${escapeHtml(t('status.noneDash'))}</span>`;

  const redoPart = redoLabel
    ? `<span class="sb-label">${escapeHtml(t('status.redo'))}: <span>${escapeHtml(redoLabel)}</span></span>`
    : '';

  const saveClass = _isDirty ? 'dirty' : 'saved';
  const saveIconName = _isDirty ? 'Circle' : 'Check';
  const savePart = `<span class="sb-save-icon ${escapeAttr(saveClass)}">${icon(saveIconName, { width: 12, height: 12 })}</span>`;

  _elRight.innerHTML = `${undoPart}${redoPart ? `<span class="sb-sep">·</span>${redoPart}` : ''}<span class="sb-sep">·</span>${savePart}`;
}

function _onHistoryChange() {
  _updateRight();
}

function _onDirty() {
  _isDirty = true;
  const dirtyEl = document.getElementById('dirty-indicator');
  if (dirtyEl) dirtyEl.classList.add('dirty');
  _updateRight();
}

function _onSaved() {
  _isDirty = false;
  const dirtyEl = document.getElementById('dirty-indicator');
  if (dirtyEl) dirtyEl.classList.remove('dirty');
  _updateRight();
}

/** Initialise the StatusBar. Must be called once after DOM is ready. */
export function init() {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = `
    <div class="sb-left"  id="sb-left"></div>
    <div class="sb-center" id="sb-center"></div>
    <div class="sb-right"  id="sb-right"></div>
  `;
  _elLeft   = document.getElementById('sb-left');
  _elCenter = document.getElementById('sb-center');
  _elRight  = document.getElementById('sb-right');

  _elLeft.textContent = t('status.defaultHint');

  subscribe(EVENTS.HISTORY_PUSHED, _onHistoryChange);
  subscribe(EVENTS.HISTORY_UNDONE, _onHistoryChange);
  subscribe(EVENTS.HISTORY_REDONE, _onHistoryChange);
  subscribe(EVENTS.PROJECT_DIRTY,  _onDirty);
  subscribe(EVENTS.PROJECT_SAVED,  _onSaved);
  subscribe(EVENTS.LOCALE_CHANGED, () => {
    if (_leftDefault) _elLeft.textContent = t('status.defaultHint');
    _updateRight();
  });

  _updateRight();
}

/** Update the center segment with active object info. */
export function setCenter(text) {
  if (_elCenter) _elCenter.textContent = text;
}

/** Update the left segment with current operation hint. */
export function setHint(text) {
  if (_elLeft) {
    _leftDefault = !text;
    _elLeft.textContent = text || t('status.defaultHint');
  }
}

export const StatusBar = { init, setCenter, setHint };
