import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { getState } from '../core/StateManager.js';
import { push, VisibilityCommand, LockCommand, RenameCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand } from '../core/HistoryManager.js';
import { icon } from '../core/Icons.js';

let _root = null;
let _isOpen = false;

// ── Init ─────────────────────────────────────────────────

/** Initialise the global context menu. Must be called once after DOM is ready. */
export function init() {
  _root = document.createElement('div');
  _root.className = 'context-menu hidden';
  document.body.appendChild(_root);

  document.addEventListener('mousedown', (e) => {
    if (_isOpen && !_root.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (_isOpen && e.key === 'Escape') { e.preventDefault(); close(); }
  });
  window.addEventListener('blur', close);
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
  // Defer the "open" flag to the next frame so the same mousedown that opened
  // the menu doesn't trigger the outside-click close handler.
  requestAnimationFrame(() => {
    _isOpen = true;
    const r = _root.getBoundingClientRect();
    const vpW = window.innerWidth, vpH = window.innerHeight;
    if (r.right > vpW)  _root.style.left = `${Math.max(0, vpW - r.width - 4)}px`;
    if (r.bottom > vpH) _root.style.top  = `${Math.max(0, vpH - r.height - 4)}px`;
  });

  _root.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      close();
      _runAction(action, info);
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
  const hasSelection = Selection.getSelectedIds().length > 0;
  const someGrouped = Selection.getSelectedIds().some(id => !!getState().scene.objects[id]?.parentId);
  const enabled = (cond) => cond ? '' : 'cm-disabled';

  return [
    { label: 'Frame Selection', shortcut: 'F',           action: 'frame',   iconName: 'Maximize',   cls: enabled(hasSelection) },
    'sep',
    { label: 'Toggle Hidden',   shortcut: 'H',           action: 'hide',    iconName: 'EyeOff',     cls: enabled(hasSelection) },
    { label: 'Toggle Lock',     shortcut: '',            action: 'lock',    iconName: 'Lock',       cls: enabled(hasSelection) },
    { label: 'Rename…',         shortcut: 'F2',          action: 'rename',  iconName: 'Edit3',      cls: enabled(hasSelection) },
    { label: 'Duplicate',       shortcut: 'Shift+D',     action: 'duplicate', iconName: 'Copy',     cls: enabled(hasSelection) },
    'sep',
    { label: 'Group',           shortcut: 'Ctrl+G',      action: 'group',   iconName: 'Folder',     cls: enabled(hasSelection) },
    { label: 'Ungroup',         shortcut: 'Ctrl+Shift+G',action: 'ungroup', iconName: 'FolderOpen', cls: enabled(someGrouped) },
    'sep',
    { label: 'Delete',          shortcut: 'Del',         action: 'delete',  iconName: 'Trash2',     cls: enabled(hasSelection) + ' cm-danger' },
  ];
}

function _renderItem(item) {
  return `
    <div class="cm-item ${item.cls ?? ''}" data-action="${item.action}">
      <span class="cm-icon">${icon(item.iconName, { width: 13, height: 13 })}</span>
      <span class="cm-label">${item.label}</span>
      <span class="cm-shortcut">${item.shortcut ?? ''}</span>
    </div>
  `;
}

// ── Actions ──────────────────────────────────────────────

function _runAction(action, info) {
  if (action === 'frame')     _frame();
  if (action === 'hide')      _toggleHide();
  if (action === 'lock')      _toggleLock();
  if (action === 'rename')    _renameActive();
  if (action === 'duplicate') _duplicate();
  if (action === 'group')     _group();
  if (action === 'ungroup')   _ungroup();
  if (action === 'delete')    _delete();
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

export const ContextMenu = { init, open, close };
