import { EVENTS } from '../core/events.js';
import { subscribe } from '../core/StateManager.js';
import { getUndoLabel, getRedoLabel, undo, redo } from '../core/HistoryManager.js';
import { isDirty } from '../core/persist/DirtyTracker.js';
import { autosaveStatus, AUTOSAVE_FAILED_EVENT } from '../core/persist/AutosaveKeys.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { t } from '../i18n/index.js';

let _elLeft   = null;
let _elCenter = null;
let _elRight  = null;
let _isDirty  = false;
let _leftDefault = true;

// Autosave liveness (B-02): the last snapshot time, or a persistent warning
// while snapshots fail or keep being skipped. One toast is easy to dismiss;
// this stays until the next snapshot succeeds.
function _autosavePart() {
  const s = autosaveStatus();
  if (s.state === 'written') {
    const when = new Date(s.lastWrittenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<span class="sb-label sb-autosave">${escapeHtml(t('status.autosaved', { when }))}</span>`;
  }
  if (s.state === 'failing') {
    const text = t('status.autosaveFailed', { n: s.failures, reason: s.lastError ?? '' });
    return `<span class="sb-label sb-autosave hud-warn" title="${escapeAttr(text)}">${escapeHtml(text)}</span>`;
  }
  if (s.state === 'paused') {
    const text = t(s.reason === 'slow' ? 'status.autosavePausedSlow' : 'status.autosavePausedBusy');
    return `<span class="sb-label sb-autosave hud-warn" title="${escapeAttr(text)}">${escapeHtml(text)}</span>`;
  }
  return '';
}

function _updateRight() {
  const undoLabel = getUndoLabel();
  const redoLabel = getRedoLabel();
  const canUndo = undoLabel !== null;
  const canRedo = redoLabel !== null;

  const undoPart = undoLabel
    ? `<span class="sb-label">${escapeHtml(t('status.undo'))}: <span>${escapeHtml(undoLabel)}</span></span>`
    : `<span class="sb-label" style="color:var(--text-2)">${escapeHtml(t('status.undo'))}: ${escapeHtml(t('status.noneDash'))}</span>`;

  const redoPart = redoLabel
    ? `<span class="sb-label">${escapeHtml(t('status.redo'))}: <span>${escapeHtml(redoLabel)}</span></span>`
    : '';

  const saveClass = _isDirty ? 'dirty' : 'saved';
  const saveIconName = _isDirty ? 'Circle' : 'Check';
  const savePart = `<span class="sb-save-icon ${escapeAttr(saveClass)}">${icon(saveIconName, { width: 12, height: 12 })}</span>`;
  const autosavePart = _autosavePart();

  const undoTitle = canUndo ? `${t('status.undo')}: ${undoLabel} (Ctrl+Z)` : t('status.nothingToUndo');
  const redoTitle = canRedo ? `${t('status.redo')}: ${redoLabel} (Ctrl+Shift+Z)` : t('status.nothingToRedo');

  _elRight.innerHTML = `
    <button id="status-undo" class="sb-btn" ${canUndo ? '' : 'disabled'} title="${escapeAttr(undoTitle)}">${icon('RotateCcw', { width: 14, height: 14 })}</button>
    <button id="status-redo" class="sb-btn" ${canRedo ? '' : 'disabled'} title="${escapeAttr(redoTitle)}">${icon('RotateCw', { width: 14, height: 14 })}</button>
    <span class="sb-sep">·</span>
    ${undoPart}${redoPart ? `<span class="sb-sep">·</span>${redoPart}` : ''}<span class="sb-sep">·</span>${savePart}${autosavePart ? `<span class="sb-sep">·</span>${autosavePart}` : ''}
  `;

  _elRight.querySelector('#status-undo')?.addEventListener('click', e => { e.stopPropagation(); undo(); });
  _elRight.querySelector('#status-redo')?.addEventListener('click', e => { e.stopPropagation(); redo(); });
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

// PROJECT_SAVED means bytes reached disk, not that nothing changed since:
// an edit made while the file was writing keeps the project dirty (A-01).
function _onSaved() {
  _isDirty = isDirty();
  const dirtyEl = document.getElementById('dirty-indicator');
  if (dirtyEl) dirtyEl.classList.toggle('dirty', _isDirty);
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
  subscribe(EVENTS.AUTOSAVE_WRITTEN, _updateRight);
  subscribe(AUTOSAVE_FAILED_EVENT,   _updateRight);
  subscribe(EVENTS.LOCALE_CHANGED, () => {
    if (_leftDefault) _elLeft.textContent = t('status.defaultHint');
    _updateRight();
  });

  _updateRight();
}

/**
 * Update the center segment with active object info.
 * @param {string} text
 * @param {{ className?: string, title?: string }} [opts]
 *   `className` toggles a single extra class (e.g. `hud-warn` / `hud-danger`)
 *   — any previous one of those is removed first, classes only, never inline
 *   styles. `title` sets the tooltip (e.g. the triangle-budget explainer).
 */
export function setCenter(text, opts = {}) {
  if (!_elCenter) return;
  _elCenter.textContent = text;
  _elCenter.classList.remove('hud-warn', 'hud-danger');
  if (opts.className) _elCenter.classList.add(opts.className);
  _elCenter.title = opts.title ?? '';
  // Optional inline action (e.g. "Fix" next to "not watertight") — a real
  // button so it is keyboard-reachable; the text stays plain textContent.
  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sb-action';
    btn.textContent = opts.action.label;
    if (opts.action.title) btn.title = opts.action.title;
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.action.onClick?.(); });
    _elCenter.appendChild(btn);
  }
}

/** Update the left segment with current operation hint. */
export function setHint(text) {
  if (_elLeft) {
    _leftDefault = !text;
    _elLeft.textContent = text || t('status.defaultHint');
  }
}

export const StatusBar = { init, setCenter, setHint };
