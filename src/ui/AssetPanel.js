import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { AssetLoader, removeAsset, SESSION_KEY } from '../core/AssetLoader.js';
import { Modal } from './Modal.js';
import { runFindMoved } from './FindMoved.js';
import { canFindMoved } from '../core/persist/AssetResolver.js';
import { relinkAsset, refreshAsset } from '../core/persist/ProjectLoader.js';
import { displayNameParts } from '../core/assets/DisplayNames.js';
import { SourcesModal, sourceStatus, statusChipHtml } from './SourcesModal.js';
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
          <button class="ap-tab active" type="button" role="tab" aria-selected="true" data-tab="session" data-i18n-title="asset.sessionTitle"><span data-i18n-key="panel.session.title">Project</span><span class="ap-tab-count" id="ap-count-session"></span></button>
          <button class="ap-tab" type="button" role="tab" aria-selected="false" data-tab="library" data-i18n-title="asset.libraryTitle"><span data-i18n-key="panel.library.title">Folders</span><span class="ap-tab-count" id="ap-count-library"></span></button>
        </div>
        <button class="ap-icon-btn ap-sources-btn" id="ap-sources-btn" type="button" data-i18n-title="asset.sources.openTitle" data-i18n-aria-label="asset.sources.open">
          ${icon('Link', { width: 14, height: 14 })}
        </button>
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
  _treeWrapEl.querySelector('#ap-sources-btn').addEventListener('click', () => SourcesModal.open());
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
  subscribe(EVENTS.ASSET_RELINKED,     () => _renderGrid());
  subscribe(EVENTS.ASSET_INSTANTIATED, () => _renderGrid());
  // Header is built once and survives re-renders — only retranslate it on
  // locale switch; the grid body has no section.* labels in scope for v1.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _retranslate(_root); _renderTreeList(); _renderGrid(); });

  subscribe(EVENTS.PROJECT_LOADED,     () => _renderGrid());
  SourcesModal.init();
  _registerDuplicateDialog();
  document.addEventListener('pointerdown', _onDocPointerDown, true);
  document.addEventListener('keydown', _onDocKeyDown, true);

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
    const picked = await storage.mountDirectory();
    if (picked) await mountFromRef(picked);
  });
}

/**
 * Mount an already-obtained directory ref ({ref,name}) exactly like the Mount
 * button: register + index + persist as the last mount. If that folder is
 * already mounted (same stable key), just select it.
 * @param {{ref:any, name:string}} picked
 */
export async function mountFromRef(picked) {
  const mounted = await AssetLoader.registerMount(picked);
  if (_mounts.has(mounted.key)) {
    _selectedKey  = mounted.key;
    _selectedPath = _mounts.get(mounted.key).name;
    _setTab('library');
    return;
  }
  await _mountRef(mounted.key, mounted.ref, mounted.name, true);
  await storage.kvSet(LAST_MOUNT_KEY, { key: mounted.key, name: mounted.name });
}

/**
 * Boot check (task 4.7): the last-mounted folder whose ref is still stored,
 * or null. No UI and no permission prompt — the boot banner offers the
 * re-mount and its button click is the gesture `remountLast` needs. Routed
 * through the StorageAdapter, so it runs wherever refs persist
 * (`caps.persistAssets`) — desktop included.
 * @returns {Promise<{key:string, name:string}|null>}
 */
export async function findRemountOffer() {
  if (!caps.persistAssets) return null;
  let rec;
  try { rec = await storage.kvGet(LAST_MOUNT_KEY); } catch { return null; }
  if (!rec?.key) return null;
  try { if (!(await storage.hasRef(rec.key))) return null; } catch { return null; }
  if (_mounts.has(rec.key)) return null;
  return { key: rec.key, name: rec.name || '' };
}

/** Legacy name of the boot check (kept for callers/tests); never opens UI. */
export const promptRemount = findRemountOffer;

/**
 * Re-mount the offered folder. Must run inside a user gesture (browser
 * permission re-grant). @returns {Promise<boolean>} true when mounted
 */
