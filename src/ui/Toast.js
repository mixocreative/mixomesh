import { EVENTS } from '../core/events.js';
import { subscribe } from '../core/StateManager.js';
import { icon } from '../core/Icons.js';

const MAX_TOASTS = 4;
const TYPE_ICONS = {
  info:    'Info',
  success: 'CheckCircle',
  warning: 'AlertTriangle',
  error:   'XCircle',
  loading: 'Loader2',
};

let _container = null;
const _active = new Map(); // id → { el, timerId }

let _idCounter = 0;
function _nextId() { return `toast_${++_idCounter}`; }

function _render(id, message, type, onClick) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.dataset.id = id;
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.innerHTML = icon(TYPE_ICONS[type] ?? 'Info');
  const msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = message;
  el.append(iconEl, msgEl);
  if (typeof onClick === 'function') {
    el.classList.add('toast-clickable');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const activate = () => { dismiss(id); onClick(); };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  }
  return el;
}

/**
 * Dismiss every toast carrying `tag` (see show()'s opts.tag). Used to retire
 * a stale per-object validation toast the moment that object is validated
 * again — a "2 warning(s) — click to Auto-Fix" toast must not outlive the
 * repair it offers (owner feedback 2026-09-18: four of them stacked up after
 * Repair all had already fixed everything).
 * @param {string} tag
 */
export function dismissTag(tag) {
  if (!tag) return;
  for (const [id, entry] of _active) if (entry.tag === tag) dismiss(id);
}

function _evict() {
  if (_active.size < MAX_TOASTS) return;
  const oldest = _active.keys().next().value;
  dismiss(oldest);
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'|'loading'} [type]
 * @param {number} [duration]  ms; 0 = persistent; loading type is always persistent
 * @param {{ onClick?: () => void, tag?: string }} [opts]  onClick makes the toast a button:
 *   click / Enter / Space dismisses it then runs the handler (B5 click-through);
 *   tag groups toasts for dismissTag()
 * @returns {string} toast id (pass to dismiss())
 */
export function show(message, type = 'info', duration = 4000, opts = {}) {
  if (!_container) return '';
  _evict();

  const id = _nextId();
  const el = _render(id, message, type, opts.onClick);
  _container.appendChild(el);

  const autoDismiss = type !== 'loading' && duration > 0;
  const timerId = autoDismiss ? setTimeout(() => dismiss(id), duration) : null;
  _active.set(id, { el, timerId, tag: opts.tag ?? null });
  return id;
}

/**
 * Dismiss a toast by id.
 * @param {string} id
 */
export function dismiss(id) {
  const entry = _active.get(id);
  if (!entry) return;
  const { el, timerId } = entry;
  if (timerId) clearTimeout(timerId);
  _active.delete(id);
  el.classList.add('toast-out');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

/** Initialise the Toast system. Must be called once after DOM is ready. */
export function init() {
  _container = document.getElementById('toast-container');
  subscribe(EVENTS.TOAST, ({ message, type = 'info', duration = 4000 }) => {
    show(message, type, duration);
  });
  // A fresh validation result supersedes any per-object validation toast
  // still on screen (the validator re-runs after every repair).
  subscribe(EVENTS.VALIDATION_COMPLETE, ({ meshId }) => { if (meshId) dismissTag(validationTag(meshId)); });
}

/** Tag for the per-object validation toasts (import auto-validate). */
export function validationTag(meshId) { return `validation:${meshId}`; }

export const Toast = { init, show, dismiss, dismissTag, validationTag };

// `safeAsync` moved to ./Status.js (centralized error/loading policy). Import it
// from there; this re-export keeps older import paths working.
export { safeAsync } from './Status.js';
