import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { HistoryManager, RenameProjectCommand } from '../core/HistoryManager.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { reportError } from './Status.js';
import { icon } from '../core/Icons.js';
import { escapeHtml as _esc, escapeAttr, safeImageSrc } from './renderSafe.js';
import { t, applyTranslations } from '../i18n/index.js';
import { tr } from './lib/tr.js';
import { Workspace } from './Workspace.js';

let _recentWrap = null;
let _helpMenu = null;

// ── Init ─────────────────────────────────────────────────

/** Build the header project toolbar + register persistence modals. */
export function init() {
  const header = document.getElementById('header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.className = 'pm-bar';
  bar.innerHTML = `
    <button class="pm-btn pm-btn-primary" id="btn-import" data-act="import" data-i18n-title="project.importTitle">${icon('Download', { width: 14, height: 14 })}<span class="pm-btn-label" data-i18n-key="project.import">Import</span></button>
    <button class="pm-btn" data-act="new"    data-i18n-title="project.newTitle">${icon('FilePlus',   { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="open"   data-i18n-title="project.openTitle">${icon('FolderOpen', { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="save"   data-i18n-title="project.saveTitle">${icon('Save',         { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="saveas" data-i18n-title="project.saveAsTitle">${icon('FilePenLine', { width: 15, height: 15 })}</button>
    <div class="pm-recent">
      <button class="pm-btn" data-act="recent" data-i18n-title="project.recentTitle">${icon('Clock', { width: 15, height: 15 })}</button>
      <div class="pm-recent-list hidden"></div>
    </div>
    <span class="pm-sep" aria-hidden="true"></span>
    <button class="pm-btn" id="btn-undo" data-act="undo" disabled>${icon('RotateCcw', { width: 15, height: 15 })}</button>
    <button class="pm-btn" id="btn-redo" data-act="redo" disabled>${icon('RotateCw', { width: 15, height: 15 })}</button>
    <span class="pm-sep" aria-hidden="true"></span>
    <button class="pm-btn pm-btn-outline" id="btn-export" data-act="export" data-i18n-title="project.exportTitle">${icon('Upload', { width: 14, height: 14 })}<span class="pm-btn-label" data-i18n-key="project.export">Export</span></button>
    <div class="pm-help">
      <button class="pm-btn pm-btn-help" id="btn-help" data-act="help" aria-haspopup="menu" aria-expanded="false" data-i18n-title="project.helpTitle">?</button>
      <div class="pm-help-menu hidden" role="menu">
        <button class="pm-help-item" role="menuitem" data-act="shortcuts" data-i18n-key="project.shortcuts">Keyboard shortcuts</button>
        <button class="pm-help-item pm-help-danger" role="menuitem" data-act="reset-settings" data-i18n-key="project.resetSettings">Reset all settings…</button>
      </div>
    </div>
  `;
  header.appendChild(bar);
  // The locale switcher lives in the bar, just before the ? menu.
  const localeHost = document.getElementById('locale-switcher-host');
  if (localeHost) bar.insertBefore(localeHost, bar.querySelector('.pm-help'));
  _retranslateBar(bar);
  _recentWrap = bar.querySelector('.pm-recent-list');
  _helpMenu = bar.querySelector('.pm-help-menu');

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act !== 'help') _closeHelp();
    if (act === 'import') {
      safeAsync(async () => {
        const { ViewportDrop } = await import('./ViewportDrop.js');
        await ViewportDrop.promptImport();
      });
    }
    if (act === 'undo')   HistoryManager.undo();
    if (act === 'redo')   HistoryManager.redo();
    if (act === 'export') _goToExport();
    if (act === 'help')   _toggleHelp();
    if (act === 'shortcuts') document.dispatchEvent(new CustomEvent('mx:help-sheet'));
    if (act === 'new')    safeAsync(() => PersistenceManager.newProject());
    if (act === 'open')   safeAsync(() => PersistenceManager.open());
    if (act === 'save')   safeAsync(() => _runProjectSave(() => PersistenceManager.save()));
    if (act === 'saveas') safeAsync(() => _runProjectSave(() => PersistenceManager.saveAs()));
    if (act === 'recent') _toggleRecent();
    if (act === 'reset-settings') {
      Modal.open('resetSettingsConfirm', {});
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (_recentWrap && !_recentWrap.classList.contains('hidden')
        && !e.target.closest('.pm-recent')) {
      _recentWrap.classList.add('hidden');
    }
    if (_helpMenu && !_helpMenu.classList.contains('hidden') && !e.target.closest('.pm-help')) {
      _closeHelp();
    }
  }, true);

  _registerModals();
  _wireProjectNameEditor();

  const refresh = () => _refreshName();
  subscribe(EVENTS.PROJECT_LOADED,  refresh);
  subscribe(EVENTS.PROJECT_SAVED,   refresh);
  subscribe(EVENTS.PROJECT_NEW,     refresh);
  subscribe(EVENTS.PROJECT_RENAMED, refresh);
  subscribe(EVENTS.LOCALE_CHANGED, () => { _retranslateBar(bar); _refreshName(); _syncUndoRedo(); });
  for (const ev of [EVENTS.HISTORY_PUSHED, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE,
    EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW]) subscribe(ev, _syncUndoRedo);
  _refreshName();
  _syncUndoRedo();
}

