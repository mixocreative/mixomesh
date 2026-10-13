import { EVENTS } from '../core/events.js';
import { subscribe } from '../core/StateManager.js';
import { tr } from './lib/tr.js';
import { escapeHtml } from './renderSafe.js';

/**
 * First-run coach (overhaul 5.5): four anchored bubbles with Next / Back /
 * Skip tour. Shown once per browser profile (`mx-onboard-v1`), replayable from
 * ? ▸ Tour. The layer never blocks the app — only the bubble takes pointer
 * events — and every step is dismissible with Skip tour or Esc.
 */
export const ONBOARD_KEY = 'mx-onboard-v1';

const STEPS = [
  { id: 'import', anchor: '#btn-import', place: 'below',
    title: ['onboard.import.title', 'Import a model to start'],
    body: ['onboard.import.body', 'Drop 3D files into the viewport, or use Import. glTF, OBJ, STL and 3MF work.'] },
  { id: 'select', anchor: '#viewport', place: 'center',
    title: ['onboard.select.title', 'Click to select, double-click to enter a group'],
    body: ['onboard.select.body', 'A click selects a whole object or group. Double-click a group to step inside it; Esc steps back out.'] },
  { id: 'printer', anchor: '.ws-btn[data-ws="print"]', place: 'below',
    title: ['onboard.printer.title', 'Pick your printer'],
    body: ['onboard.printer.body', 'Open Print, then Printer. Your printer sets sensible export defaults you can still override.'] },
  { id: 'export', anchor: '#btn-export', place: 'below',
    title: ['onboard.export.title', 'Export for printing'],
    body: ['onboard.export.body', 'Check the readiness strip, then export. Nothing is written until you choose where to save it.'] },
];

let _root = null;
let _bubble = null;
let _step = 0;
let _target = null;
let _open = false;

function _seen() {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch { return false; }
}
function _markSeen() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* private mode — non-fatal */ }
}

/** Mount the layer; auto-start on a fresh profile. Call once at boot. */
export function init() {
  if (_root) return;
  _root = document.createElement('div');
  _root.id = 'onboard-root';
  _root.className = 'onboard-layer hidden';
  document.body.appendChild(_root);
  window.addEventListener('resize', _position);
  subscribe(EVENTS.LOCALE_CHANGED, () => { if (_open) _render(); });
  if (!_seen()) setTimeout(() => { if (!_open && !_seen()) start(); }, 800);
}

/** Start (or restart) the tour from step 1. */
export function start() {
  if (!_root) init();
  _step = 0;
  _open = true;
  _root.classList.remove('hidden');
  _render();
}

/** Close the tour and remember it was seen. */
export function close() {
  _open = false;
  _markSeen();
  _clearTarget();
  _root?.classList.add('hidden');
  if (_root) _root.innerHTML = '';
  _bubble = null;
}

export function isOpen() { return _open; }

function _clearTarget() {
  _target?.classList.remove('ob-target');
  _target = null;
}

function _render() {
  const s = STEPS[_step];
  const last = _step === STEPS.length - 1;
  _clearTarget();
  _target = document.querySelector(s.anchor);
  if (_target && s.place !== 'center') _target.classList.add('ob-target');
  const stepLabel = tr('onboard.step', 'Step {n} of {total}', { n: _step + 1, total: STEPS.length })
    .replace('{n}', String(_step + 1)).replace('{total}', String(STEPS.length));
  _root.innerHTML = `
    <div class="ob-bubble" role="dialog" aria-label="${escapeHtml(tr('onboard.aria', 'First-run tour'))}" data-place="${s.place}">
      <span class="ob-arrow" aria-hidden="true"></span>
      <div class="ob-head">
        <span class="ob-step">${escapeHtml(stepLabel)}</span>
        <span class="ob-kicker">${escapeHtml(tr('onboard.kicker', 'First-run tour'))}</span>
      </div>
      <h3 class="ob-title">${escapeHtml(tr(s.title[0], s.title[1]))}</h3>
      <p class="ob-body">${escapeHtml(tr(s.body[0], s.body[1]))}</p>
      <div class="ob-foot">
        <button type="button" class="ob-skip" data-ob="skip">${escapeHtml(tr('onboard.skip', 'Skip tour'))}</button>
        <span class="ob-nav">
          ${_step > 0 ? `<button type="button" class="btn ob-back" data-ob="back">${escapeHtml(tr('onboard.back', 'Back'))}</button>` : ''}
          <button type="button" class="btn btn-primary ob-next" data-ob="next">${escapeHtml(last ? tr('onboard.done', 'Done') : tr('onboard.next', 'Next'))}</button>
        </span>
      </div>
    </div>`;
  _bubble = _root.querySelector('.ob-bubble');
  _bubble.addEventListener('click', (e) => {
    const act = e.target.closest('[data-ob]')?.dataset.ob;
    if (act === 'skip') close();
    else if (act === 'back' && _step > 0) { _step--; _render(); }
    else if (act === 'next') { if (last) close(); else { _step++; _render(); } }
  });
  _bubble.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  _position();
  _bubble.querySelector('.ob-next')?.focus({ preventScroll: true });
}

function _position() {
  if (!_open || !_bubble) return;
  const s = STEPS[_step];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = _bubble.offsetWidth;
  const bh = _bubble.offsetHeight;
  const gap = 12;
  const pad = 8;
  const r = _target?.getBoundingClientRect();
  let left;
  let top;
  let arrowX = null;
  if (!r || s.place === 'center') {
    const vr = r ?? { left: 0, top: 0, width: vw, height: vh };
    left = vr.left + (vr.width - bw) / 2;
    top = vr.top + (vr.height - bh) / 2;
  } else {
    left = r.left + r.width / 2 - bw / 2;
    top = r.bottom + gap;
  }
  left = Math.min(Math.max(pad, left), Math.max(pad, vw - bw - pad));
  top = Math.min(Math.max(pad, top), Math.max(pad, vh - bh - pad));
  if (r && s.place !== 'center') arrowX = Math.min(Math.max(14, r.left + r.width / 2 - left), bw - 14);
  _bubble.style.left = `${Math.round(left)}px`;
  _bubble.style.top = `${Math.round(top)}px`;
  _bubble.style.setProperty('--ob-arrow-x', arrowX == null ? '-999px' : `${Math.round(arrowX)}px`);
}

export const Onboarding = { init, start, close, isOpen };
