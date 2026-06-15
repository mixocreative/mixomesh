import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { HistoryManager, RenameProjectCommand } from '../core/HistoryManager.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';
import { escapeHtml as _esc, escapeAttr, safeImageSrc } from './renderSafe.js';
import { t, applyTranslations } from '../i18n/index.js';

let _recentWrap = null;

// ── Init ─────────────────────────────────────────────────

/** Build the header project toolbar + register persistence modals. */
export function init() {
  const header = document.getElementById('header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.className = 'pm-bar';
  bar.innerHTML = `
    <button class="pm-btn" data-act="new"    data-i18n-title="project.newTitle">${icon('FilePlus',   { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="open"   data-i18n-title="project.openTitle">${icon('FolderOpen', { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="save"   data-i18n-title="project.saveTitle">${icon('Save',         { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="saveas" data-i18n-title="project.saveAsTitle">${icon('FilePenLine', { width: 15, height: 15 })}</button>
    <div class="pm-recent">
      <button class="pm-btn" data-act="recent" data-i18n-title="project.recentTitle">${icon('Clock', { width: 15, height: 15 })}</button>
      <div class="pm-recent-list hidden"></div>
    </div>
    <button class="pm-btn pm-btn-reset" data-act="reset-settings" data-i18n-title="project.resetSettingsTitle">${icon('RotateCcw', { width: 15, height: 15 })}</button>
  `;
  header.appendChild(bar);
  applyTranslations(bar);
  _recentWrap = bar.querySelector('.pm-recent-list');

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'new')    safeAsync(() => PersistenceManager.newProject());
    if (act === 'open')   safeAsync(() => PersistenceManager.open());
    if (act === 'save')   safeAsync(() => PersistenceManager.save());
    if (act === 'saveas') safeAsync(() => PersistenceManager.saveAs());
    if (act === 'recent') _toggleRecent();
    if (act === 'reset-settings') {
      SettingsStore.resetAll();
      Toast.show(t('toast.settingsReset'), 'info', 2000);
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (_recentWrap && !_recentWrap.classList.contains('hidden')
        && !e.target.closest('.pm-recent')) {
      _recentWrap.classList.add('hidden');
    }
  }, true);

  _registerModals();
  _wireProjectNameEditor();

  const refresh = () => _refreshName();
  subscribe(EVENTS.PROJECT_LOADED,  refresh);
  subscribe(EVENTS.PROJECT_SAVED,   refresh);
  subscribe(EVENTS.PROJECT_NEW,     refresh);
  subscribe(EVENTS.PROJECT_RENAMED, refresh);
  subscribe(EVENTS.LOCALE_CHANGED, () => { applyTranslations(bar); _refreshName(); });
  _refreshName();
}

function _refreshName() {
  const el = document.getElementById('project-name');
  if (!el || el.dataset.editing === '1') return;   // don't clobber an open editor
  el.textContent = getState().project.name || t('project.untitled');
  el.title = t('project.renameTitle');
}

/**
 * Inline-edit the project name on click. Commit on Enter or blur, cancel
 * on Escape. Empty / whitespace-only input cancels. The commit goes through
 * `RenameProjectCommand` so it's undoable and marks the project dirty —
 * exports will then default to the new name (see §12 *Export filenames*).
 */
function _wireProjectNameEditor() {
  const el = document.getElementById('project-name');
  if (!el) return;
  el.title = t('project.renameTitle');
  el.tabIndex = 0;

  const open = () => {
    if (el.dataset.editing === '1') return;
    const current = getState().project.name || t('project.untitled');
    el.dataset.editing = '1';
    el.textContent = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pm-name-input';
    input.value = current;
    input.maxLength = 80;
    el.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const next = input.value.trim();
      el.dataset.editing = '';
      el.textContent = getState().project.name || t('project.untitled');
      if (next && next !== current) {
        HistoryManager.push(new RenameProjectCommand(current, next));
      }
    };
    const cancel = () => {
      if (done) return; done = true;
      el.dataset.editing = '';
      el.textContent = getState().project.name || t('project.untitled');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')      { e.preventDefault(); commit(); }
      else if (e.key === 'Escape'){ e.preventDefault(); cancel(); }
      e.stopPropagation();        // don't leak hotkeys to viewport (undo etc.)
    });
    input.addEventListener('blur', commit);
  };

  el.addEventListener('click',   open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
}

