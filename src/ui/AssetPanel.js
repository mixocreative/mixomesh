import { EVENTS } from '../core/events.js';
import { subscribe, getState, dispatch } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { AssetLoader, removeAsset } from '../core/AssetLoader.js';
import { kvSet, kvGet, getHandle } from '../core/idb.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { safeImport } from './ImportError.js';
import { icon } from '../core/Icons.js';
import { caps } from '../core/storage/capabilities.js';
import { storage } from '../core/storage/StorageAdapter.js';
import {
  combineAssetIndexes,
  createAssetIndex,
  nearestFolderPath,
  queryAssets,
  scanAssetMount,
} from '../core/assets/AssetIndex.js';
import { authoredScaleFromAsset, formatScaleRatio } from '../core/scale/ScaleMath.js';
import { escapeHtml as _escape, escapeAttr, safeImageSrc } from './renderSafe.js';

const BABYLON = window.BABYLON;

const DRAG_MIME   = 'application/x-mixomesh-asset';

const SESSION_KEY = '__session__';

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

let _root          = null;
let _listEl        = null;          // #ap-tree-list (mount branches; library tab)
let _treeWrapEl    = null;          // #ap-tree (carries data-tab for CSS)
let _gridEl        = null;
let _gridBodyEl    = null;
let _gridSummaryEl = null;
let _breadcrumbEl  = null;
let _activeTab     = 'session';     // 'session' | 'library' — top-level switch
let _selectedKey   = SESSION_KEY;   // mountKey or SESSION_KEY
let _selectedPath  = '';            // display-relative folder path within selected mount
let _sessionView   = 'all';         // 'all' | 'used' | 'unused' | 'issues'
let _query         = '';
let _kindFilter    = 'all';         // 'all' | 'mesh' | 'texture'
let _scope         = 'folder';      // 'folder' | 'descendants' | 'all'
let _scopeExplicit = false;
const _mounts      = new Map();     // mountKey → { ref, name, index }

// ── Init ─────────────────────────────────────────────────

