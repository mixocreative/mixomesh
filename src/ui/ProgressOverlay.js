// Full-screen blocking progress overlay. While an export runs the UI is
// darkened and pointer-locked so the user can't mutate the scene mid-pipeline.

import { t } from '../i18n/index.js';

let _root = null;
let _bar = null;
let _pct = null;
let _msg = null;
let _title = null;
let _cancelBtn = null;
let _visible = false;
let _onCancel = null;     // set only while a cancellable run is showing
let _cancelling = false;

function _cancel() {
  if (!_onCancel || _cancelling) return;
  _cancelling = true;
  const fn = _onCancel;
  if (_cancelBtn) _cancelBtn.disabled = true;
  if (_msg) _msg.textContent = t('progress.cancelling');
  try { fn(); } catch (err) { console.error('ProgressOverlay onCancel threw:', err); }
}

function _blockWhileVisible(e) {
  if (!_visible) return;
  if (_onCancel) {
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
 * Show the overlay.
 * @param {string} title
 * @param {{ onCancel?: () => void, controller?: AbortController }} [opts]
 *   Optional: when onCancel (or an AbortController) is given, a Cancel button
 *   appears and Esc cancels too. The overlay then reads "Cancelling…" until
 *   the caller calls hide().
 */
export function show(title = t('progress.working'), opts = {}) {
  _ensure();
  _title.textContent = title;
  const cb = typeof opts?.onCancel === 'function' ? opts.onCancel
    : (opts?.controller && typeof opts.controller.abort === 'function'
      ? () => opts.controller.abort() : null);
  _onCancel = cb;
  _cancelling = false;
  if (_cancelBtn) {
    _cancelBtn.hidden = !cb;
    _cancelBtn.disabled = false;
    _cancelBtn.textContent = t('btn.cancel');
  }
  update(0, t('progress.starting'));
  _visible = true;
  _root.classList.remove('hidden');
}

/**
 * @param {number} frac 0..1
 * @param {string} [message]
 */
export function update(frac, message) {
  if (!_root) return;
  const p = Math.max(0, Math.min(100, Math.round(frac * 100)));
  _bar.style.width = `${p}%`;
  _pct.textContent = `${p}%`;
  if (message != null && !_cancelling) _msg.textContent = message;
}

export function hide() {
  _visible = false;
  _onCancel = null;
  _cancelling = false;
  if (_root) _root.classList.add('hidden');
}

export const ProgressOverlay = { show, update, hide };
