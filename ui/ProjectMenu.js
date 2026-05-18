import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { HistoryManager, RenameProjectCommand } from '../core/HistoryManager.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';

let _recentWrap = null;

// ── Init ─────────────────────────────────────────────────

/** Build the header project toolbar + register persistence modals. */
export function init() {
  const header = document.getElementById('header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.className = 'pm-bar';
  bar.innerHTML = `
    <button class="pm-btn" data-act="new"    title="New project (Ctrl+N)">${icon('FilePlus',   { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="open"   title="Open project (Ctrl+O)">${icon('FolderOpen', { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="save"   title="Save (Ctrl+S)">${icon('Save',         { width: 15, height: 15 })}</button>
    <button class="pm-btn" data-act="saveas" title="Save As (Ctrl+Shift+S)">${icon('Copy',   { width: 15, height: 15 })}</button>
    <div class="pm-recent">
      <button class="pm-btn" data-act="recent" title="Recent projects">${icon('Clock', { width: 15, height: 15 })}</button>
      <div class="pm-recent-list hidden"></div>
    </div>
  `;
  header.appendChild(bar);
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
  _refreshName();
}

function _refreshName() {
  const el = document.getElementById('project-name');
  if (!el || el.dataset.editing === '1') return;   // don't clobber an open editor
  el.textContent = getState().project.name || 'Untitled';
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
  el.title = 'Click to rename project';
  el.tabIndex = 0;

  const open = () => {
    if (el.dataset.editing === '1') return;
    const current = getState().project.name || 'Untitled';
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
      el.textContent = getState().project.name || 'Untitled';
      if (next && next !== current) {
        HistoryManager.push(new RenameProjectCommand(current, next));
      }
    };
    const cancel = () => {
      if (done) return; done = true;
      el.dataset.editing = '';
      el.textContent = getState().project.name || 'Untitled';
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
    _recentWrap.innerHTML = `<div class="pm-recent-empty">No recent projects</div>`;
  } else {
    _recentWrap.innerHTML = list.map((r, i) => `
      <button class="pm-recent-item" data-idx="${i}">
        ${r.thumbnailDataUrl
          ? `<img class="pm-recent-thumb" src="${r.thumbnailDataUrl}" alt="">`
          : `<span class="pm-recent-thumb pm-recent-thumb-blank">${icon('Box', { width: 16, height: 16 })}</span>`}
        <span class="pm-recent-meta">
          <span class="pm-recent-name">${_esc(r.name)}</span>
          <span class="pm-recent-date">${new Date(r.savedAt).toLocaleString()}</span>
        </span>
      </button>
    `).join('');
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
      <h2 class="pm-modal-title">Unsaved changes</h2>
      <p class="pm-modal-body">This project has unsaved changes. Save before continuing?</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">Cancel</button>
        <button class="btn btn-danger" data-r="discard">Discard</button>
        <button class="btn btn-primary" data-r="save">Save</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });

  Modal.register('recoverAutosave', ({ data, close }) => {
    const when = data?.savedAt ? new Date(data.savedAt).toLocaleString() : 'unknown time';
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">Recover autosave?</h2>
      <p class="pm-modal-body">An autosave from <strong>${_esc(when)}</strong> was found. Recover it?</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="discard">Discard</button>
        <button class="btn btn-primary" data-r="recover">Recover</button>
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
      <h2 class="pm-modal-title">Linked assets fell back to snapshot</h2>
      <p class="pm-modal-body">${assets.length} linked asset${assets.length === 1 ? '' : 's'}
        couldn't be found on disk and ${assets.length === 1 ? 'was' : 'were'} restored
        from the saved snapshot. The project is still complete — relink below to
        reconnect to a live file.</p>
      <div class="pm-asset-list">
        ${assets.map(a => `
          <div class="pm-asset-row" data-id="${a.id}">
            <span class="pm-asset-name">${_esc(a.filename || a.name)}</span>
            <button class="btn btn-sm" data-relink="${a.id}">Relink…</button>
          </div>`).join('')}
      </div>
      <div class="pm-modal-actions">
        <button class="btn btn-primary" data-r="ok">Close</button>
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

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const ProjectMenu = { init };
