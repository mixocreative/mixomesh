// Full-screen blocking progress overlay. While an export runs the UI is
// darkened and pointer-locked so the user can't mutate the scene mid-pipeline.
//
// Every blocking operation owns a session (`open()` → `{ update, close }`).
// The newest shown session is drawn and its Cancel is the one Esc / the button
// reach; closing it brings the one underneath back, so an import that ends
// mid-export never unlocks the scene or drops the export's Cancel (cia B-08).

import { t } from '../i18n/index.js';

let _root = null;
let _bar = null;
let _pct = null;
let _msg = null;
let _title = null;
let _cancelBtn = null;
let _visible = false;
const _sessions = [];     // open sessions, oldest first

/** The session on screen: the newest one that is shown. */
function _top() {
  for (let i = _sessions.length - 1; i >= 0; i--) if (_sessions[i].shown) return _sessions[i];
  return null;
}

function _render() {
  const s = _top();
  // A closed session lingering for its minimum visible time is only a picture:
  // its work is over, so it never swallows input.
  _visible = !!s && !s.closed;
  if (!s) { if (_root) _root.classList.add('hidden'); return; }
  _ensure();
  _root.style.pointerEvents = s.closed ? 'none' : '';
  _title.textContent = s.title;
  if (_cancelBtn) {
    _cancelBtn.hidden = !s.onCancel;
    _cancelBtn.disabled = s.cancelling;
    _cancelBtn.textContent = t('btn.cancel');
  }
  const p = Math.max(0, Math.min(100, Math.round(s.frac * 100)));
  _bar.style.width = `${p}%`;
  _pct.textContent = `${p}%`;
  _msg.textContent = s.cancelling ? t('progress.cancelling') : s.message;
  _root.classList.remove('hidden');
}

function _cancel() {
  const s = _top();
  if (!s?.onCancel || s.cancelling) return;
  s.cancelling = true;
  _render();
  try { s.onCancel(); } catch (err) { console.error('ProgressOverlay onCancel threw:', err); }
}

function _blockWhileVisible(e) {
  if (!_visible) return;
  if (_top()?.onCancel) {
    // Capture-phase blocking would starve the button's own handler, so the
    // Cancel click and Esc are routed here before the event is swallowed.
    if (e.type === 'keydown' && (e.key === 'Escape'
        || ((e.key === 'Enter' || e.key === ' ') && e.target === _cancelBtn))) _cancel();
    else if (e.type === 'click' && _cancelBtn && e.target === _cancelBtn) _cancel();
  }
  e.stopPropagation();
  e.preventDefault();
}

function _ensure() {
  if (_root) return;
  _root = document.getElementById('progress-root') ?? document.createElement('div');
  _root.id = 'progress-root';
  _root.className = 'progress-overlay hidden';
  _root.innerHTML = `
    <div class="po-panel" role="status" aria-live="polite">
      <div class="po-title"></div>
      <div class="po-track"><div class="po-bar"></div></div>
      <div class="po-row"><span class="po-pct">0%</span><span class="po-msg"></span></div>
      <button type="button" class="po-cancel" hidden></button>
    </div>`;
  // Swallow every interaction while visible (capture phase).
  for (const ev of ['pointerdown', 'pointerup', 'click', 'wheel', 'keydown', 'contextmenu']) {
    _root.addEventListener(ev, _blockWhileVisible, true);
  }
  // Keyboard events target the focused element, not this overlay sibling. A
  // document-level capture guard is what actually blocks viewport shortcuts.
  document.addEventListener('keydown', _blockWhileVisible, true);
  document.addEventListener('keyup', _blockWhileVisible, true);
  document.addEventListener('keypress', _blockWhileVisible, true);
  if (!_root.parentElement) document.body.appendChild(_root);
  _bar   = _root.querySelector('.po-bar');
  _pct   = _root.querySelector('.po-pct');
  _msg   = _root.querySelector('.po-msg');
  _title = _root.querySelector('.po-title');
  _cancelBtn = _root.querySelector('.po-cancel');
}

/**
 * @typedef {object} OverlaySession
 * @property {(frac: number, message?: string) => void} update  frac 0..1
 * @property {() => void} close  idempotent
 */

/**
 * Open a blocking overlay session owned by the caller.
 * @param {string} [title]
 * @param {{ onCancel?: () => void, controller?: AbortController,
 *           delayMs?: number, minVisibleMs?: number }} [opts]
 *   `onCancel` / `controller`: a Cancel button appears and Esc cancels; the
 *   session then reads "Cancelling…" until closed. `delayMs`: shown only after
 *   this long (fast work never flashes it); `minVisibleMs`: once shown, it stays
 *   at least this long after close().
 * @returns {OverlaySession}
 */
export function open(title = t('progress.working'), opts = {}) {
  const onCancel = typeof opts?.onCancel === 'function' ? opts.onCancel
    : (typeof opts?.controller?.abort === 'function' ? () => opts.controller.abort() : null);
  const delayMs = opts?.delayMs ?? 0;
  const minVisibleMs = opts?.minVisibleMs ?? 0;
  const s = { title, onCancel, cancelling: false, frac: 0, message: t('progress.starting'), shown: false, shownAt: 0, closed: false };
  let timer = null;
  const remove = () => {
    const i = _sessions.indexOf(s);
    if (i >= 0) _sessions.splice(i, 1);
    _render();
  };
  const reveal = () => { timer = null; s.shown = true; s.shownAt = Date.now(); _render(); };
  _sessions.push(s);
  if (delayMs > 0) timer = setTimeout(reveal, delayMs); else reveal();
  return {
    update(frac, message) {
      s.frac = frac;
      if (message != null) s.message = message;
      if (_top() === s) _render();
    },
    close() {
      if (s.closed) return;
      s.closed = true;
      s.onCancel = null;
      if (timer) { clearTimeout(timer); timer = null; }
      // Linger only when nothing else keeps the overlay up.
      const alone = !_sessions.some(o => o !== s && o.shown);
      const left = s.shown && alone ? minVisibleMs - (Date.now() - s.shownAt) : 0;
      if (left > 0) { setTimeout(remove, left); _render(); } else remove();
    },
  };
}

export const ProgressOverlay = { open };
