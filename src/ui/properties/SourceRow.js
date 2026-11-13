// The Properties panel's Source row: where an object's file came from, whether that file is still
// reachable, and the three recovery actions (refresh, find moved, relink).
//
// One job: say the truth about an asset's link to disk, and offer the way back when it is broken.
// That is the whole reason this row is not cosmetic -- a project whose assets have moved is a
// project that silently loads wrong, and this row is the only place the operator sees it.
//
// Cut out of PropertiesPanel.js on 2026-11-14, following the `refinement/RefinementSection.js`
// pattern: render builds HTML and touches no DOM, wire takes the root element and a `rerender`
// callback. The callback is there because every recovery action changes state the whole panel
// reads, and passing it in keeps this module from importing the panel back.

import { getState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon } from '../../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from '../renderSafe.js';
import { canFindMoved, getAssetStatus, sourcesOf } from '../../core/persist/AssetResolver.js';
import { qualifiedDisplayName } from '../../core/assets/DisplayNames.js';
import { refreshAsset } from '../../core/persist/ProjectLoader.js';
import { PersistenceManager } from '../../core/PersistenceManager.js';
import { runFindMoved } from '../FindMoved.js';
import { Status } from '../Status.js';
import { Toast } from '../Toast.js';

const SOURCE_STATUS_KEYS = {
  embedded: 'properties.sourceStatus.embedded',
  linked:   'properties.sourceStatus.linked',
  changed:  'properties.sourceStatus.changed',
  missing:  'properties.sourceStatus.missing',
};

/**
 * The status the Source chip shows: the per-session resolution status when
 * the asset was resolved at load; a ghost is always missing; otherwise a
 * fresh import is "linked" when it carries a link, else an embedded copy.
 * @param {object} obj
 * @param {object} asset
 * @returns {'embedded'|'linked'|'changed'|'missing'}
 */
export function sourceStatusFor(obj, asset) {
  if (obj?.isGhost) return 'missing';
  const st = asset ? getAssetStatus(asset.id) : null;
  if (st && SOURCE_STATUS_KEYS[st]) return st;
  return asset && sourcesOf(asset).length ? 'linked' : 'embedded';
}

export function renderSourceRow(obj, asset) {
  const status = sourceStatusFor(obj, asset);
  const name = qualifiedDisplayName(asset, getState().scene.assetLibrary) || asset.filename || '';
  const hasLink = sourcesOf(asset).length > 0;
  const findOk = canFindMoved(asset.id);
  return `
    <div class="pp-row pp-source-row" data-source-status="${escapeAttr(status)}">
      <label>${_escape(t('properties.source'))}</label>
      <div class="pp-source">
        <span class="pp-source-chip pp-source-${escapeAttr(status)}">${_escape(t(SOURCE_STATUS_KEYS[status]))}</span>
        <span class="pp-source-name" title="${escapeAttr(name)}">${_escape(name)}</span>
        <button type="button" class="pp-source-more" data-source-menu aria-haspopup="menu" aria-expanded="false"
                title="${escapeAttr(t('properties.sourceMenu'))}" aria-label="${escapeAttr(t('properties.sourceMenu'))}">${icon('MoreHorizontal', { width: 14, height: 14 })}</button>
        <div class="pp-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-source-action="refresh"${hasLink ? '' : ' disabled'}>${_escape(t('properties.sourceRefresh'))}</button>
          <button type="button" role="menuitem" data-source-action="find"${findOk ? '' : ' disabled'}>${_escape(t('asset.findMoved.action'))}</button>
          <button type="button" role="menuitem" data-source-action="relink">${_escape(t('properties.sourceRelink'))}</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * @param {HTMLElement} root the panel body
 * @param {object} asset
 * @param {() => void} rerender re-render the whole panel (every action changes shared state)
 */
export function wireSourceRow(root, asset, rerender) {
  const btn = root.querySelector('[data-source-menu]');
  const menu = btn?.parentElement?.querySelector('.pp-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menu.querySelector('button:not([disabled])')?.focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSourceMenu(root); btn.focus(); }
  });
  menu.querySelectorAll('[data-source-action]').forEach(item => {
    item.addEventListener('click', () => {
      closeSourceMenu(root);
      _runSourceAction(item.dataset.sourceAction, asset.id, rerender);
    });
  });
}

function _runSourceAction(action, assetId, rerender) {
  if (action === 'find') {
    Status.guard(async () => { if (await runFindMoved(assetId)) rerender(); });
    return;
  }
  if (action === 'refresh') {
    Status.guard(async () => {
      const ok = await refreshAsset(assetId);
      if (!ok) Toast.show(t('properties.sourceRefreshFailed'), 'warning');
      rerender();
    }, { title: t('properties.sourceRefresh') });
    return;
  }
  if (action === 'relink') {
    Status.guard(async () => { await PersistenceManager.relinkAsset(assetId); rerender(); },
      { title: t('properties.sourceRelink') });
  }
}

/** @param {HTMLElement|null} root */
export function closeSourceMenu(root) {
  const menu = root?.querySelector('.pp-source .pp-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  root.querySelector('[data-source-menu]')?.setAttribute('aria-expanded', 'false');
}

/**
 * Dismiss the menu on a click anywhere outside it. Registered ONCE, by the panel's init, and
 * never removed -- the panel lives for the session. It is installed here rather than in the panel
 * so the whole dismiss concern (open, Escape, outside-click) sits in one file; a dismiss path that
 * lives somewhere else is how a menu ends up with two ways to close and one way to get stuck.
 * @param {() => HTMLElement|null} rootOf reads the panel body lazily: init runs before it exists
 */
export function installSourceMenuDismiss(rootOf) {
  document.addEventListener('pointerdown', (e) => {
    const root = rootOf();
    const wrap = root?.querySelector('.pp-source');
    if (wrap && !wrap.contains(e.target)) closeSourceMenu(root);
  }, true);
}
