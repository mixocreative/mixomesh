import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { getState, setState, dispatch } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { push, VisibilityCommand, LockCommand, RenameCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand, SmartReplaceCommand, TransformSwabCommand } from '../core/HistoryManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';

let _root = null;
let _isOpen = false;
let _ignoreNextClose = false;

// ── Init ─────────────────────────────────────────────────

/** Initialise the global context menu. Must be called once after DOM is ready. */
export function init() {
  _root = document.createElement('div');
  _root.className = 'context-menu hidden';
  _root.setAttribute('role', 'menu');
  document.body.appendChild(_root);

  // Capture-phase pointerdown so we close before any downstream canvas
  // selection / drag handler runs. The _ignoreNextClose flag swallows the very
  // pointerdown that opens the menu so it doesn't immediately self-close.
  document.addEventListener('pointerdown', (e) => {
    if (!_isOpen) return;
    if (_root.contains(e.target)) return;
    if (_ignoreNextClose) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (_isOpen && e.key === 'Escape') { e.preventDefault(); close(); }
  });
  window.addEventListener('blur', close);
  // Scroll / resize should dismiss the menu so it doesn't float orphaned.
  window.addEventListener('wheel',  () => { if (_isOpen) close(); }, { passive: true });
  window.addEventListener('resize', () => { if (_isOpen) close(); });
}

/**
 * Open the context menu at viewport coordinates (x, y).
 * @param {{ x:number, y:number, source:'viewport'|'outliner', targetId?:string, targetKind?:string }} info
 */
export function open(info) {
  if (!_root) return;
  const items = _buildItems(info);
  _root.innerHTML = items
    .map(i => i === 'sep' ? `<div class="cm-sep"></div>` : _renderItem(i))
    .join('');
  // Position with viewport-edge clamp.
  _root.style.left = `${info.x}px`;
  _root.style.top  = `${info.y}px`;
  _root.classList.remove('hidden');
  // Mark open synchronously so subsequent pointerdown closes deterministically.
  // The pointerdown that opened us is suppressed via _ignoreNextClose, which
  // unlatches on the next macrotask — covers RMB's pointerdown + contextmenu
  // sequence without blocking the next user click.
  _isOpen = true;
  _ignoreNextClose = true;
  setTimeout(() => { _ignoreNextClose = false; }, 0);
  // Edge clamp after the browser lays it out.
  requestAnimationFrame(() => {
    const r = _root.getBoundingClientRect();
    const vpW = window.innerWidth, vpH = window.innerHeight;
    if (r.right > vpW)  _root.style.left = `${Math.max(0, vpW - r.width - 4)}px`;
    if (r.bottom > vpH) _root.style.top  = `${Math.max(0, vpH - r.height - 4)}px`;
  });

  _root.querySelectorAll('[data-action]').forEach(el => {
    const run = () => {
      const action = el.dataset.action;
      close();
      _runAction(action, info);
    };
    el.addEventListener('click', run);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      run();
    });
  });
}

/** Close the context menu if open. */
export function close() {
  if (!_root) return;
  _root.classList.add('hidden');
  _isOpen = false;
}

// ── Item rendering ───────────────────────────────────────

function _buildItems(info) {
  if (info.targetKind === 'collection' && info.targetId) {
    return [
      { label: 'Select Members',     shortcut: '',  action: 'col-select', iconName: 'Box',      cls: '' },
      { label: 'Rename Collection…', shortcut: '',  action: 'col-rename', iconName: 'Edit3',    cls: '' },
      'sep',
      { label: 'Delete Collection',  shortcut: '',  action: 'col-delete', iconName: 'Trash2',   cls: 'cm-danger' },
    ];
  }

  const selIds = Selection.getSelectedIds();
  const hasSelection = selIds.length > 0;
  const multi = selIds.length > 1;
  const someGrouped = selIds.some(id => !!getState().scene.objects[id]?.parentId);
  const enabled = (cond) => cond ? '' : 'cm-disabled';

  const objs = getState().scene.objects;
  const ghostId = info.targetKind === 'object' && info.targetId
    && (objs[info.targetId]?.isGhost || objs[info.targetId]?.isUnlinked)
    ? info.targetId : null;

  return [
    ...(ghostId ? [
      { label: objs[ghostId].isGhost ? 'Relink Asset…' : 'Relink to live file…',
        shortcut: '', action: 'relink', iconName: 'Link', cls: '' },
      'sep',
    ] : []),
    { label: 'Focus',           shortcut: 'F',           action: 'frame',   iconName: 'Focus',      cls: enabled(hasSelection) },
    'sep',
    { label: 'Toggle Hidden',   shortcut: 'H',           action: 'hide',    iconName: 'EyeOff',     cls: enabled(hasSelection) },
    { label: 'Toggle Lock',     shortcut: '',            action: 'lock',    iconName: 'Lock',       cls: enabled(hasSelection) },
    { label: 'Rename…',         shortcut: 'F2',          action: 'rename',  iconName: 'Edit3',      cls: enabled(hasSelection) },
    { label: 'Duplicate',       shortcut: 'Shift+D',     action: 'duplicate', iconName: 'Copy',     cls: enabled(hasSelection) },
    'sep',
    { label: 'Group',           shortcut: 'Ctrl+G',      action: 'group',   iconName: 'Folder',     cls: enabled(hasSelection) },
    { label: 'Ungroup',         shortcut: 'Ctrl+Shift+G',action: 'ungroup', iconName: 'FolderOpen', cls: enabled(someGrouped) },
    'sep',
    { label: 'Smart Replace',   shortcut: '',            action: 'replace', iconName: 'RefreshCw',  cls: enabled(multi) },
    { label: 'Transform Swab',  shortcut: '',            action: 'swab',    iconName: 'Pipette',    cls: enabled(multi) },
    'sep',
    { label: 'Delete',          shortcut: 'Del',         action: 'delete',  iconName: 'Trash2',     cls: enabled(hasSelection) + ' cm-danger' },
  ];
}

