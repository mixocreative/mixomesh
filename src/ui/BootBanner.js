// Boot banner (task 4.7, Decision 4): ONE slim, non-blocking strip above the
// header that replaces the sequential boot modals (re-mount folder → recover
// autosave). It offers "Re-mount folder <name>" and/or "Recover unsaved work
// from HH:MM", plus Dismiss. Nothing happens until the user clicks: the
// button click is the gesture a browser folder re-grant needs, and the app is
// fully usable while the banner is up.
import { EVENTS } from '../core/events.js';
import { subscribe } from '../core/StateManager.js';
import { t } from '../i18n/index.js';
import { icon } from '../core/Icons.js';
import { safeAsync } from './Toast.js';
import { AssetPanel } from './AssetPanel.js';
import { findRecoverableAutosave, recoverAutosave } from '../core/persist/Autosave.js';
import { isDirty, confirmDirty } from '../core/persist/DirtyTracker.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';

const BANNER_ID = 'boot-banner';
const OPEN_CLASS = 'has-boot-banner';

let _el = null;
let _offers = { remount: null, recover: null };
let _busy = false;
let _localeSub = false;

/** "14:02" today, otherwise a short date + time. */
export function formatSavedAt(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function _html() {
  const { remount, recover } = _offers;
  const parts = [];
  if (remount) {
    parts.push(`<span class="bb-item" data-bb="remount">${_escape(t('boot.remountBefore'))} <strong class="bb-name">${_escape(remount.name)}</strong></span>`);
  }
  if (recover) {
    const when = formatSavedAt(recover.savedAt);
    const title = t('boot.recoverTitle', { when: new Date(recover.savedAt).toLocaleString() });
    parts.push(`<span class="bb-item" data-bb="recover" title="${escapeAttr(title)}">${_escape(t('boot.recoverBefore'))} <time class="bb-time" datetime="${escapeAttr(recover.savedAt)}">${_escape(when)}</time>${recover.name ? ` <span class="bb-project">${_escape(t('boot.recoverIn', { name: recover.name }))}</span>` : ''}</span>`);
  }
  const sep = '<span class="bb-sep" aria-hidden="true">·</span>';
  return `
    <span class="bb-icon" aria-hidden="true">${icon('Clock', { width: 14, height: 14 })}</span>
    <span class="bb-lead">${_escape(t('boot.welcome'))}</span>
    ${sep}
    <span class="bb-items">${parts.join(sep)}</span>
    <span class="bb-actions">
      ${remount ? `<button class="btn btn-sm bb-btn" type="button" data-act="remount">${icon('FolderOpen', { width: 13, height: 13 })}<span>${_escape(t('boot.remount'))}</span></button>` : ''}
      ${recover ? `<button class="btn btn-sm btn-primary bb-btn" type="button" data-act="recover">${icon('RotateCcw', { width: 13, height: 13 })}<span>${_escape(t('boot.recover'))}</span></button>` : ''}
      <button class="bb-dismiss" type="button" data-act="dismiss" aria-label="${escapeAttr(t('boot.dismiss'))}" title="${escapeAttr(t('boot.dismissTitle'))}">×</button>
    </span>`;
}

function _render() {
  if (!_offers.remount && !_offers.recover) { hide(); return; }
  if (!_el) {
    _el = document.createElement('div');
    _el.id = BANNER_ID;
    _el.className = 'boot-banner';
    _el.setAttribute('role', 'region');
    _el.addEventListener('click', _onClick);
    const app = document.getElementById('app');
    if (app?.parentNode) app.parentNode.insertBefore(_el, app);
    else document.body.prepend(_el);
  }
  _el.setAttribute('aria-label', t('boot.regionLabel'));
  _el.innerHTML = _html();
  document.body.classList.add(OPEN_CLASS);
}

function _onClick(e) {
  const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-act]'));
  if (!btn || _busy) return;
  const act = btn.dataset.act;
  if (act === 'dismiss') { hide(); return; }
  safeAsync(async () => {
    _busy = true;
    try {
      if (act === 'remount') await _doRemount();
      else if (act === 'recover') await _doRecover();
    } finally {
      _busy = false;
      _render();
    }
  });
}

async function _doRemount() {
  const offer = _offers.remount;
  if (!offer) return true;
  const ok = await AssetPanel.remountLast(offer);
  if (ok) _offers.remount = null;
  return ok;
}

async function _doRecover() {
  const offer = _offers.recover;
  if (!offer) return;
  // Recovery resolves handle-backed assets through the mounted folder (the
  // autosave skips their bytes, A9) — so re-mount first, inside this same
  // click gesture, when that offer is still open.
  if (_offers.remount) await _doRemount();
  // Recovery replaces the open project: work done since boot gets the usual
  // save / discard / cancel question.
  if (isDirty()) {
    const choice = await confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await PersistenceManager.save())) return;
  }
  _offers.recover = null;
  await recoverAutosave(offer);
}

/**
 * Show the banner for the given offers (either may be null; both null = no
 * banner). Returns the banner element, or null when nothing is offered.
 * @param {{ remount?: {key:string,name:string}|null,
 *           recover?: {key:string,projectId:string,savedAt:string,name?:string}|null }} offers
 * @returns {HTMLElement|null}
 */
export function show({ remount = null, recover = null } = {}) {
  _offers = { remount, recover };
  if (!_localeSub) {
    _localeSub = true;
    subscribe(EVENTS.LOCALE_CHANGED, () => { if (_el) _render(); });
  }
  _render();
  return _el;
}

/** Remove the banner. The autosave is kept: it is offered again next launch. */
export function hide() {
  _offers = { remount: null, recover: null };
  _el?.remove();
  _el = null;
  document.body.classList.remove(OPEN_CLASS);
}

/**
 * Boot entry (main.ts): look up the last-folder re-mount offer and the newest
 * recoverable autosave, then show one banner. Never opens a modal.
 */
export async function runBootChecks() {
  const [remount, recover] = await Promise.all([
    AssetPanel.findRemountOffer().catch(() => null),
    findRecoverableAutosave().catch(() => null),
  ]);
  return show({ remount, recover });
}

export const BootBanner = { show, hide, runBootChecks, formatSavedAt };
