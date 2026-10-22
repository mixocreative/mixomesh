import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { CursorTools } from '../core/CursorTools.js';
import { getState } from '../core/StateManager.js';
import { push, VisibilityCommand, LockCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand, UnparentCommand, SmartReplaceCommand, TransformSwabCommand, AlignCommand, MirrorCommand, ArrayCommand, MateCommand, BedPlacementCommand, SplitToPartsCommand, JoinCommand, performBoolean } from '../core/HistoryManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { ViewportDrop } from './ViewportDrop.js';
import { logicalObjectPartIds, shouldDisplayObject, canonicalObjectId } from '../core/LogicalObjects.js';
import { cascadeObjectIds, cascadeLockIds, groupDescendantObjectIds } from '../core/hierarchy/GroupCascade.js';
import { safeAsync, Toast } from './Toast.js';
import { repairWithOverlay } from './RepairFeedback.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { Modal } from './Modal.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { t } from '../i18n/index.js';
import { Outliner } from './Outliner.js';
import { PrintPanel } from './PrintPanel.js';
import { SliceConnectorSession } from './SliceConnectorSession.js';

let _root = null;
let _isOpen = false;
let _ignoreNextClose = false;
// Submenu panels (key → element) for the currently open menu.
const _subEls = new Map();

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
    for (const el of _subEls.values()) if (el.contains(e.target)) return;
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

  // Bake-or-cancel gate for combining textured objects (ADR 0002): Boolean drops
  // UVs, so the user must consciously downgrade to a solid colour.
  // 匯出所選物件… — pick a format, then the Print panel's shared gate/overlay
  // path exports the current selection as its own file (flag ignored).
  Modal.register('exportSelected', ({ close }) => {
    const el = document.createElement('div');
    el.className = 'modal-content';
    el.innerHTML = `
      <h3>${escapeHtml(t('print.exportSelected.title'))}</h3>
      <p>${escapeHtml(t('print.exportSelected.body'))}</p>
      <div class="modal-actions">
        <button class="btn btn-primary" data-f="3mf">${escapeHtml(t('print.export3mf'))}</button>
        <button class="btn" data-f="obj">${escapeHtml(t('print.exportObj'))}</button>
        <button class="btn" data-f="stl">${escapeHtml(t('print.exportStl'))}</button>
        <button class="btn" data-f="">${escapeHtml(t('btn.cancel'))}</button>
      </div>`;
    el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
      const f = b.dataset.f; close();
      if (f) safeAsync(() => PrintPanel.exportSelected(f));
    }));
    return el;
  });
  Modal.register('booleanTextureBake', ({ close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `
      <h2 class="pm-modal-title">${escapeHtml(t('boolean.bakeTitle'))}</h2>
      <p class="pm-modal-body">${escapeHtml(t('boolean.bakeBody'))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">${escapeHtml(t('boolean.bakeCancel'))}</button>
        <button class="btn btn-primary" data-r="bake">${escapeHtml(t('boolean.bakeConfirm'))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });
}

/**
 * Open the context menu at viewport coordinates (x, y).
 * @param {{ x:number, y:number, source:'viewport'|'outliner', targetId?:string, targetKind?:string }} info
 */
let _lastInfo = null;

export function open(info) {
  if (!_root) return;
  _lastInfo = info;
  _discardSubmenus();
  const items = _buildItems(info);
  _root.innerHTML = _renderList(items);
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
  // Edge clamp. getBoundingClientRect forces layout synchronously, so no
  // rAF is needed — and a rAF never fires in a background tab, which left a
  // 30-item menu hanging off the bottom of the window (sweep 2026-09-18).
  // The CSS max-height + overflow-y is the fallback for a window shorter
  // than the menu itself.
  {
    const r = _root.getBoundingClientRect();
    const vpW = window.innerWidth, vpH = window.innerHeight;
    if (r.right > vpW)  _root.style.left = `${Math.max(0, vpW - r.width - 4)}px`;
    if (r.bottom > vpH) _root.style.top  = `${Math.max(0, vpH - r.height - 4)}px`;
  }

  _wireActions(_root, info);
  _wireSubmenus(info, items);
}

/** Close the context menu if open. */
export function close() {
  if (!_root) return;
  _root.classList.add('hidden');
  _discardSubmenus();
  _isOpen = false;
}

function _discardSubmenus() {
  for (const el of _subEls.values()) el.remove();
  _subEls.clear();
}

// ── Item rendering ───────────────────────────────────────

function _buildItems(info) {
  const selIds = Selection.getSelectedIds();
  const hasSelection = selIds.length > 0;
  // Right-click on EMPTY viewport space (nothing under the cursor): a short
  // scene menu instead of thirty greyed-out object actions (owner ask
  // 2026-09-19). With a selection the object actions follow below it.
  if (info.source === 'viewport' && info.hit === false) {
    const emptyItems = [
      { label: t('context.importModel'), shortcut: '', action: 'import-model', iconName: 'FilePlus', cls: '' },
      { label: t('context.openProject'), shortcut: 'Ctrl+O', action: 'open-project', iconName: 'FolderOpen', cls: '' },
      'sep',
      { label: t('context.frameAll'), shortcut: '', action: 'frame-all', iconName: 'Focus', cls: '' },
      { label: t('context.cursorToWorldOrigin'), shortcut: '', action: 'cursor-to-origin', iconName: 'Crosshair', cls: '' },
    ];
    if (!hasSelection) return emptyItems;
    return [...emptyItems, 'sep', ..._objectItems(info, selIds)];
  }
  return _objectItems(info, selIds);
}

// The group "Enter group" would enter: the single selected group, or the
// parent of the single selected object. null when there is nothing to enter.
function _enterTarget(selIds) {
  if (selIds.length !== 1) return null;
  const { objects, groups } = getState().scene;
  const id = selIds[0];
  return groups[id] && !objects[id] ? id : (objects[id]?.parentId ?? null);
}

// Plan §4.6 tiering: ≤ 12 primary items, then four submenu headers (≤ 16
// top-level entries with one object selected). Everything else lives in the
// submenus, rendered as hidden sibling panels (see open()).
function _objectItems(info, selIds) {
  const scene = getState().scene;
  const objs = scene.objects;
  const groups = scene.groups;
  const hasSelection = selIds.length > 0;
  const multi = selIds.length > 1;
  const someGrouped = selIds.some(id => !!(objs[id]?.parentId ?? groups[id]?.parentId));
  const enabled = (cond) => cond ? '' : 'cm-disabled';

  const ghostId = info.targetKind === 'object' && info.targetId
    && (objs[info.targetId]?.isGhost || objs[info.targetId]?.isUnlinked)
    ? info.targetId : null;
  const focusId = info.targetId ?? selIds[0];
  const hasParent = !!(objs[focusId]?.parentId ?? groups[focusId]?.parentId);

  const visIds = cascadeObjectIds(selIds, scene);
  const allHidden = visIds.length > 0 && visIds.every(id => objs[id]?.visible === false);
  const lockIds = cascadeLockIds(selIds, scene);
  const allLocked = lockIds.length > 0 && lockIds.every(id => (objs[id] ?? groups[id])?.locked);

  const enterTarget = _enterTarget(selIds);
  const canEnter = enterTarget != null && enterTarget !== Selection.getScope();
  const canExit = !canEnter && Selection.getScope() != null;
  const activeShader = objs[Selection.getActiveId()]?.shaderId ?? null;

  const lastPrimary = ghostId
    ? { label: objs[ghostId].isGhost ? t('context.relinkAsset') : t('context.relinkLiveFile'),
        shortcut: '', action: 'relink', iconName: 'Link', cls: '' }
    : (info.source === 'viewport'
      ? { label: t('context.revealOutliner'), shortcut: '', action: 'reveal-outliner', iconName: 'LocateFixed', cls: enabled(hasSelection) }
      : null);

  const arrange = [
    { label: t('context.mate'),           shortcut: '', action: 'mate',    iconName: 'Crosshair', cls: enabled(multi) },
    { label: t('context.transformSwab'),  shortcut: '', action: 'swab',    iconName: 'Pipette',   cls: enabled(multi) },
    { label: t('context.smartReplace'),   shortcut: '', action: 'replace', iconName: 'RefreshCw', cls: enabled(multi) },
    'sep',
    { label: t('context.alignCenterX'),   shortcut: '', action: 'align-x-center', iconName: 'Crosshair', cls: enabled(multi) },
    { label: t('context.alignCenterY'),   shortcut: '', action: 'align-y-center', iconName: 'Crosshair', cls: enabled(multi) },
    { label: t('context.alignCenterZ'),   shortcut: '', action: 'align-z-center', iconName: 'Crosshair', cls: enabled(multi) },
    'sep',
    { label: t('placement.dropToBed'),    shortcut: '', action: 'drop-bed',   iconName: 'Download',  cls: enabled(hasSelection) },
    { label: t('placement.centerOnBed'),  shortcut: '', action: 'center-bed', iconName: 'Crosshair', cls: enabled(hasSelection) },
    { label: t('placement.placeFaceOnBed'), shortcut: '', action: 'face-bed', iconName: 'RotateCw',  cls: enabled(hasSelection && !!info.faceNormal) },
    'sep',
    { label: t('context.mirrorX'),        shortcut: '', action: 'mirror-x', iconName: 'Box',  cls: enabled(hasSelection) },
    { label: t('context.mirrorY'),        shortcut: '', action: 'mirror-y', iconName: 'Box',  cls: enabled(hasSelection) },
    { label: t('context.mirrorZ'),        shortcut: '', action: 'mirror-z', iconName: 'Box',  cls: enabled(hasSelection) },
    { label: t('context.arrayX'),         shortcut: '', action: 'array-x',  iconName: 'Copy', cls: enabled(hasSelection) },
    { label: t('context.arrayY'),         shortcut: '', action: 'array-y',  iconName: 'Copy', cls: enabled(hasSelection) },
    { label: t('context.arrayZ'),         shortcut: '', action: 'array-z',  iconName: 'Copy', cls: enabled(hasSelection) },
    'sep',
    { label: t('context.selectionToCursor'),   shortcut: '', action: 'sel-to-cursor',    iconName: 'Crosshair', cls: enabled(hasSelection) },
    { label: t('context.cursorToSelection'),   shortcut: '', action: 'cursor-to-sel',    iconName: 'Crosshair', cls: enabled(hasSelection) },
    { label: t('context.cursorToWorldOrigin'), shortcut: '', action: 'cursor-to-origin', iconName: 'Crosshair', cls: '' },
    'sep',
    { label: t('context.unparent'),       shortcut: '', action: 'unparent', iconName: 'GitBranch', cls: enabled(someGrouped) },
  ];
  const combine = [
    { label: t('context.booleanUnion'),     shortcut: '', action: 'bool-union',      iconName: 'Box',      cls: enabled(multi) },
    { label: t('context.booleanSubtract'),  shortcut: '', action: 'bool-subtract',   iconName: 'Box',      cls: enabled(multi) },
    { label: t('context.booleanIntersect'), shortcut: '', action: 'bool-intersect',  iconName: 'Box',      cls: enabled(multi) },
    'sep',
    { label: t('context.sliceConnector'),   shortcut: '', action: 'slice-connector', iconName: 'Scissors', cls: enabled(hasSelection && !multi) },
  ];
  const material = [
    { label: t('context.splitToParts'), shortcut: '', action: 'split-parts', iconName: 'Scissors',
      cls: enabled(!!info.targetId && logicalObjectPartIds(info.targetId, objs).length > 1) },
    { label: t('context.join'),         shortcut: '', action: 'join', iconName: 'Combine',
      cls: enabled(new Set(selIds.map(id => canonicalObjectId(id, objs))).size > 1) },
    'sep',
    { label: t('context.editMaterial'), shortcut: '', action: 'edit-material', iconName: 'Palette', cls: enabled(!!activeShader) },
  ];
  const exports = [
    { label: t('print.export3mf'), shortcut: '', action: 'export-3mf', iconName: 'Download', cls: enabled(hasSelection) },
    { label: t('print.exportObj'), shortcut: '', action: 'export-obj', iconName: 'Download', cls: enabled(hasSelection) },
    { label: t('print.exportStl'), shortcut: '', action: 'export-stl', iconName: 'Download', cls: enabled(hasSelection) },
  ];

  return [
    { label: t('context.rename'),    shortcut: 'F2',           action: 'rename',    iconName: 'Edit3', cls: enabled(hasSelection) },
    { label: t('context.duplicate'), shortcut: 'Shift+D',      action: 'duplicate', iconName: 'Copy',  cls: enabled(hasSelection) },
    { label: t('context.delete'),    shortcut: 'Del',          action: 'delete',    iconName: 'Trash2', cls: enabled(hasSelection) + ' cm-danger' },
    'sep',
    { label: t('context.group'),      shortcut: 'Ctrl+G',       action: 'group',   iconName: 'Folder',     cls: enabled(hasSelection) },
    { label: t('context.ungroup'),    shortcut: 'Ctrl+Shift+G', action: 'ungroup', iconName: 'FolderOpen', cls: enabled(UngroupCommand.targetsFor(selIds).length > 0) },
    canExit
      ? { label: t('context.exitGroup'),  shortcut: 'Esc', action: 'exit-group',  iconName: 'FolderOpen', cls: '' }
      : { label: t('context.enterGroup'), shortcut: '',    action: 'enter-group', iconName: 'Folder',     cls: enabled(canEnter) },
    'sep',
    { label: t(allHidden ? 'outliner.show' : 'outliner.hide'), shortcut: 'H', action: 'hide', iconName: allHidden ? 'Eye' : 'EyeOff', cls: enabled(hasSelection) },
    { label: t(allLocked ? 'outliner.unlock' : 'outliner.lock'), shortcut: '', action: 'lock', iconName: allLocked ? 'Unlock' : 'Lock', cls: enabled(hasSelection) },
    { label: t('context.focus'),        shortcut: 'F', action: 'frame',         iconName: 'Focus',     cls: enabled(hasSelection) },
    { label: t('context.selectParent'), shortcut: '',  action: 'select-parent', iconName: 'GitBranch', cls: enabled(hasParent) },
    { label: t('context.repairGeometry'), shortcut: '', action: 'repair-geometry', iconName: 'AlertTriangle', cls: enabled(hasSelection) },
    ...(lastPrimary ? [lastPrimary] : []),
    'sep',
    { label: t('context.arrange'),  submenu: 'arrange',  children: arrange,  iconName: 'Grid3x3' },
    { label: t('context.combine'),  submenu: 'combine',  children: combine,  iconName: 'Combine' },
    { label: t('context.material'), submenu: 'material', children: material, iconName: 'Palette' },
    { label: t('context.export'),   submenu: 'export',   children: exports,  iconName: 'Upload' },
  ];
}

function _renderItem(item) {
  if (item.submenu) {
    return `
    <div class="cm-item cm-parent" data-submenu="${escapeAttr(item.submenu)}" role="menuitem" aria-haspopup="menu" aria-expanded="false" tabindex="0">
      <span class="cm-icon">${icon(item.iconName, { width: 13, height: 13 })}</span>
      <span class="cm-label">${escapeHtml(item.label)}</span>
      <span class="cm-chevron">${icon('ChevronRight', { width: 12, height: 12 })}</span>
    </div>
  `;
  }
  return `
    <div class="cm-item ${escapeAttr(item.cls ?? '')}" data-action="${escapeAttr(item.action)}" role="menuitem" tabindex="0">
      <span class="cm-icon">${icon(item.iconName, { width: 13, height: 13 })}</span>
      <span class="cm-label">${escapeHtml(item.label)}</span>
      <span class="cm-shortcut">${escapeHtml(item.shortcut ?? '')}</span>
    </div>
  `;
}

function _renderList(items) {
  return items.map(i => i === 'sep' ? `<div class="cm-sep"></div>` : _renderItem(i)).join('');
}

// ── Submenus ─────────────────────────────────────────────
// A submenu is a hidden sibling `.context-menu.cm-submenu` appended to <body>
// (a child of the root would be clipped by its overflow-y). All four exist in
// the DOM while the menu is open; only the hovered/activated one is shown.

function _closeSubmenus() {
  for (const el of _subEls.values()) el.classList.add('hidden');
  _root?.querySelectorAll('[data-submenu]').forEach(h => h.setAttribute('aria-expanded', 'false'));
}

function _openSubmenu(key, anchor, focusFirst = false) {
  const panel = _subEls.get(key);
  if (!panel) return;
  _closeSubmenus();
  panel.classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true');
  const a = anchor.getBoundingClientRect();
  const vpW = window.innerWidth, vpH = window.innerHeight;
  panel.style.left = `${a.right + 2}px`;
  panel.style.top = `${a.top - 4}px`;
  const r = panel.getBoundingClientRect();
  if (r.right > vpW) panel.style.left = `${Math.max(0, a.left - r.width - 2)}px`;
  if (r.bottom > vpH) panel.style.top = `${Math.max(0, vpH - r.height - 4)}px`;
  if (focusFirst) panel.querySelector('.cm-item:not(.cm-disabled)')?.focus();
}

function _wireActions(container, info) {
  container.querySelectorAll('[data-action]').forEach(el => {
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

function _wireSubmenus(info, items) {
  const parents = items.filter(i => i !== 'sep' && i.submenu);
  for (const item of parents) {
    const panel = document.createElement('div');
    panel.className = 'context-menu cm-submenu hidden';
    panel.setAttribute('role', 'menu');
    panel.dataset.submenuFor = item.submenu;
    panel.innerHTML = _renderList(item.children);
    document.body.appendChild(panel);
    _subEls.set(item.submenu, panel);
    _wireActions(panel, info);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft') return;
      e.preventDefault();
      e.stopPropagation();
      const header = _root.querySelector(`[data-submenu="${item.submenu}"]`);
      _closeSubmenus();
      header?.focus();
    });
  }
  _root.querySelectorAll('[data-submenu]').forEach(header => {
    const key = header.dataset.submenu;
    header.addEventListener('click', () => _openSubmenu(key, header));
    header.addEventListener('pointerenter', () => _openSubmenu(key, header));
    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      _openSubmenu(key, header, true);
    });
  });
  // Hovering any plain top-level item dismisses an open submenu.
  _root.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('pointerenter', _closeSubmenus);
  });
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
  if (action === 'unparent')   _unparent(info);
  if (action === 'delete')     _delete();
  if (action === 'replace')    _smartReplace();
  if (action === 'swab')       _transformSwab();
  if (action.startsWith('align-')) _align(action);
  if (action.startsWith('mirror-')) _mirror(action);
  if (action.startsWith('array-')) _array(action.split('-')[1]);
  if (action === 'mate') _mate();
  if (action.startsWith('bool-'))  safeAsync(() => _boolean(action.slice(5)));
  if (action === 'repair-geometry') safeAsync(() => _repairGeometry());
  if (action === 'export-selected') Modal.open('exportSelected', {});
  if (action === 'export-3mf' || action === 'export-obj' || action === 'export-stl') {
    const format = action.slice(7);
    safeAsync(() => PrintPanel.exportSelected(format));
  }
  if (action === 'enter-group') _enterGroup();
  if (action === 'exit-group') Selection.exitScope();
  if (action === 'edit-material') _editMaterial();
  if (action === 'import-model') safeAsync(() => ViewportDrop.promptImport());
  if (action === 'open-project') safeAsync(() => PersistenceManager.open());
  if (action === 'frame-all') SceneManager.frameAll();
  if (action === 'split-parts') _splitToParts(_lastInfo?.targetId);
  if (action === 'join') _join();
  if (action === 'slice-connector') SliceConnectorSession.start();
  if (action === 'sel-to-cursor') CursorTools.selectionToCursor();
  if (action === 'cursor-to-sel') CursorTools.cursorToSelection();
  if (action === 'cursor-to-origin') CursorTools.cursorToWorldOrigin();
  if (action === 'drop-bed' || action === 'center-bed') {
    const command = new BedPlacementCommand(Selection.getSelectedIds(), action === 'drop-bed' ? 'drop' : 'center');
    if (command.affectedIds.length) push(command);
    if (command.skippedIds.length) Toast.show(t('placement.lockedSkipped', { n: command.skippedIds.length }), 'warning', 3000);
  }
  if (action === 'face-bed' && info.faceNormal) {
    const activeId = Selection.getActiveId();
    if (activeId) {
      const command = new BedPlacementCommand([activeId], 'face', { faceNormal: info.faceNormal });
      if (command.affectedIds.length) push(command);
      if (command.skippedIds.length) Toast.show(t('placement.lockedSkipped', { n: command.skippedIds.length }), 'warning', 3000);
    }
  }
  if (action === 'relink')     _relink(info.targetId);
  if (action === 'select-parent') _selectParent(info.targetId ?? Selection.getActiveId());
  if (action === 'reveal-outliner') Outliner.reveal(info.targetId ?? Selection.getActiveId());
}

function _groupMemberIds(groupId) {
  const { groups, objects } = getState().scene;
  const root = groups[groupId];
  if (!root) return [];
  const ids = [];
  const stack = [root];
  while (stack.length) {
    const group = stack.pop();
    for (const id of group.childIds ?? []) {
      if (objects[id] && shouldDisplayObject(objects[id])) ids.push(id);
    }
    for (const child of Object.values(groups)) if (child.parentId === group.id) stack.push(child);
  }
  return ids;
}

// Select the parent group of an object or group (the parent is itself a
// selectable unit since 2.1, so it is selected whole, not expanded).
function _selectParent(targetId) {
  const { objects, groups } = getState().scene;
  const parentId = objects[targetId]?.parentId ?? groups[targetId]?.parentId;
  if (parentId) Selection.set([parentId], parentId);
}

// Enter the group (click-depth scope, 3.2): scope = the group, and the picked
// object (when the selection is a child) stays selected one level deeper.
function _enterGroup() {
  const ids = Selection.getSelectedIds();
  const target = _enterTarget(ids);
  if (!target) return;
  const { objects } = getState().scene;
  const picked = objects[ids[0]] ? ids[0] : (groupDescendantObjectIds(target, getState().scene)[0] ?? null);
  Selection.enterScope(target, picked);
}

function _editMaterial() {
  const shaderId = getState().scene.objects[Selection.getActiveId()]?.shaderId;
  if (!shaderId) return;
  import('./ShaderPanel.js').then(m => m.focus?.(shaderId));
}

function _smartReplace() {
  const ids = Selection.getSelectedIds();
  const activeId = Selection.getActiveId();
  if (ids.length < 2 || !activeId) return;
  // SmartReplaceCommand clones only the lead mesh and replaces by lead only:
  // multi-part logical objects (MultiMaterial split / glTF multi-primitive)
  // would lose the active's sibling parts and orphan the targets' non-lead
  // parts. Gate it off until the command routes through the logical layer.
  const objects = getState().scene.objects;
  const multiPart = ids.some(id => logicalObjectPartIds(id, objects).length > 1);
  if (multiPart) {
    Toast.show(t('toast.smartReplaceMultiPart'), 'warning', 4000);
    return;
  }
  push(new SmartReplaceCommand(ids, activeId));
}

function _transformSwab() {
  const ids = Selection.getSelectedIds();
  const activeId = Selection.getActiveId();
  if (ids.length < 2 || !activeId) return;
  push(new TransformSwabCommand(ids, activeId));
}

// Align the selection on one world axis (ADR 0003). action = `align-<axis>-<mode>`.
function _align(action) {
  const ids = Selection.getSelectedIds();
  if (ids.length < 2) return;
  const [, axis, mode] = action.split('-');
  push(new AlignCommand(ids, axis, mode));
}

// Mirror single-part objects about their centre on a world axis (ADR 0003).
function _mirror(action) {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new MirrorCommand(ids, action.split('-')[1]));
}

// Linear array of the active object along a world axis. Auto-spacing = the object's
// own width on that axis (copies abut), count 3. A count/spacing dialog is future UX.
function _array(axis) {
  const id = Selection.getActiveId();
  const m = id && AssetLoader.getBabylonMesh(id);
  if (!m) return;
  m.computeWorldMatrix(true);
  const bb = m.getBoundingInfo().boundingBox;
  const width = Math.abs(bb.maximumWorld[axis] - bb.minimumWorld[axis]) || 0.1;
  push(new ArrayCommand(id, 3, axis, width));
}

// Mate: abut the other selected objects against the active one (auto axis/side).
function _mate() {
  const ids = Selection.getSelectedIds();
  const activeId = Selection.getActiveId();
  if (ids.length < 2 || !activeId) return;
  push(new MateCommand(ids, activeId));
}

// Interactive Boolean (ADR 0002). performBoolean is async (CSG2 + serialise); it
// applies the change + returns an already-applied command to push, or a blocked
// reason to surface.
const BOOLEAN_TITLES = { union: 'context.booleanUnion', subtract: 'context.booleanSubtract', intersect: 'context.booleanIntersect' };

/** Run a Boolean under the blocking overlay (it runs in a worker, so the UI
 *  would otherwise stay editable mid-run); Cancel aborts it. */
async function _runBoolean(ids, op, opts = {}) {
  const controller = new AbortController();
  const overlay = ProgressOverlay.open(t(BOOLEAN_TITLES[op] ?? 'progress.working'), { controller });
  try {
    return await performBoolean(ids, op, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  } finally {
    overlay.close();
  }
}

function _booleanToastKey(reason) {
  return reason === 'multi-part' ? 'toast.booleanMultiPart'
    : reason === 'too-large' ? 'toast.booleanTooLarge'
    : reason === 'busy' ? 'toast.booleanBusy'
    : reason === 'changed-during-boolean' ? 'toast.booleanChanged'
    : 'toast.booleanBlocked';
}

async function _boolean(op) {
  const ids = Selection.getSelectedIds();
  if (ids.length < 2) return;
  const res = await _runBoolean(ids, op);
  if (!res) return;   // cancelled
  if (res && res.blocked) {
    if (res.reason === 'needs-texture-bake') {
      // Offer to downgrade to solid colour + combine (CSG2 can't keep UVs).
      Modal.open('booleanTextureBake', { onClose: (r) => {
        if (r !== 'bake') return;
        safeAsync(async () => {
          const baked = await _runBoolean(ids, op, { bakeTexturedToSolid: true });
          if (!baked) return;
          if (baked.blocked) Toast.show(t(_booleanToastKey(baked.reason), { reason: baked.reason }), 'warning', 4000);
          else push(baked);
        });
      } });
      return;
    }
    Toast.show(t(_booleanToastKey(res.reason), { reason: res.reason }), 'warning', 4000);
    return;
  }
  push(res);
}

// Repair every selected object's geometry through the shared repairObjects
// batch (same validate → autoFix → record geometryFixes → markDirty sequence
// as the import toast, Outliner badge, and Print panel "Repair all"), one at
// a time under the blocking ProgressOverlay so a batch of heavy meshes can't
// be edited mid-repair. A per-object failure is reported but never blocks
// the rest of the selection (MeshValidator.repairObjects is tolerant).
function _splitToParts(targetId) {
  const objects = getState().scene.objects;
  const leadId = canonicalObjectId(targetId ?? Selection.getSelectedIds()[0], objects);
  if (!leadId || !objects[leadId]) return;
  const cmd = new SplitToPartsCommand(leadId);
  push(cmd);
  if (!cmd.applied) return;
  // Every part is now its own object — show them all selected, lead active.
  const group = Object.values(getState().scene.groups).find(g => (g.childIds ?? []).includes(leadId));
  Selection.set(group ? group.childIds : [leadId], leadId);
}

function _join() {
  const ids = Selection.getSelectedIds();
  const cmd = new JoinCommand(ids, { leadId: Selection.getActiveId?.() ?? ids[0] });
  push(cmd);
  if (!cmd.applied) return;
  const objects = getState().scene.objects;
  const leadId = canonicalObjectId(cmd._leadId ?? ids[0], objects);
  Selection.set([leadId], leadId);
}

async function _repairGeometry() {
  const objects = getState().scene.objects;
  const ids = [];
  for (const id of Selection.getSelectedIds()) {
    for (const leadId of objects[id] ? [id] : groupDescendantObjectIds(id, getState().scene)) {
      if (objects[leadId] && !objects[leadId].isGhost && !ids.includes(leadId)) ids.push(leadId);
    }
  }
  if (!ids.length) return;
  await repairWithOverlay(ids, { title: t('context.repairGeometry') });
}

function _relink(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj?.assetId) return;
  safeAsync(() => PersistenceManager.relinkAsset(obj.assetId));
}

function _frame() {
  const meshes = Selection.getSelectedResolved().map(r => r.mesh);
  // A selected group frames every object mesh under its transform node.
  for (const n of Selection.getSelectedNodes()) {
    if (n.kind !== 'group') continue;
    for (const m of n.node.getChildMeshes?.(false) ?? []) if (m?.metadata?.meshId) meshes.push(m);
  }
  if (meshes.length) SceneManager.frameSelected(meshes);
}

function _toggleHide() {
  const scene = getState().scene;
  const ids = cascadeObjectIds(Selection.getSelectedIds(), scene);
  if (!ids.length) return;
  const prev = {};
  for (const id of ids) prev[id] = !!scene.objects[id]?.visible;
  const anyVisible = ids.some(id => scene.objects[id]?.visible);
  push(new VisibilityCommand(ids, prev, !anyVisible));
}

function _toggleLock() {
  const scene = getState().scene;
  const ids = cascadeLockIds(Selection.getSelectedIds(), scene);
  if (!ids.length) return;
  const lockOf = (id) => !!(scene.objects[id] ?? scene.groups[id])?.locked;
  const prev = {};
  for (const id of ids) prev[id] = lockOf(id);
  const anyUnlocked = ids.some(id => !lockOf(id));
  push(new LockCommand(ids, prev, anyUnlocked));
}

// Rename = the Outliner's inline editor (same path as F2).
function _renameActive() {
  Outliner.renameActive();
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
  const groupIds = UngroupCommand.targetsFor(Selection.getSelectedIds());
  if (!groupIds.length) return;
  push(new UngroupCommand(groupIds));
}

function _unparent(info) {
  const { objects, groups } = getState().scene;
  const sel = Selection.getSelectedIds();
  const ids = sel.length ? sel : [info?.targetId].filter(Boolean);
  for (const id of ids) {
    if (objects[id]?.parentId ?? groups[id]?.parentId) push(new UnparentCommand(id));
  }
}

function _delete() {
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new DeleteCommand(ids));
}

export const ContextMenu = { init, open, close };
