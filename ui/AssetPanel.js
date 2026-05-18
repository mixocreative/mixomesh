import { EVENTS } from '../core/events.js';
import { subscribe, getState, dispatch } from '../core/StateManager.js';
import { AssetLoader, removeAsset } from '../core/AssetLoader.js';
import { kvSet, kvGet, getHandle } from '../core/idb.js';
import { Modal } from './Modal.js';
import { Toast, safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';

const BABYLON = window.BABYLON;

const MESH_EXT    = new Set(['.glb', '.gltf', '.obj', '.stl', '.3mf']);
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SUPPORTED   = new Set([...MESH_EXT, ...TEXTURE_EXT]);
const DRAG_MIME   = 'application/x-mixomesh-asset';

const SESSION_KEY = '__session__';

let _root          = null;
let _listEl        = null;          // #ap-tree-list (mount branches; library tab)
let _treeWrapEl    = null;          // #ap-tree (carries data-tab for CSS)
let _gridEl        = null;
let _activeTab     = 'session';     // 'session' | 'library' — top-level switch
let _selectedKey   = SESSION_KEY;   // mountKey or SESSION_KEY
let _selectedPath  = '';            // relative path within selected mount; '' = root
const _mounts      = new Map();     // mountKey → { handle, tree }
const _fileHandles = new Map();     // `${mountKey}:${relPath}` → FileSystemFileHandle

// ── Init ─────────────────────────────────────────────────

/** Initialise the Asset Panel. Must be called once after DOM is ready. */
export function init() {
  _root = document.getElementById('asset-panel');
  // Header is built ONCE here (never re-rendered) so the panel-collapse
  // button main.js appends into `.ap-tree-header` survives. Only the mount
  // list (#ap-tree-list) and the grid re-render. Session vs Asset Library is
  // a top-level tab, not a tree row — they have different lifecycles
  // (Session = this project's working set; Library = a reusable mounted
  // folder, re-mounted across projects).
  _root.innerHTML = `
    <div class="ap-tree" id="ap-tree" data-tab="session">
      <div class="ap-tree-header">
        <div class="ap-tabs">
          <button class="ap-tab active" data-tab="session" title="Assets used in this project">Session</button>
          <button class="ap-tab" data-tab="library" title="A mounted folder you can pull assets from across projects">Asset Library</button>
        </div>
        <button class="ap-btn" id="ap-mount-btn" title="Mount a directory">
          ${icon('Upload', { width: 14, height: 14 })}
          <span>Mount</span>
        </button>
      </div>
      <ul class="ap-tree-list" id="ap-tree-list"></ul>
    </div>
    <div class="ap-divider"></div>
    <div class="ap-grid" id="ap-grid"></div>
  `;
  _treeWrapEl = document.getElementById('ap-tree');
  _listEl     = document.getElementById('ap-tree-list');
  _gridEl     = document.getElementById('ap-grid');

  _treeWrapEl.querySelector('#ap-mount-btn').addEventListener('click', promptMount);
  _treeWrapEl.querySelectorAll('.ap-tab').forEach(btn =>
    btn.addEventListener('click', () => _setTab(btn.dataset.tab)));

  subscribe(EVENTS.ASSET_REGISTERED,   () => _renderGrid());
  subscribe(EVENTS.ASSET_INSTANTIATED, () => _renderGrid());

  Modal.register('remountFolder', ({ data, close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">Re-mount asset folder?</h2>
      <p class="pm-modal-body">Last session's asset folder
        <strong>${_esc(data?.name || '')}</strong> is available. Re-mount it so
        saved projects relink to live files?</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="skip">Skip</button>
        <button class="btn btn-primary" data-r="mount">Mount</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b =>
      b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });

  _renderTreeList();
  _renderGrid();
}

const LAST_MOUNT_KEY = 'last_mount_dir';

/** Scan a granted directory handle into the panel + cache its file handles. */
async function _mountHandle(key, handle, announce) {
  const tree = await _scanDirectory(handle, '');
  _mounts.set(key, { handle, tree });
  _cacheHandles(key, tree);
  _selectedKey  = key;
  _selectedPath = '';
  _setTab('library');
  if (announce) Toast.show(`Mounted: ${handle.name}`, 'success', 3000);
}

/** Switch between Session and Library tabs. Drives `data-tab` on #ap-tree. */
function _setTab(tab) {
  _activeTab = tab;
  _treeWrapEl.dataset.tab = tab;
  _treeWrapEl.querySelectorAll('.ap-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab));
  if (tab === 'session') {
    _selectedKey  = SESSION_KEY;
    _selectedPath = '';
  } else if (_selectedKey === SESSION_KEY) {
    const first = _mounts.keys().next();
    if (!first.done) {
      _selectedKey  = first.value;
      _selectedPath = '';
    }
  }
  _renderTreeList();
  _renderGrid();
}

/** Programmatically trigger the directory-mount picker (also bound to header button). */
export async function promptMount() {
  await safeAsync(async () => {
    const { key, handle } = await AssetLoader.mountDirectory();
    await _mountHandle(key, handle, true);
    await kvSet(LAST_MOUNT_KEY, { key, name: handle.name });
  });
}

/**
 * Boot flow: if the last-mounted folder handle is still in IndexedDB, ask the
 * user whether to re-mount it (permission re-grant needs the modal-button
 * gesture). Replaces autosave recovery on startup.
 */
export async function promptRemount() {
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
      Toast.show('Folder permission denied', 'warning', 4000);
      return;
    }
    await _mountHandle(rec.key, handle, true);
  });
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Resolve a path payload from a drag event back to a FileSystemFileHandle.
 * Used by the viewport drop handler.
 * @param {string} mountKey
 * @param {string} path  relative path (e.g. 'tanks/hull.glb')
 * @returns {FileSystemFileHandle|null}
 */
export function getFileHandle(mountKey, path) {
  return _fileHandles.get(`${mountKey}:${path}`) ?? null;
}

// ── Directory scan ───────────────────────────────────────

async function _scanDirectory(dirHandle, prefix) {
  const node = { name: dirHandle.name, path: prefix, dirs: [], files: [] };
  for await (const [name, entry] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      node.dirs.push(await _scanDirectory(entry, relPath));
    } else {
      const dot = name.lastIndexOf('.');
      const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
      if (SUPPORTED.has(ext)) {
        const kind = TEXTURE_EXT.has(ext) ? 'texture' : 'mesh';
        node.files.push({ name, path: relPath, ext, kind, handle: entry });
      }
    }
  }
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  return node;
}