/** Initialise the Asset Panel. Must be called once after DOM is ready. */
export function init() {
  _root = document.getElementById('asset-panel');
  // Header is built ONCE here (never re-rendered) so AppShell controls in
  // `.ap-tree-header` survive. Only the mount
  // list (#ap-tree-list), grid summary, and grid body re-render. Session vs
  // Asset Library is a top-level tab, not a tree row — they have different lifecycles
  // (Session = this project's working set; Library = a reusable mounted
  // folder, re-mounted across projects).
  _root.innerHTML = `
    <div class="ap-tree" id="ap-tree" data-tab="session">
      <div class="ap-tree-header">
        <div class="ap-tabs" role="tablist" data-i18n-aria-label="asset.source">
          <button class="ap-tab active" type="button" role="tab" aria-selected="true" data-tab="session" data-i18n-title="asset.sessionTitle"><span data-i18n-key="panel.session.title">Session</span></button>
          <button class="ap-tab" type="button" role="tab" aria-selected="false" data-tab="library" data-i18n-title="asset.libraryTitle"><span data-i18n-key="panel.library.title">Library</span></button>
        </div>
        <button class="ap-btn" id="ap-mount-btn" type="button" data-i18n-title="asset.mountDirectoryTitle">
          ${icon('Upload', { width: 14, height: 14 })}
          <span data-i18n-key="asset.mount">Mount</span>
        </button>
        <button class="ap-icon-btn" id="ap-refresh-btn" type="button" data-i18n-title="asset.refresh" data-i18n-aria-label="asset.refresh">
          ${icon('RefreshCw', { width: 14, height: 14 })}
        </button>
        <button class="ap-icon-btn" id="ap-unmount-btn" type="button" data-i18n-title="asset.unmount" data-i18n-aria-label="asset.unmount">
          ${icon('Trash2', { width: 14, height: 14 })}
        </button>
      </div>
      <ul class="ap-tree-list" id="ap-tree-list" role="tree" data-i18n-aria-label="asset.mountedFolders"></ul>
    </div>
    <div class="ap-divider"></div>
    <div class="ap-grid" id="ap-grid">
      <div class="ap-breadcrumb" id="ap-breadcrumb" aria-live="polite"></div>
      <div class="ap-grid-controls" role="search">
        <input class="ap-search" id="ap-search" type="search" data-i18n-placeholder="asset.filter" autocomplete="off" data-i18n-aria-label="asset.filter">
        <select class="ap-scope-filter" id="ap-scope-filter" data-i18n-aria-label="asset.searchScope">
          <option value="folder" data-i18n-key="asset.scope.folder">This folder</option>
          <option value="descendants" data-i18n-key="asset.scope.descendants">Folder + subfolders</option>
          <option value="all" data-i18n-key="asset.scope.all">All libraries</option>
        </select>
        <select class="ap-kind-filter" id="ap-kind-filter" data-i18n-aria-label="asset.typeFilter">
          <option value="all" data-i18n-key="asset.filter.all">All</option>
          <option value="mesh" data-i18n-key="asset.filter.meshes">Meshes</option>
          <option value="texture" data-i18n-key="asset.filter.textures">Textures</option>
        </select>
      </div>
      <div class="ap-grid-summary" id="ap-grid-summary" aria-live="polite"></div>
      <div class="ap-grid-body" id="ap-grid-body"></div>
    </div>
  `;
  _treeWrapEl = document.getElementById('ap-tree');
  _listEl     = document.getElementById('ap-tree-list');
  _gridEl     = document.getElementById('ap-grid');
  _gridBodyEl = document.getElementById('ap-grid-body');
  _gridSummaryEl = document.getElementById('ap-grid-summary');
  _breadcrumbEl = document.getElementById('ap-breadcrumb');

  const _mountBtn = _treeWrapEl.querySelector('#ap-mount-btn');
  _mountBtn.addEventListener('click', promptMount);
  _treeWrapEl.querySelector('#ap-refresh-btn').addEventListener('click', () => safeAsync(_refreshSelectedMount));
  _treeWrapEl.querySelector('#ap-unmount-btn').addEventListener('click', _unmountSelected);
  // Capability-gate (ADR 0001): folder mounting needs a filesystem the runtime
  // exposes. Hidden — not shown-and-broken — when unsupported (e.g. a no-FSA
  // browser). No-op on Chrome/Edge/Electron where mountDirectory is true.
  if (!caps.mountDirectory) _mountBtn.hidden = true;
  _treeWrapEl.querySelectorAll('.ap-tab').forEach(btn =>
    btn.addEventListener('click', () => _setTab(btn.dataset.tab)));
  _listEl.addEventListener('click', _onTreeClick);
  _listEl.addEventListener('keydown', _onTreeKeyDown);
  _gridEl.addEventListener('input', _onGridInput);
  _gridEl.addEventListener('change', _onGridChange);
  _gridEl.addEventListener('click', _onGridClick);
  _gridEl.addEventListener('dblclick', _onGridDblClick);
  _gridEl.addEventListener('keydown', _onGridKeyDown);
  _gridEl.addEventListener('dragstart', _onGridDragStart);

  subscribe(EVENTS.ASSET_REGISTERED,   () => _renderGrid());
  subscribe(EVENTS.ASSET_REMOVED,      () => _renderGrid());
  subscribe(EVENTS.ASSET_INSTANTIATED, () => _renderGrid());
  // Header is built once and survives re-renders — only retranslate it on
  // locale switch; the grid body has no section.* labels in scope for v1.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _retranslate(_root); _renderTreeList(); _renderGrid(); });

  Modal.register('remountFolder', ({ data, close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${_escape(t('asset.remountTitle'))}</h2>
      <p class="pm-modal-body">${_escape(t('asset.remountBodyBefore'))}
        <strong>${_escape(data?.name || '')}</strong> ${_escape(t('asset.remountBodyAfter'))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="skip">${_escape(t('asset.skip'))}</button>
        <button class="btn btn-primary" data-r="mount">${_escape(t('asset.mount'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });

  _renderTreeList();
  _renderGrid();
  _retranslate(_root);
}

const LAST_MOUNT_KEY = 'last_mount_dir';

/** Index an adapter-owned directory ref once; rendering/search never scans storage. */
async function _mountRef(key, ref, name, announce) {
  const index = await scanAssetMount(storage, { mountKey: key, name, ref });
  _mounts.set(key, { ref, name, index });
  _selectedKey  = key;
  _selectedPath = name;
  _setTab('library');
  if (announce) Toast.show(t('toast.mounted', { name }), 'success', 3000);
}

/** Switch between Session and Library tabs. Drives `data-tab` on #ap-tree. */
function _setTab(tab) {
  _activeTab = tab;
  _treeWrapEl.dataset.tab = tab;
  _treeWrapEl.querySelectorAll('.ap-tab').forEach(btn => {
    const selected = btn.dataset.tab === tab;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (tab === 'session') {
    _selectedKey  = SESSION_KEY;
    _selectedPath = '';
  } else if (_selectedKey === SESSION_KEY) {
    const first = _mounts.keys().next();
    if (!first.done) {
      _selectedKey  = first.value;
      _selectedPath = _mounts.get(first.value).name;
    }
  }
  _renderTreeList();
  _renderGrid();
}

/** Programmatically trigger the directory-mount picker (also bound to header button). */
export async function promptMount() {
  await safeAsync(async () => {
    const mounted = await AssetLoader.mountDirectory();
    if (!mounted) return;
    await _mountRef(mounted.key, mounted.ref, mounted.name, true);
    await kvSet(LAST_MOUNT_KEY, { key: mounted.key, name: mounted.name });
  });
}

/**
 * Boot flow: if the last-mounted folder handle is still in IndexedDB, ask the
 * user whether to re-mount it (permission re-grant needs the modal-button
 * gesture). Replaces autosave recovery on startup.
 */
export async function promptRemount() {
  if (storage.kind !== 'browser') return;
  let rec;
  try { rec = await kvGet(LAST_MOUNT_KEY); } catch { return; }
  if (!rec?.key) return;
  const handle = await getHandle(rec.key);
  if (!handle) return;

  const choice = await new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'remountFolder',
      name: rec.name,
      onClose: (r) => resolve(r || 'skip'),
    });
  });
  if (choice !== 'mount') return;

  await safeAsync(async () => {
    if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
      Toast.show(t('toast.folderPermissionDenied'), 'warning', 4000);
      return;
    }
    await _mountRef(rec.key, handle, rec.name || handle.name, true);
  });
}

/**
 * Resolve a path payload from a drag event back to a FileSystemFileHandle.
 * Used by the viewport drop handler.
 * @param {string} mountKey
 * @param {string} path  relative path (e.g. 'tanks/hull.glb')
 * @returns {FileSystemFileHandle|null}
 */
export function getFileHandle(mountKey, path) {
  const file = _libraryIndex().files.find(row => row.mountKey === mountKey && row.path === path);
  if (!file) return null;
  return {
    name: file.name,
    getFile: () => storage.readFile(file.ref),
  };
}

function _libraryIndex() {
  return _mounts.size
    ? combineAssetIndexes([..._mounts.values()].map(mount => mount.index))
    : createAssetIndex();
}

async function _refreshSelectedMount() {
  const mount = _mounts.get(_selectedKey);
  if (!mount) return;
  const requestedPath = _selectedPath;
  const index = await scanAssetMount(storage, {
    mountKey: _selectedKey,
    name: mount.name,
    ref: mount.ref,
  });
  mount.index = index;
  _selectedPath = nearestFolderPath(index, _selectedKey, requestedPath) ?? mount.name;
  _renderTreeList();
  _renderGrid();
  Toast.show(t('toast.assetFolderRefreshed', { name: mount.name }), 'success', 2500);
}

function _unmountSelected() {
  if (!_mounts.delete(_selectedKey)) return;
  const next = _mounts.entries().next();
  if (next.done) {
    _selectedKey = SESSION_KEY;
    _selectedPath = '';
    _setTab('session');
    return;
  }
  _selectedKey = next.value[0];
  _selectedPath = next.value[1].name;
  _renderTreeList();
  _renderGrid();
}

// ── Tree rendering ───────────────────────────────────────

function _renderTreeList() {
  if (_activeTab === 'session') {
    const views = [
      ['all', 'Layers', t('asset.smart.all')],
      ['used', 'Box', t('asset.smart.used')],
      ['unused', 'Circle', t('asset.smart.unused')],
      ['issues', 'CircleAlert', t('asset.smart.issues')],
    ];
    _listEl.innerHTML = views.map(([view, iconName, label]) => _renderTreeRow({
      label,
      iconName,
      key: SESSION_KEY,
      relPath: view,
      depth: 0,
      hasChildren: false,
      sessionView: view,
    })).join('');
    return;
  }
  if (_mounts.size === 0) {
    _listEl.innerHTML = '';
    return;
  }
  const parts = [];
  for (const [mountKey, m] of _mounts) {
    const root = m.index.folders.find(folder => folder.path === m.name);
    if (root) parts.push(_renderTreeBranch(mountKey, root, m.index, 0));
  }
  _listEl.innerHTML = parts.join('');
}

function _renderTreeBranch(mountKey, node, index, depth) {
  const children = index.folders.filter(folder => (
    folder.mountKey === mountKey && folder.parentPath === node.path
  ));
  const hasChildren = children.length > 0;
  let html = _renderTreeRow({
    label: node.name,
    iconName: 'FolderOpen',
    key: mountKey,
    relPath: node.path,
    depth,
    hasChildren,
  });
  if (hasChildren) {
    html += '<ul class="ap-tree-children">';
    for (const child of children) html += _renderTreeBranch(mountKey, child, index, depth + 1);
    html += '</ul>';
  }
  return html;
}

function _renderTreeRow({ label, iconName, key, relPath, depth, hasChildren, sessionView = '' }) {
  const isSelected = sessionView
    ? _activeTab === 'session' && sessionView === _sessionView
    : key === _selectedKey && relPath === _selectedPath;
  const selected = isSelected ? 'selected' : '';
  const indent = depth * 12;
  const toggler = hasChildren
    ? `<span class="ap-tree-toggle">${icon('ChevronDown', { width: 12, height: 12 })}</span>`
    : `<span class="ap-tree-toggle ap-tree-toggle-empty"></span>`;
  return `
    <li>
      <div class="ap-tree-row ${selected}"
           data-tree-row
           data-mount-key="${escapeAttr(key)}"
           data-rel-path="${escapeAttr(relPath)}"
           data-session-view="${escapeAttr(sessionView)}"
           data-has-children="${hasChildren ? 'true' : 'false'}"
           role="treeitem"
           tabindex="0"
           aria-selected="${selected ? 'true' : 'false'}"
           ${hasChildren ? 'aria-expanded="true"' : ''}
           style="padding-left:${indent}px">
        ${toggler}
        <span class="ap-tree-icon">${icon(iconName, { width: 14, height: 14 })}</span>
        <span class="ap-tree-label">${_escape(label)}</span>
      </div>
    </li>
  `;
}

// ── Grid rendering ───────────────────────────────────────

function _renderGrid() {
  let files = [];
  let total = 0;
  const scopeEl = _gridEl.querySelector('#ap-scope-filter');
  if (_activeTab === 'session') {
    files = _sessionFiles(_sessionView);
    total = files.length;
    _breadcrumbEl.textContent = t(`asset.smart.${_sessionView}`);
    scopeEl.disabled = true;
  } else if (_mounts.size === 0) {
    _breadcrumbEl.textContent = t('panel.library.title');
    scopeEl.disabled = true;
    _gridSummaryEl.textContent = '';
    _gridBodyEl.innerHTML = `
      <div class="ap-empty">
        ${_escape(t('asset.empty.noFolder'))}
      </div>`;
    return;
  } else {
    scopeEl.disabled = false;
    scopeEl.value = _scope;
    _breadcrumbEl.textContent = _scope === 'all' ? t('asset.scope.all') : _selectedPath;
    const index = _libraryIndex();
    const query = { mountKey: _selectedKey, folderPath: _selectedPath, scope: _scope };
    total = queryAssets(index, { ...query, text: '', kind: 'all' }).length;
    files = queryAssets(index, { ...query, text: _query, kind: _kindFilter })
      .map(file => ({ ...file, kind: file.assetKind }));
  }

  const filtered = _activeTab === 'session' ? _filterFiles(files) : files;
  _gridSummaryEl.textContent = total
    ? t('asset.summary', {
      filtered: filtered.length,
      total,
      noun: t(total === 1 ? 'asset.assetSingular' : 'asset.assetPlural'),
    })
    : '';

  if (!filtered.length) {
    _gridBodyEl.innerHTML = `
      <div class="ap-empty">
        ${total
          ? _escape(t('asset.empty.noMatch'))
          : _activeTab === 'session'
          ? _escape(t('asset.empty.session'))
          : _escape(t('asset.empty.noSupported'))}
      </div>`;
    return;
  }

  const cards = filtered.map(f => _renderCard(f)).join('');
  _gridBodyEl.innerHTML = `<div class="ap-cards">${cards}</div>`;
}

function _filterFiles(files) {
  const query = _query.trim().toLowerCase();
  return files.filter(file => {
    const kind = file.kind ?? 'mesh';
    if (_kindFilter !== 'all' && kind !== _kindFilter) return false;
    if (!query) return true;
    const haystack = `${file.name ?? ''} ${file.path ?? ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function _plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

// Session = every asset registered to this project (loose drops + folder
// loads), regardless of source. Liveness is shown per-card via the
// Linked/Snapshot badge — not by filtering.
function _sessionFiles() {
  const scene = getState().scene;
  const library = scene.assetLibrary;
  const objects = Object.values(scene.objects);
  const usedIds = new Set(objects.map(object => object.assetId).filter(Boolean));
  for (const shader of Object.values(scene.shaders)) {
    if (shader.diffuseTextureAssetId) usedIds.add(shader.diffuseTextureAssetId);
  }
  const issueIds = new Set(objects.filter(object => object.isGhost).map(object => object.assetId));
  return Object.values(library).filter(asset => {
    const used = usedIds.has(asset.id);
    if (_sessionView === 'used') return used;
    if (_sessionView === 'unused') return !used;
    if (_sessionView === 'issues') return issueIds.has(asset.id) || asset.unitConfirmed === false;
    return true;
  }).map(a => ({
    name: a.displayName ?? a.filename,
    path: a.id,
    ext: a.extension,
    kind: a.kind ?? 'mesh',
    mountKey: SESSION_KEY,
    _asset: a,
  }));
}

function _renderCard(file) {
  const asset = file._asset ?? _findAssetForFile(file);
  const kind  = file.kind ?? asset?.kind ?? 'mesh';
  const isSession = file.mountKey === SESSION_KEY;

  const placeholderIcon = kind === 'texture' ? 'Image' : 'Box';
  const safeThumbSrc = safeImageSrc(asset?.thumbnailDataUrl);
  const thumbHtml = safeThumbSrc
    ? `<img class="ac-thumb" src="${safeThumbSrc}" alt="" draggable="false">`
    : `<div class="ac-thumb ac-thumb-empty">${icon(placeholderIcon, { width: 32, height: 32 })}</div>`;

  let badges = `<span class="ac-ext">${file.ext.slice(1).toUpperCase()}</span>`;
  if (kind === 'mesh' && asset) {
    const authoredScale = authoredScaleFromAsset(asset);
    badges += `<span class="ac-ratio" title="${escapeAttr(t('asset.authoredScaleTitle'))}">${_escape(formatScaleRatio(authoredScale.authoredRatio))}</span>`;
    if (asset.unitConfirmed === false) {
      badges += `<span class="ac-unit-badge" title="${escapeAttr(t('asset.sourceUnitUnconfirmed', { unit: asset.sourceUnit }))}">${icon('AlertTriangle', { width: 11, height: 11 })}${_escape(_unitShort(asset.sourceUnit))}</span>`;
    }
  }
  // Liveness badge — only meaningful on the Session tab (Library cards are
  // always live by definition since they're the mounted folder browser).
  if (isSession && asset) {
    const linked = !!(asset.directoryHandleKey || asset.fileHandleKey);
    badges += linked
      ? `<span class="ac-link is-linked" title="${escapeAttr(t('asset.linkedTitle'))}">${_escape(t('asset.linked'))}</span>`
      : `<span class="ac-link is-snapshot" title="${escapeAttr(t('asset.snapshotTitle'))}">${_escape(t('asset.snapshot'))}</span>`;
  }

  const deleteBtn = isSession && asset
    ? `<button class="ac-delete" type="button" data-asset-id="${escapeAttr(asset.id)}" title="${escapeAttr(t('asset.remove'))}" aria-label="${escapeAttr(t('asset.removeNamed', { name: file.name }))}">×</button>`
    : '';
  const label = t('asset.cardLabel', {
    name: file.name,
    kind: t(`asset.kind.${kind}`),
    source: t(isSession ? 'asset.source.session' : 'asset.source.library'),
  });

  return `
    <div class="asset-card"
         draggable="true"
         role="button"
         tabindex="0"
         aria-label="${escapeAttr(label)}"
         data-mount-key="${escapeAttr(file.mountKey)}"
         data-path="${escapeAttr(file.path)}"
         data-source-path="${escapeAttr(file.sourcePath ?? file.path)}"
         data-filename="${escapeAttr(file.name)}"
         data-kind="${escapeAttr(kind)}"
         title="${escapeAttr(file.path)}">
      ${deleteBtn}
      ${thumbHtml}
      <div class="ac-meta">
        <span class="ac-name">${_escape(file.name)}</span>
        ${isSession ? '' : `<span class="ac-path">${_escape(file.path)}</span>`}
        <span class="ac-badges">${badges}</span>
      </div>
    </div>
  `;
}

function _onTreeClick(e) {
  const row = e.target.closest?.('[data-tree-row]');
  if (!row || !_listEl.contains(row)) return;
  e.stopPropagation();
  _activateTreeRow(row, !!e.target.closest?.('.ap-tree-toggle'));
}

function _onTreeKeyDown(e) {
  const row = e.target.closest?.('[data-tree-row]');
  if (!row || !_listEl.contains(row)) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    _activateTreeRow(row, false);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (row.dataset.hasChildren !== 'true') return;
    e.preventDefault();
    const collapsed = e.key === 'ArrowLeft';
    row.classList.toggle('collapsed', collapsed);
    row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

function _activateTreeRow(row, toggleOnly) {
  if (toggleOnly && row.dataset.hasChildren === 'true') {
    const collapsed = !row.classList.contains('collapsed');
    row.classList.toggle('collapsed', collapsed);
    row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    return;
  }
  if (row.dataset.sessionView) {
    _sessionView = row.dataset.sessionView;
    _selectedKey = SESSION_KEY;
    _selectedPath = '';
  } else {
    _selectedKey  = row.dataset.mountKey;
    _selectedPath = row.dataset.relPath ?? '';
  }
  _listEl.querySelectorAll('[data-tree-row]').forEach(r => {
    const selected = r === row;
    r.classList.toggle('selected', selected);
    r.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  _renderGrid();
}

function _onGridInput(e) {
  if (e.target.id !== 'ap-search') return;
  const startingSearch = !_query.trim() && e.target.value.trim();
  _query = e.target.value;
  if (_activeTab === 'library' && !_scopeExplicit) {
    _scope = startingSearch ? 'descendants' : _query.trim() ? _scope : 'folder';
    _gridEl.querySelector('#ap-scope-filter').value = _scope;
  }
  _renderGrid();
}

function _onGridChange(e) {
  if (e.target.id === 'ap-kind-filter') _kindFilter = e.target.value;
  else if (e.target.id === 'ap-scope-filter') {
    _scope = e.target.value;
    _scopeExplicit = true;
  } else return;
  _renderGrid();
}

function _onGridClick(e) {
  const deleteBtn = e.target.closest?.('.ac-delete');
  if (!deleteBtn || !_gridEl.contains(deleteBtn)) return;
  e.stopPropagation();
  removeAsset(deleteBtn.dataset.assetId);
}

function _onGridDblClick(e) {
  const card = e.target.closest?.('.asset-card');
  if (!card || !_gridEl.contains(card)) return;
  _activateCard(card);
}

function _onGridKeyDown(e) {
  if (e.target.closest?.('button,input,select,textarea')) return;
  const card = e.target.closest?.('.asset-card');
  if (!card || !_gridEl.contains(card)) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  _activateCard(card);
}

function _onGridDragStart(e) {
  const card = e.target.closest?.('.asset-card');
  if (!card || !_gridEl.contains(card)) return;
  const payload = JSON.stringify(_cardPayload(card));
  e.dataTransfer.setData(DRAG_MIME, payload);
  e.dataTransfer.effectAllowed = 'copy';
}

function _cardPayload(card) {
  return {
    mountKey: card.dataset.mountKey,
    path: card.dataset.path,
    sourcePath: card.dataset.sourcePath,
    filename: card.dataset.filename,
    kind: card.dataset.kind ?? 'mesh',
  };
}

function _activateCard(card) {
  const { mountKey, path, sourcePath, kind } = _cardPayload(card);
  const filename = card.dataset.filename ?? path ?? 'asset';
  safeImport(async () => {
    if (mountKey === SESSION_KEY) {
      // path IS the assetId on session cards; re-instantiate the loaded
      // container at origin. Same code path as a SESSION_KEY viewport drop.
      if (kind === 'mesh') {
        await AssetLoader.instantiateAsset(path, new BABYLON.Vector3(0, 0, 0));
      }
      return;
    }
    const handle = getFileHandle(mountKey, path);
    if (!handle) throw new Error('File handle not available');
    if (kind === 'texture') {
      // Double-clicking a texture loads it into the asset library so it
      // can be assigned to a shader from the ShaderPanel. No scene drop.
      await AssetLoader.loadTextureFromHandle(handle, {
        directoryHandleKey: mountKey, originalPath: sourcePath,
      });
    } else {
      await AssetLoader.loadFromHandle(
        handle,
        new BABYLON.Vector3(0, 0, 0),
        { directoryHandleKey: mountKey, originalPath: sourcePath },
      );
    }
  }, filename);
}

function _findAssetForFile(file) {
  const library = getState().scene.assetLibrary;
  for (const a of Object.values(library)) {
    if (a.directoryHandleKey === file.mountKey
        && a.originalPath === (file.sourcePath ?? file.path)) return a;
  }
  return null;
}

function _unitShort(unit) {
  return ({ meters: 'm', centimeters: 'cm', millimeters: 'mm', inches: 'in', feet: 'ft' })[unit] ?? unit;
}

export const AssetPanel = { init, promptMount, promptRemount, getFileHandle };