export async function remountLast(offer) {
  if (!offer?.key) return false;
  if (_mounts.has(offer.key)) return true;
  const ref = await storage.restoreRef(offer.key);   // browser: permission prompt (gesture = the banner button)
  if (!ref) {
    Toast.show(t('toast.folderPermissionDenied'), 'warning', 4000);
    return false;
  }
  await _mountRef(offer.key, ref, offer.name || ref.name, true);
  return true;
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

function _renderTabCounts() {
  const sessionEl = _treeWrapEl.querySelector('#ap-count-session');
  const libraryEl = _treeWrapEl.querySelector('#ap-count-library');
  const n = Object.keys(getState().scene.assetLibrary ?? {}).length;
  if (sessionEl) sessionEl.textContent = n ? String(n) : '';
  if (libraryEl) libraryEl.textContent = _mounts.size ? String(_mounts.size) : '';
}

function _renderGrid() {
  _renderTabCounts();
  _renderGridBody();
  _reanchorCardMenu();
}

function _renderGridBody() {
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

  const library = getState().scene.assetLibrary;
  const cards = filtered.map(f => _renderCard(f, library)).join('');
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

// Project tab = every asset registered to this project (loose drops + folder
// loads), regardless of source. Source status is shown per-card via the
// Source chip — not by filtering (except the Issues smart view).
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
    if (_sessionView === 'issues') {
      const st = sourceStatus(asset);
      return issueIds.has(asset.id) || asset.unitConfirmed === false || st === 'changed' || st === 'missing';
    }
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

// Name + dimmed qualifier (task 4.8 display): `chair.glb · downloads` only
// while the name is ambiguous; generic texture names read `<model> · <slot>`.
// The tooltip carries the original filename (and path).
function _nameHtml(asset, fallback, library) {
  const parts = asset ? displayNameParts(asset, library) : null;
  if (!parts) return `<span class="ac-name" title="${escapeAttr(fallback)}">${_escape(fallback)}</span>`;
  const qualifier = parts.qualifier
    ? `<span class="ac-qualifier">${_escape(parts.qualifier)}</span>` : '';
  return `<span class="ac-name" title="${escapeAttr(parts.tooltip ?? parts.text)}">`
    + `<span class="ac-label">${_escape(parts.label)}</span>${qualifier}</span>`;
}

function _renderCard(file, library) {
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
  // Source chip (task 4.6) — Project tab only: Folders cards ARE the live
  // folder. Healthy words (Embedded copy / Linked) stay quiet; Changed on
  // disk (amber) and Missing (red) carry colour.
  const chip = isSession && asset ? statusChipHtml(sourceStatus(asset), 'ac-chip') : '';
  const menuBtn = isSession && asset
    ? `<button class="ac-menu-btn" type="button" data-asset-id="${escapeAttr(asset.id)}" aria-haspopup="menu" aria-expanded="false" title="${escapeAttr(t('asset.menu.title'))}" aria-label="${escapeAttr(t('asset.menu.named', { name: file.name }))}">${icon('MoreHorizontal', { width: 14, height: 14 })}</button>`
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
         ${isSession ? '' : `title="${escapeAttr(file.path)}"`}>
      <div class="ac-thumb-wrap">${thumbHtml}${chip}</div>
      <div class="ac-meta">
        <div class="ac-title-row">${isSession ? _nameHtml(asset, file.name, library) : `<span class="ac-name">${_escape(file.name)}</span>`}${menuBtn}</div>
        ${isSession ? '' : `<span class="ac-path">${_escape(file.path)}</span>`}
        <span class="ac-badges">${badges}</span>
      </div>
    </div>
  `;
}

// ── Card ⋯ menu (task 4.6) ───────────────────────────────

let _menuEl = null;
let _menuBtn = null;

function _menuItems(asset) {
  const st = sourceStatus(asset);
  const kind = asset.kind ?? 'mesh';
  const readable = st === 'linked' || st === 'changed';
  const findable = canFindMoved(asset.id);
  return [
    kind === 'mesh' && !asset.isGhost ? { action: 'add', label: t('asset.menu.add') } : null,
    { action: 'refresh', label: t('asset.menu.refresh'), disabled: !readable, title: readable ? '' : t('asset.menu.refreshDisabled') },
    { action: 'find', label: t('asset.findMoved.action'), disabled: !findable, title: findable ? t('asset.findMoved.title') : t('asset.menu.findDisabled') },
    kind === 'mesh' ? { action: 'relink', label: t('project.relink') } : null,
    { action: 'sources', label: t('asset.menu.showInSources') },
    { sep: true },
    { action: 'remove', label: t('asset.remove'), danger: true },
  ].filter(Boolean);
}

function _openCardMenu(btn) {
  const assetId = btn.dataset.assetId;
  const asset = getState().scene.assetLibrary[assetId];
  if (!asset) return;
  _closeCardMenu();
  const el = document.createElement('div');
  el.className = 'ac-menu';
  el.setAttribute('role', 'menu');
  el.dataset.assetId = assetId;
  el.innerHTML = _menuItems(asset).map(item => item.sep
    ? '<div class="ac-menu-sep" role="separator"></div>'
    : `<button class="ac-menu-item${item.danger ? ' is-danger' : ''}" type="button" role="menuitem" data-action="${item.action}"${item.disabled ? ' disabled' : ''}${item.title ? ` title="${escapeAttr(item.title)}"` : ''}>${_escape(item.label)}</button>`).join('');
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  // Open upward when the card sits near the window bottom (the asset panel
  // usually does); stay inside the viewport horizontally.
  const top = r.bottom + h + 4 > window.innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4;
  const left = Math.min(Math.max(4, r.right - w), window.innerWidth - w - 4);
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  el.addEventListener('click', (e) => {
    const item = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('.ac-menu-item'));
    if (!item || item.disabled) return;
    const action = item.dataset.action;
    _closeCardMenu();
    _runCardAction(action, assetId);
  });
  el.addEventListener('keydown', _onMenuKeyDown);
  _menuEl = el;
  _menuBtn = btn;
  btn.setAttribute('aria-expanded', 'true');
  /** @type {HTMLElement|null} */ (el.querySelector('.ac-menu-item:not([disabled])'))?.focus();
}

// A background re-render (thumbnail, registry event) replaces the card
// buttons; keep an open menu bound to its asset's new button, or close it
// when the asset is gone / no longer shown.
function _reanchorCardMenu() {
  if (!_menuEl) return;
  const id = _menuEl.dataset.assetId;
  const btn = [..._gridEl.querySelectorAll('.ac-menu-btn')].find(b => /** @type {HTMLElement} */ (b).dataset.assetId === id);
  if (!btn || !getState().scene.assetLibrary[id]) { _closeCardMenu(); return; }
  _menuBtn = /** @type {HTMLElement} */ (btn);
  _menuBtn.setAttribute('aria-expanded', 'true');
}

function _closeCardMenu({ restoreFocus = false } = {}) {
  if (!_menuEl) return;
  _menuEl.remove();
  _menuEl = null;
  if (_menuBtn) {
    _menuBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && _menuBtn.isConnected) _menuBtn.focus();
  }
  _menuBtn = null;
}

function _onMenuKeyDown(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [..._menuEl.querySelectorAll('.ac-menu-item:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  /** @type {HTMLElement|undefined} */ (next)?.focus();
}

function _onDocPointerDown(e) {
  if (!_menuEl) return;
  if (_menuEl.contains(e.target) || _menuBtn?.contains(e.target)) return;
  _closeCardMenu();
}

function _onDocKeyDown(e) {
  if (!_menuEl || e.key !== 'Escape') return;
  e.stopPropagation();
  _closeCardMenu({ restoreFocus: true });
}

function _runCardAction(action, assetId) {
  if (action === 'add') {
    const name = getState().scene.assetLibrary[assetId]?.filename ?? 'asset';
    safeImport(() => AssetLoader.instantiateAsset(assetId, new BABYLON.Vector3(0, 0, 0)), name);
  } else if (action === 'refresh') {
    safeAsync(async () => {
      if (!(await refreshAsset(assetId))) Toast.show(t('asset.menu.refreshFailed'), 'warning', 4000);
    });
  } else if (action === 'find') {
    runFindMoved(assetId);
  } else if (action === 'relink') {
    safeAsync(() => relinkAsset(assetId));
  } else if (action === 'sources') {
    SourcesModal.open({ focusAssetId: assetId });
  } else if (action === 'remove') {
    removeAsset(assetId);
  }
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
  const menuBtn = e.target.closest?.('.ac-menu-btn');
  if (!menuBtn || !_gridEl.contains(menuBtn)) return;
  e.stopPropagation();
  if (_menuBtn === menuBtn) { _closeCardMenu(); return; }
  _openCardMenu(menuBtn);
}

function _onGridDblClick(e) {
  if (e.target.closest?.('.ac-menu-btn')) return;
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

// ── "Already in this project" dialog (task 4.8 display, Decision 16) ──
// AssetImport.askDuplicateImport dispatches this id and maps the result:
// 'copy' | 'separate' | anything else (× / Esc / backdrop) = cancel.
function _registerDuplicateDialog() {
  Modal.register('duplicateImport', ({ data, close }) => {
    const filename = data?.filename ?? '';
    const existing = data?.existingName ?? filename;
    const el = document.createElement('div');
    el.className = 'pm-modal dup-modal';
    el.innerHTML = `
      <div class="dup-head">
        <span class="dup-icon" aria-hidden="true">${icon('Copy', { width: 18, height: 18 })}</span>
        <div class="dup-heading">
          <h2 class="pm-modal-title">${_escape(t('import.duplicateTitle'))}</h2>
          <p class="dup-source">${_escape(t('import.duplicateSource'))} <strong>${_escape(filename)}</strong></p>
        </div>
        <button class="dup-close" type="button" data-r="dismiss" aria-label="${escapeAttr(t('btn.close'))}" title="${escapeAttr(t('btn.close'))}">×</button>
      </div>
      <div class="dup-body">
        <p>${_escape(existing === filename
    ? t('import.duplicateBodySame', { name: filename })
    : t('import.duplicateBody', { name: filename, existing }))}</p>
        <p class="dup-hint">${_escape(t('import.duplicateHint'))}</p>
      </div>
      <div class="pm-modal-actions">
        <button class="btn" type="button" data-r="separate">${_escape(t('import.duplicateSeparate'))}</button>
        <button class="btn btn-primary" type="button" data-r="copy">${icon('Copy', { width: 13, height: 13 })}<span>${_escape(t('import.duplicateAddCopy'))}</span></button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => close(/** @type {HTMLElement} */ (b).dataset.r)));
    // "Add another copy" is the default (Enter): Modal focuses the first
    // focusable synchronously after render (the ×), so move it on a microtask.
    queueMicrotask(() => /** @type {HTMLElement|null} */ (el.querySelector('[data-r="copy"]'))?.focus());
    return el;
  });
}

export const AssetPanel = { init, promptMount, mountFromRef, promptRemount, findRemountOffer, remountLast, getFileHandle };