function _cacheHandles(mountKey, node) {
  for (const f of node.files) _fileHandles.set(`${mountKey}:${f.path}`, f.handle);
  for (const d of node.dirs)  _cacheHandles(mountKey, d);
}

function _findNode(node, relPath) {
  if (!relPath) return node;
  for (const d of node.dirs) {
    if (d.path === relPath) return d;
    if (relPath.startsWith(d.path + '/')) {
      const found = _findNode(d, relPath);
      if (found) return found;
    }
  }
  return null;
}

// ── Tree rendering ───────────────────────────────────────

// Session tab has no tree (one logical bucket); Library tab lists mount roots
// and their subdirectories. The list element is empty on Session — CSS hides
// it via `#ap-tree[data-tab="session"] .ap-tree-list { display: none }`.
function _renderTreeList() {
  if (_activeTab === 'session' || _mounts.size === 0) {
    _listEl.innerHTML = '';
    return;
  }
  const parts = [];
  for (const [mountKey, m] of _mounts) {
    parts.push(_renderTreeBranch(mountKey, m.tree, 0));
  }
  _listEl.innerHTML = parts.join('');

  _listEl.querySelectorAll('[data-tree-row]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const key  = el.dataset.mountKey;
      const path = el.dataset.relPath ?? '';
      const togglerHit = e.target.closest?.('.ap-tree-toggle');
      if (togglerHit) {
        el.classList.toggle('collapsed');
        return;
      }
      _selectedKey  = key;
      _selectedPath = path;
      _listEl.querySelectorAll('[data-tree-row]').forEach(r => r.classList.remove('selected'));
      el.classList.add('selected');
      _renderGrid();
    });
  });
}

function _renderTreeBranch(mountKey, node, depth) {
  const hasChildren = node.dirs.length > 0;
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
    for (const d of node.dirs) html += _renderTreeBranch(mountKey, d, depth + 1);
    html += '</ul>';
  }
  return html;
}

