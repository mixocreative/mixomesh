import { EVENTS } from '../core/events.js';
import { subscribe, dispatch } from '../core/StateManager.js';

// id → renderer function. Each phase registers its own renderers; this module
// only knows how to mount/unmount them and route keyboard / backdrop dismissals.
//
// Renderer contract:
//   render({ data, close }) => HTMLElement | DocumentFragment | string
//     data   — the payload dispatched with MODAL_OPEN.
//     close  — call with an optional result to dismiss + resolve.
//   The renderer wires its own internal event handlers and calls close(result)
//   when the user confirms / cancels.
const _renderers = new Map();
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let _rootEl   = null;
let _shellEl  = null;
let _current  = null;   // { id, onClose, blocking, previousFocus }
let _titleSeq = 0;

// ── Init ─────────────────────────────────────────────────

/** Mount the modal overlay into <body>. Call once at boot. */
export function init() {
  _rootEl = document.getElementById('modal-root');
  if (!_rootEl) {
    _rootEl = document.createElement('div');
    _rootEl.id = 'modal-root';
    _rootEl.className = 'modal-overlay hidden';
    document.body.appendChild(_rootEl);
  }
  _rootEl.addEventListener('click', _onBackdrop);

  // Capture-phase Escape so we win against viewport input handlers when open.
  document.addEventListener('keydown', _onKey, true);

  subscribe(EVENTS.MODAL_OPEN, _onOpen);
}

/**
 * Register a renderer for a modal id. Idempotent — re-registering an id
 * replaces the previous renderer.
 * @param {string} id        Modal id ('shaderMerge', 'dirtyConfirm', …)
 * @param {function} renderFn  ({ data, close }) => HTMLElement | string
 */
export function register(id, renderFn) {
  _renderers.set(id, renderFn);
}

/**
 * Convenience opener — dispatches MODAL_OPEN for a registered id.
 * @param {string} id
 * @param {object} [payload]  merged into the modal data (may include onClose)
 */
export function open(id, payload = {}) {
  dispatch(EVENTS.MODAL_OPEN, { id, ...payload });
}

/** Programmatically close the active modal (same effect as ESC). */
export function close(result) {
  _close(result);
}

// ── Internal ─────────────────────────────────────────────

function _onOpen(payload) {
  if (!payload?.id) return;
  const renderer = _renderers.get(payload.id);
  if (!renderer) {
    console.error(`Modal: no renderer registered for "${payload.id}"`);
    return;
  }
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  // Replace whatever's currently up.
  if (_current) _close(undefined, { restoreFocus: false });

  _current = {
    id: payload.id,
    onClose: typeof payload.onClose === 'function' ? payload.onClose : null,
    blocking: !!payload.blocking,
    previousFocus,
  };

  _shellEl = document.createElement('div');
  _shellEl.className = 'modal-shell';
  _shellEl.setAttribute('role', 'dialog');
  _shellEl.setAttribute('aria-modal', 'true');
  _shellEl.tabIndex = -1;
  _shellEl.addEventListener('click', _stopPropagation);

  const node = renderer({
    data: payload,
    close: _close,
  });
  if (node == null) {
    _shellEl.innerHTML = '';
  } else if (typeof node === 'string') {
    _shellEl.innerHTML = node;
  } else {
    _shellEl.appendChild(node);
  }

  _rootEl.innerHTML = '';
  _rootEl.appendChild(_shellEl);
  _rootEl.classList.remove('hidden');
  _syncAccessibleName(payload);

  // Focus the first interactive element so keyboard users land inside.
  const [focusable] = _focusableElements();
  (focusable ?? _shellEl).focus?.({ preventScroll: true });
}

function _onKey(e) {
  if (!_current) return;
  if (e.key === 'Tab') {
    _trapFocus(e);
    return;
  }
  if (e.key === 'Escape' && !_current.blocking) {
    e.preventDefault();
    e.stopPropagation();
    _close();
  }
}

function _onBackdrop(e) {
  if (!_current) return;
  if (e.target !== _rootEl) return;          // click landed inside the shell
  if (_current.blocking) return;
  _close();
}

function _stopPropagation(e) { e.stopPropagation(); }

function _close(result, opts = {}) {
  if (!_current) return;
  const restoreFocus = opts.restoreFocus !== false;
  const cb = _current.onClose;
  const previousFocus = _current.previousFocus;
  _current = null;

  if (_rootEl) {
    _rootEl.classList.add('hidden');
    _rootEl.innerHTML = '';
  }
  _shellEl = null;

  dispatch(EVENTS.MODAL_CLOSE, { result });
  try { cb?.(result); }
  catch (err) { console.error('Modal onClose handler threw:', err); }
  if (restoreFocus && previousFocus?.isConnected) {
    requestAnimationFrame(() => previousFocus.focus?.({ preventScroll: true }));
  }
}

function _syncAccessibleName(payload) {
  if (!_shellEl) return;
  if (_shellEl.hasAttribute('aria-label') || _shellEl.hasAttribute('aria-labelledby')) return;
  const title = _shellEl.querySelector('.modal-title, .pm-modal-title, h1, h2, h3');
  if (title?.textContent?.trim()) {
    if (!title.id) title.id = `modal-title-${_safeId(payload.id)}-${++_titleSeq}`;
    _shellEl.setAttribute('aria-labelledby', title.id);
    return;
  }
  _shellEl.setAttribute('aria-label', String(payload.label || payload.title || payload.id));
}

function _trapFocus(e) {
  if (!_shellEl) return;
  const focusable = _focusableElements();
  if (!focusable.length) {
    e.preventDefault();
    _shellEl.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!_shellEl.contains(active)) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
  e.stopPropagation();
}

function _focusableElements() {
  if (!_shellEl) return [];
  return [..._shellEl.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(el => !el.hasAttribute('disabled') && _isVisible(el));
}

function _isVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function _safeId(value) {
  return String(value ?? 'modal').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

export const Modal = { init, register, open, close };
