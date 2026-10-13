// One Sources modal (task 4.6): every asset in the project with its Source
// status (Embedded copy · Linked · Changed on disk · Missing), where it comes
// from, and the per-row + bulk recovery actions (Refresh, Find moved file…,
// Relink…). Replaces the role of the old relink-list modals as the place the
// user goes to fix sources; the asset card ⋯ menu opens it via "Show in
// Sources". Also owns the status vocabulary the asset cards render.
import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { t } from '../i18n/index.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { runFindMoved } from './FindMoved.js';
import { icon } from '../core/Icons.js';
import { getAssetStatus, canFindMoved, sourcesOf } from '../core/persist/AssetResolver.js';
import { relinkAsset, refreshAsset } from '../core/persist/ProjectLoader.js';
import { displayNameParts } from '../core/assets/DisplayNames.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';

const MODAL_ID = 'assetSources';
/** UI source words, in display order. */
export const SOURCE_STATUSES = Object.freeze(['embedded', 'linked', 'changed', 'missing']);

/**
 * The Source status a user sees for an asset:
 *   ghost (no bytes anywhere)         → 'missing'
 *   last load/relink resolution       → 'linked' | 'changed' | 'missing' | 'embedded'
 *   never resolved this session       → 'linked' when it has a source link, else 'embedded'
 * @param {object} asset  assetLibrary entry
 * @returns {'embedded'|'linked'|'changed'|'missing'}
 */
export function sourceStatus(asset) {
  if (!asset) return 'missing';
  if (asset.isGhost) return 'missing';
  const st = getAssetStatus(asset.id);
  if (st && SOURCE_STATUSES.includes(st)) return /** @type {any} */ (st);
  return sourcesOf(asset).length ? 'linked' : 'embedded';
}

/** Chip markup for a status (shared by asset cards and the Sources list). */
export function statusChipHtml(status, extraClass = '') {
  const linkIcon = status === 'linked' ? icon('Link', { width: 11, height: 11 }) : '';
  return `<span class="src-chip is-${escapeAttr(status)} ${escapeAttr(extraClass)}" data-source-status="${escapeAttr(status)}" title="${escapeAttr(t(`asset.status.${status}Title`))}">${linkIcon}<span>${_escape(t(`asset.status.${status}`))}</span></span>`;
}

function _whereText(asset, status) {
  if (asset.isGhost) return t('asset.sources.noBytes');
  const src = sourcesOf(asset)[0];
  if (!src) return t('asset.sources.savedInProject');
  const label = src.kind === 'folder' && src.label && src.label !== asset.filename ? `${src.label}/` : '';
  return status === 'missing'
    ? t('asset.sources.wasAt', { path: `${label}${src.path ?? ''}` })
    : `${label}${src.path ?? ''}`;
}

function _rows(library) {
  const order = { missing: 0, changed: 1, linked: 2, embedded: 3 };
  return Object.values(library)
    .map(asset => ({ asset, status: sourceStatus(asset), parts: displayNameParts(asset, library) }))
    .sort((a, b) => (order[a.status] - order[b.status])
      || String(a.parts?.text ?? a.asset.filename).localeCompare(String(b.parts?.text ?? b.asset.filename)));
}

function _rowHtml({ asset, status, parts }, focusId) {
  const kind = asset.kind ?? 'mesh';
  const name = parts?.label ?? asset.displayName ?? asset.filename ?? asset.id;
  const qualifier = parts?.qualifier ? `<span class="sm-qualifier">${_escape(parts.qualifier)}</span>` : '';
  const actions = [
    status === 'changed' || status === 'linked'
      ? `<button class="btn btn-sm" type="button" data-act="refresh" data-id="${escapeAttr(asset.id)}">${_escape(t('asset.menu.refresh'))}</button>` : '',
    canFindMoved(asset.id)
      ? `<button class="btn btn-sm" type="button" data-act="find" data-id="${escapeAttr(asset.id)}">${_escape(t('asset.findMoved.action'))}</button>` : '',
    kind === 'mesh'
      ? `<button class="btn btn-sm" type="button" data-act="relink" data-id="${escapeAttr(asset.id)}">${_escape(t('project.relink'))}</button>` : '',
  ].join('');
  return `
    <div class="sm-row${asset.id === focusId ? ' is-focus' : ''}" role="listitem" data-id="${escapeAttr(asset.id)}" data-status="${escapeAttr(status)}">
      <div class="sm-name" title="${escapeAttr(parts?.tooltip ?? name)}"><span class="sm-label">${_escape(name)}</span>${qualifier}</div>
      ${statusChipHtml(status, 'sm-chip')}
      <div class="sm-where" title="${escapeAttr(_whereText(asset, status))}">${_escape(_whereText(asset, status))}</div>
      <div class="sm-actions">${actions}</div>
    </div>`;
}