function _renderTreeRow({ label, iconName, key, relPath, depth, hasChildren }) {
  const selected = key === _selectedKey && relPath === _selectedPath ? 'selected' : '';
  const indent = depth * 12;
  const toggler = hasChildren
    ? `<span class="ap-tree-toggle">${icon('ChevronDown', { width: 12, height: 12 })}</span>`
    : `<span class="ap-tree-toggle ap-tree-toggle-empty"></span>`;
  return `
    <li>
      <div class="ap-tree-row ${selected}"
           data-tree-row
           data-mount-key="${key}"
           data-rel-path="${relPath}"
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
  if (_activeTab === 'session') {
    files = _sessionFiles();
  } else if (_mounts.size === 0) {
    _gridEl.innerHTML = `
      <div class="ap-empty">
        No folder mounted. Click <strong>Mount</strong> to pick one — its files
        become draggable across projects.
      </div>`;
    return;
  } else {
    const mount = _mounts.get(_selectedKey);
    if (mount) {
      const node = _findNode(mount.tree, _selectedPath);
      if (node) files = node.files.map(f => ({ ...f, mountKey: _selectedKey }));
    }
  }

  if (!files.length) {
    _gridEl.innerHTML = `
      <div class="ap-empty">
        ${_activeTab === 'session'
          ? 'Drop a 3D file (.glb / .gltf / .obj / .stl / .3mf) onto the viewport, or mount a directory.'
          : 'No supported files in this folder.'}
      </div>`;
    return;
  }

  const cards = files.map(f => _renderCard(f)).join('');
  _gridEl.innerHTML = `<div class="ap-cards">${cards}</div>`;

  _gridEl.querySelectorAll('.ac-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAsset(btn.dataset.assetId);
    });
  });

  _gridEl.querySelectorAll('.asset-card').forEach(card => {
    const mountKey = card.dataset.mountKey;
    const path     = card.dataset.path;
    const filename = card.dataset.filename;
    const kind     = card.dataset.kind ?? 'mesh';

    card.addEventListener('dragstart', e => {
      const payload = JSON.stringify({ mountKey, path, filename, kind });
      e.dataTransfer.setData(DRAG_MIME, payload);
      e.dataTransfer.effectAllowed = 'copy';
    });

    card.addEventListener('dblclick', () => {
      safeAsync(async () => {
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
            directoryHandleKey: mountKey, originalPath: path,
          });
        } else {
          await AssetLoader.loadFromHandle(
            handle,
            new BABYLON.Vector3(0, 0, 0),
            { directoryHandleKey: mountKey, originalPath: path },
          );
        }
      });
    });
  });
}

// Session = every asset registered to this project (loose drops + folder
// loads), regardless of source. Liveness is shown per-card via the
// Linked/Snapshot badge — not by filtering.
function _sessionFiles() {
  const library = getState().scene.assetLibrary;
  return Object.values(library).map(a => ({
    name: a.filename,
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
  const thumbHtml = asset?.thumbnailDataUrl
    ? `<img class="ac-thumb" src="${asset.thumbnailDataUrl}" alt="" draggable="false">`
    : `<div class="ac-thumb ac-thumb-empty">${icon(placeholderIcon, { width: 32, height: 32 })}</div>`;

  let badges = `<span class="ac-ext">${file.ext.slice(1).toUpperCase()}</span>`;
  if (kind === 'mesh' && asset) {
    const ratio = asset.modelRatio ?? 1;
    badges += `<span class="ac-ratio">1:${ratio}</span>`;
    if (asset.unitConfirmed === false) {
      badges += `<span class="ac-unit-badge" title="Source unit unconfirmed: ${asset.sourceUnit}">${icon('AlertTriangle', { width: 11, height: 11 })}${_unitShort(asset.sourceUnit)}</span>`;
    }
  }
  // Liveness badge — only meaningful on the Session tab (Library cards are
  // always live by definition since they're the mounted folder browser).
  if (isSession && asset) {
    const linked = !!(asset.directoryHandleKey || asset.fileHandleKey);
    badges += linked
      ? `<span class="ac-link is-linked" title="Linked to a file on disk — saves stay in sync if the source changes">Linked</span>`
      : `<span class="ac-link is-snapshot" title="Saved as a frozen snapshot — no on-disk source to track">Snapshot</span>`;
  }

  const deleteBtn = isSession && asset
    ? `<button class="ac-delete" data-asset-id="${asset.id}" title="Remove asset">×</button>`
    : '';

  return `
    <div class="asset-card"
         draggable="true"
         data-mount-key="${file.mountKey}"
         data-path="${_escape(file.path)}"
         data-filename="${_escape(file.name)}"
         data-kind="${kind}"
         title="${_escape(file.path)}">
      ${deleteBtn}
      ${thumbHtml}
      <div class="ac-meta">
        <span class="ac-name">${_escape(file.name)}</span>
        <span class="ac-badges">${badges}</span>
      </div>
    </div>
  `;
}

function _findAssetForFile(file) {
  const library = getState().scene.assetLibrary;
  for (const a of Object.values(library)) {
    if (a.directoryHandleKey === file.mountKey && a.originalPath === file.path) return a;
  }
  return null;
}

function _unitShort(unit) {
  return ({ meters: 'm', centimeters: 'cm', millimeters: 'mm', inches: 'in', feet: 'ft' })[unit] ?? unit;
}

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export const AssetPanel = { init, promptMount, promptRemount, getFileHandle };