// Static labels carry English text; the fallback keeps them readable until
// their locale keys are merged, then translations take over.
const FALLBACK = {
  'project.import': 'Import',
  'project.importTitle': 'Import a model (Ctrl+I)',
  'project.export': 'Export',
  'project.exportTitle': 'Export for printing',
  'project.helpTitle': 'Help',
  'project.shortcuts': 'Keyboard shortcuts',
  'project.resetSettings': 'Reset all settings…',
};

function _retranslateBar(bar) {
  applyTranslations(bar);
  bar.querySelectorAll('[data-i18n-key],[data-i18n-title]').forEach(el => {
    const k = el.dataset.i18nKey;
    if (k && el.textContent === k) el.textContent = tr(k, FALLBACK[k] ?? k);
    const tk = el.dataset.i18nTitle;
    if (tk && el.getAttribute('title') === tk) el.setAttribute('title', tr(tk, FALLBACK[tk] ?? tk));
  });
  const h = bar.querySelector('#btn-help');
  if (h) h.setAttribute('aria-label', h.getAttribute('title') ?? '');
}

function _syncUndoRedo() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  if (!u || !r) return;
  const ul = HistoryManager.getUndoLabel();
  const rl = HistoryManager.getRedoLabel();
  u.disabled = ul == null;
  r.disabled = rl == null;
  u.title = ul != null ? `${tr('status.undo', 'Undo')}: ${ul} (Ctrl+Z)` : tr('status.nothingToUndo', 'Nothing to undo');
  r.title = rl != null ? `${tr('status.redo', 'Redo')}: ${rl} (Ctrl+Shift+Z)` : tr('status.nothingToRedo', 'Nothing to redo');
  u.setAttribute('aria-label', u.title);
  r.setAttribute('aria-label', r.title);
}

function _toggleHelp() {
  if (!_helpMenu) return;
  const open = _helpMenu.classList.contains('hidden');
  _helpMenu.classList.toggle('hidden', !open);
  document.getElementById('btn-help')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function _closeHelp() {
  _helpMenu?.classList.add('hidden');
  document.getElementById('btn-help')?.setAttribute('aria-expanded', 'false');
}

/** Header Export → Print workspace, Export tab (opens the right column). */
function _goToExport() {
  Workspace.setWorkspace('print');
  if (getState().ui.panelCollapsed?.right === true) Workspace.togglePanel('right');
  const sec = document.getElementById('rp-print');
  if (sec?.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    sec.querySelector('.rp-section-header')?.setAttribute('aria-expanded', 'true');
  }
  document.querySelector('#rp-print .pp-tab[data-tab="export"]')?.click();
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

async function _runProjectSave(saveFn) {
  try {
    await saveFn();
  } catch (err) {
    if (err?.portableIssues?.length) {
      Modal.open('portableSaveBlocked', { issues: err.portableIssues });
      return;
    }
    reportError(err, { title: t('toast.errorTitle'), modal: true });
  }
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

  Modal.register('portableSaveBlocked', ({ data, close }) => {
    const issues = data?.issues ?? [];
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(t('project.portableSaveBlockedTitle'))}</h2>
      <p class="pm-modal-body">${_esc(t('project.portableSaveBlockedBody'))}</p>
      <div class="pm-asset-list">
        ${_renderPortableIssueRows(issues)}
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

  // Generic confirm (Decision 9 delete-locked, reusable): data = { title, body,
  // confirmLabel, danger }; closes with 'confirm' | 'cancel'.
  Modal.register('confirmAction', ({ data, close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(data?.title ?? '')}</h2>
      <p class="pm-modal-body">${_esc(data?.body ?? '')}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">${_esc(data?.cancelLabel ?? t('btn.cancel'))}</button>
        <button class="btn ${data?.danger ? 'btn-danger' : 'btn-primary'}" data-r="confirm">${_esc(data?.confirmLabel ?? t('btn.ok'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => close(b.dataset.r)));
    // `focusConfirm`: the primary is the default (Enter) — Modal focuses the
    // first button synchronously after render, so move focus on the microtask.
    if (data?.focusConfirm) {
      queueMicrotask(() => /** @type {HTMLElement|null} */ (el.querySelector('[data-r="confirm"]'))?.focus());
    }
    return el;
  });

  Modal.register('resetSettingsConfirm', ({ close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_esc(t('project.resetSettingsConfirmTitle'))}</h2>
      <p class="pm-modal-body">${_esc(t('project.resetSettingsConfirmBody'))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">${_esc(t('btn.cancel'))}</button>
        <button class="btn btn-danger" data-r="confirm">${_esc(t('project.resetSettingsConfirm'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => {
        if (b.dataset.r === 'confirm') {
          SettingsStore.resetAll();
          Toast.show(t('toast.settingsReset'), 'info', 2000);
        }
        close(b.dataset.r);
      }));
    return el;
  });
}

function _renderPortableIssueRows(issues) {
  return issues.map(issue => {
    const name = issue.filename || issue.assetId || t('project.missingAsset');
    const usage = t('project.portableSaveAssetUsage', { n: issue.requiredBy?.length ?? 0 });
    const relink = issue.assetId
      ? `<button class="btn btn-sm" data-relink="${escapeAttr(issue.assetId)}">${_esc(t('project.relink'))}</button>`
      : '';
    return `
      <div class="pm-asset-row" data-id="${escapeAttr(issue.assetId ?? '')}">
        <span class="pm-asset-meta">
          <span class="pm-asset-name">${_esc(name)}</span>
          <span class="pm-asset-usage">${_esc(usage)}</span>
        </span>
        ${relink}
      </div>`;
  }).join('');
}

export const ProjectMenu = { init };
