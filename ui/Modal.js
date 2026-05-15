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

let _rootEl   = null;
let _shellEl  = null;
let _current  = null;   // { id, onClose, blocking }

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
  // Replace whatever's currently up.
  if (_current) _close();

  _current = {
    id: payload.id,
    onClose: typeof payload.onClose === 'function' ? payload.onClose : null,
    blocking: !!payload.blocking,
  };

  _shellEl = document.createElement('div');
  _shellEl.className = 'modal-shell';
  _shellEl.setAttribute('role', 'dialog');
  _shellEl.setAttribute('aria-modal', 'true');
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

  // Focus the first interactive element so keyboard users land inside.
  const focusable = _shellEl.querySelector(
    'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
  );
  focusable?.focus?.();
}

function _onKey(e) {
  if (!_current) return;
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

function _close(result) {
  if (!_current) return;
  const cb = _current.onClose;
  _current = null;

  if (_rootEl) {
    _rootEl.classList.add('hidden');
    _rootEl.innerHTML = '';
  }
  _shellEl = null;

  dispatch(EVENTS.MODAL_CLOSE, { result });
  try { cb?.(result); }
  catch (err) { console.error('Modal onClose handler threw:', err); }
}

export const Modal = { init, register, close };