async function _toggleRecent() {
  if (!_recentWrap) return;
  if (!_recentWrap.classList.contains('hidden')) {
    _recentWrap.classList.add('hidden');
    return;
  }
  const list = await PersistenceManager.getRecentProjects();
  if (!list.length) {
    _recentWrap.innerHTML = `<div class="pm-recent-empty">${_esc(t('project.noRecent'))}</div>`;
  } else {
    _recentWrap.innerHTML = list.map((r, i) => {
      const thumbSrc = safeImageSrc(r.thumbnailDataUrl);
      return `
        <button class="pm-recent-item" data-idx="${i}">
          ${thumbSrc
          ? `<img class="pm-recent-thumb" src="${thumbSrc}" alt="">`
          : `<span class="pm-recent-thumb pm-recent-thumb-blank">${icon('Box', { width: 16, height: 16 })}</span>`}
          <span class="pm-recent-meta">
            <span class="pm-recent-name">${_esc(r.name)}</span>
            <span class="pm-recent-date">${new Date(r.savedAt).toLocaleString()}</span>
          </span>
        </button>
      `;
    }).join('');
    _recentWrap.querySelectorAll('.pm-recent-item').forEach(el => {
      el.addEventListener('click', () => {
        _recentWrap.classList.add('hidden');
        safeAsync(() => PersistenceManager.openRecent(list[+el.dataset.idx]));
      });
    });
  }
  _recentWrap.classList.remove('hidden');
}

// ── Modal renderers ──────────────────────────────────────

function _registerModals() {
  Modal.register('dirtyConfirm', ({ close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(t('project.unsavedTitle'))}</h2>
      <p class="pm-modal-body">${_esc(t('project.unsavedBody'))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">${_esc(t('btn.cancel'))}</button>
        <button class="btn btn-danger" data-r="discard">${_esc(t('project.discard'))}</button>
        <button class="btn btn-primary" data-r="save">${_esc(t('btn.save'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });

  Modal.register('recoverAutosave', ({ data, close }) => {
    const when = data?.savedAt ? new Date(data.savedAt).toLocaleString() : t('project.unknownTime');
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(t('project.recoverTitle'))}</h2>
      <p class="pm-modal-body">${_esc(t('project.recoverBodyBefore'))} <strong>${_esc(when)}</strong> ${_esc(t('project.recoverBodyAfter'))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="discard">${_esc(t('project.discard'))}</button>
        <button class="btn btn-primary" data-r="recover">${_esc(t('project.recover'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });

  Modal.register('unmatchedAssets', ({ data, close }) => {
    const assets = data?.assets ?? [];
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(t('project.unmatchedAssetsTitle'))}</h2>
      <p class="pm-modal-body">${_esc(t('project.unmatchedAssetsBody', { n: assets.length }))}</p>
      <div class="pm-asset-list">
        ${assets.map(a => `
          <div class="pm-asset-row" data-id="${escapeAttr(a.id)}">
            <span class="pm-asset-name">${_esc(a.filename || a.name)}</span>
            <button class="btn btn-sm" data-relink="${escapeAttr(a.id)}">${_esc(t('project.relink'))}</button>
          </div>`).join('')}
      </div>
      <div class="pm-modal-actions">
        <button class="btn btn-primary" data-r="ok">${_esc(t('btn.close'))}</button>
      </div>`;
    el.querySelector('[data-r="ok"]').addEventListener('click', () => close('ok'));
    el.querySelectorAll('[data-relink]').forEach(b =>
      b.addEventListener('click', () => {
        const row = b.closest('.pm-asset-row');
        safeAsync(async () => {
          await PersistenceManager.relinkAsset(b.dataset.relink);
          row?.remove();
          if (!el.querySelectorAll('.pm-asset-row').length) close('ok');
        });
      }));
    return el;
  });
}

export const ProjectMenu = { init };