function _render(el, focusId) {
  const library = getState().scene.assetLibrary ?? {};
  const rows = _rows(library);
  const counts = { embedded: 0, linked: 0, changed: 0, missing: 0 };
  for (const r of rows) counts[r.status]++;
  const findable = rows.filter(r => canFindMoved(r.asset.id));
  const relinkable = rows.filter(r => r.status === 'missing' && (r.asset.kind ?? 'mesh') === 'mesh');

  el.querySelector('.sm-summary').innerHTML = SOURCE_STATUSES
    .filter(s => counts[s])
    .map(s => `<span class="sm-count is-${s}"><span class="sm-num">${counts[s]}</span> ${_escape(t(`asset.status.${s}`))}</span>`)
    .join('<span class="sm-dot" aria-hidden="true">·</span>')
    || _escape(t('asset.sources.empty'));

  const findBtn = /** @type {HTMLButtonElement} */ (el.querySelector('[data-bulk="find"]'));
  const relinkBtn = /** @type {HTMLButtonElement} */ (el.querySelector('[data-bulk="relink"]'));
  findBtn.disabled = !findable.length;
  findBtn.textContent = t('asset.sources.findAll', { n: findable.length });
  relinkBtn.disabled = !relinkable.length;
  relinkBtn.textContent = t('asset.sources.relinkMissing', { n: relinkable.length });

  el.querySelector('.sm-list').innerHTML = rows.length
    ? rows.map(r => _rowHtml(r, focusId)).join('')
    : `<div class="sm-empty">${_escape(t('asset.sources.empty'))}</div>`;
}

/** Relink each missing mesh in turn; stops when the user cancels a picker. */
async function _relinkMissing() {
  const ids = Object.values(getState().scene.assetLibrary ?? {})
    .filter(a => sourceStatus(a) === 'missing' && (a.kind ?? 'mesh') === 'mesh')
    .map(a => a.id);
  for (const id of ids) {
    const before = getState().scene.assetLibrary[id];
    await relinkAsset(id);
    if (getState().scene.assetLibrary[id] === before) break;   // picker cancelled
  }
}

async function _findAll() {
  const ids = Object.values(getState().scene.assetLibrary ?? {})
    .filter(a => canFindMoved(a.id)).map(a => a.id);
  for (const id of ids) await runFindMoved(id);
}

/** Register the Sources modal. Call once (AssetPanel.init). */
export function init() {
  Modal.register(MODAL_ID, ({ data, close }) => {
    const focusId = data?.focusAssetId ?? null;
    const el = document.createElement('div');
    el.className = 'pm-modal sm-modal';
    el.innerHTML = `
      <div class="sm-head">
        <h2 class="pm-modal-title">${_escape(t('asset.sources.title'))}</h2>
        <button class="dup-close" type="button" data-r="close" aria-label="${escapeAttr(t('btn.close'))}" title="${escapeAttr(t('btn.close'))}">×</button>
      </div>
      <p class="sm-intro">${_escape(t('asset.sources.intro'))}</p>
      <div class="sm-toolbar">
        <div class="sm-summary" aria-live="polite"></div>
        <div class="sm-bulk">
          <button class="btn btn-sm" type="button" data-bulk="find"></button>
          <button class="btn btn-sm" type="button" data-bulk="relink"></button>
        </div>
      </div>
      <div class="sm-list" role="list"></div>
      <div class="pm-modal-actions">
        <button class="btn btn-primary" type="button" data-r="ok">${_escape(t('btn.close'))}</button>
      </div>`;
    _render(el, focusId);

    // Esc / backdrop close bypasses `done`: a listener that finds the modal
    // detached unsubscribes itself.
    const rerender = () => {
      if (el.isConnected) _render(el, focusId);
      else offs.forEach(off => off?.());
    };
    const offs = [
      subscribe(EVENTS.ASSET_RELINKED, rerender),
      subscribe(EVENTS.ASSET_REMOVED, rerender),
      subscribe(EVENTS.ASSET_REGISTERED, rerender),
    ];
    const done = (r) => { offs.forEach(off => off?.()); close(r); };
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => done('ok')));
    el.querySelector('[data-bulk="find"]').addEventListener('click', () => safeAsync(_findAll));
    el.querySelector('[data-bulk="relink"]').addEventListener('click', () => safeAsync(_relinkMissing));
    el.querySelector('.sm-list').addEventListener('click', (e) => {
      const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-act]'));
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'find') runFindMoved(id);
      else if (b.dataset.act === 'relink') safeAsync(() => relinkAsset(id));
      else if (b.dataset.act === 'refresh') {
        safeAsync(async () => {
          if (!(await refreshAsset(id))) Toast.show(t('asset.menu.refreshFailed'), 'warning', 4000);
        });
      }
    });
    if (focusId) {
      queueMicrotask(() => el.querySelector('.sm-row.is-focus')?.scrollIntoView?.({ block: 'nearest' }));
    }
    return el;
  });
}

/** Open the Sources modal, optionally highlighting one asset. */
export function open({ focusAssetId = null } = {}) {
  Modal.open(MODAL_ID, { focusAssetId });
}

export const SourcesModal = { init, open, sourceStatus, statusChipHtml };