function _renderItem(item) {
  return `
    <div class="cm-item ${escapeAttr(item.cls ?? '')}" data-action="${escapeAttr(item.action)}" role="menuitem" tabindex="0">
      <span class="cm-icon">${icon(item.iconName, { width: 13, height: 13 })}</span>
      <span class="cm-label">${escapeHtml(item.label)}</span>
      <span class="cm-shortcut">${escapeHtml(item.shortcut ?? '')}</span>
    </div>
  `;
}

// ── Actions ──────────────────────────────────────────────

function _runAction(action, info) {
  if (action === 'frame')      _frame();
  if (action === 'hide')       _toggleHide();
  if (action === 'lock')       _toggleLock();
  if (action === 'rename')     _renameActive();
  if (action === 'duplicate')  _duplicate();
  if (action === 'group')      _group();
  if (action === 'ungroup')    _ungroup();
  if (action === 'delete')     _delete();
  if (action === 'replace')    _smartReplace();
  if (action === 'swab')       _transformSwab();
  if (action === 'relink')     _relink(info.targetId);
  if (action === 'col-select') _selectCollectionMembers(info.targetId);
  if (action === 'col-rename') _renameCollection(info.targetId);
  if (action === 'col-delete') _deleteCollection(info.targetId);
}

function _smartReplace() {
  const ids = Selection.getSelectedIds();
  const activeId = Selection.getActiveId();
  if (ids.length < 2 || !activeId) return;
  push(new SmartReplaceCommand(ids, activeId));
}

function _transformSwab() {
  const ids = Selection.getSelectedIds();
  const activeId = Selection.getActiveId();
  if (ids.length < 2 || !activeId) return;
  push(new TransformSwabCommand(ids, activeId));
}

function _relink(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj?.assetId) return;
  safeAsync(() => PersistenceManager.relinkAsset(obj.assetId));
}

function _frame() {
  const meshes = Selection.getSelectedResolved().map(r => r.mesh);
  if (meshes.length) SceneManager.frameSelected(meshes);
}

function _toggleHide() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  const objects = getState().scene.objects;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.visible;
  const anyVisible = ids.some(id => objects[id]?.visible);
  push(new VisibilityCommand(ids, prev, !anyVisible));
}

function _toggleLock() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  const objects = getState().scene.objects;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.locked;
  const anyUnlocked = ids.some(id => !objects[id]?.locked);
  push(new LockCommand(ids, prev, anyUnlocked));
}

function _renameActive() {
  const activeId = Selection.getActiveId();
  if (!activeId) return;
  const obj = getState().scene.objects[activeId] ?? getState().scene.groups[activeId];
  if (!obj) return;
  const next = window.prompt('Rename to:', obj.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === obj.name) return;
  push(new RenameCommand(activeId, obj.name, trimmed));
}

function _duplicate() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new DuplicateCommand(ids));
}

function _group() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new GroupCommand(ids));
}

function _ungroup() {
  const ids = Selection.getSelectedIds();
  const objects = getState().scene.objects;
  const groupIds = new Set();
  for (const id of ids) {
    const o = objects[id];
    if (o?.parentId) groupIds.add(o.parentId);
  }
  if (!groupIds.size) return;
  for (const gid of groupIds) push(new UngroupCommand(gid));
}

function _delete() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new DeleteCommand(ids));
}

function _selectCollectionMembers(collectionId) {
  const ids = Object.values(getState().scene.objects)
    .filter(o => o.collectionId === collectionId)
    .map(o => o.id);
  if (ids.length) Selection.set(ids, ids[ids.length - 1]);
}

function _renameCollection(collectionId) {
  const col = getState().scene.collections?.[collectionId];
  if (!col) return;
  const next = window.prompt('Rename collection to:', col.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === col.name) return;
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      collections: { ...s.scene.collections, [collectionId]: { ...col, name: trimmed } },
    },
  }));
  dispatch(EVENTS.COLLECTION_RENAMED, { collectionId, name: trimmed });
}

function _deleteCollection(collectionId) {
  const col = getState().scene.collections?.[collectionId];
  if (!col) return;
  const memberCount = Object.values(getState().scene.objects).filter(o => o.collectionId === collectionId).length;
  if (memberCount > 0 && !window.confirm(`Delete collection "${col.name}"? Its ${memberCount} member${memberCount === 1 ? '' : 's'} will become uncollected.`)) return;

  setState(s => {
    const nextObjects = { ...s.scene.objects };
    for (const [id, obj] of Object.entries(nextObjects)) {
      if (obj.collectionId === collectionId) nextObjects[id] = { ...obj, collectionId: null };
    }
    const nextCols = { ...s.scene.collections };
    delete nextCols[collectionId];
    return { ...s, scene: { ...s.scene, objects: nextObjects, collections: nextCols } };
  });
  dispatch(EVENTS.COLLECTION_REMOVED, { collectionId });
}

export const ContextMenu = { init, open, close };
