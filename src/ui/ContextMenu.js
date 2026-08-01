import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { CursorTools } from '../core/CursorTools.js';
import { getState, setState, dispatch } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { push, VisibilityCommand, LockCommand, RenameCommand, DeleteCommand, DuplicateCommand, GroupCommand, UngroupCommand, SmartReplaceCommand, TransformSwabCommand, AlignCommand, MirrorCommand, ArrayCommand, performBoolean } from '../core/HistoryManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { logicalObjectCommandIds, logicalObjectPartIds } from '../core/LogicalObjects.js';
import { safeAsync, Toast } from './Toast.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { t } from '../i18n/index.js';

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
      { label: t('context.selectMembers'),     shortcut: '',  action: 'col-select', iconName: 'Box',      cls: '' },
      { label: t('context.renameCollection'), shortcut: '',  action: 'col-rename', iconName: 'Edit3',    cls: '' },
      'sep',
      { label: t('context.deleteCollection'),  shortcut: '',  action: 'col-delete', iconName: 'Trash2',   cls: 'cm-danger' },
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
      { label: objs[ghostId].isGhost ? t('context.relinkAsset') : t('context.relinkLiveFile'),
        shortcut: '', action: 'relink', iconName: 'Link', cls: '' },
      'sep',
    ] : []),
    { label: t('context.focus'),           shortcut: 'F',           action: 'frame',   iconName: 'Focus',      cls: enabled(hasSelection) },
    'sep',
    { label: t('context.toggleHidden'),   shortcut: 'H',           action: 'hide',    iconName: 'EyeOff',     cls: enabled(hasSelection) },
    { label: t('context.toggleLock'),     shortcut: '',            action: 'lock',    iconName: 'Lock',       cls: enabled(hasSelection) },
    { label: t('context.rename'),         shortcut: 'F2',          action: 'rename',  iconName: 'Edit3',      cls: enabled(hasSelection) },
    { label: t('context.duplicate'),       shortcut: 'Shift+D',     action: 'duplicate', iconName: 'Copy',     cls: enabled(hasSelection) },
    'sep',
    { label: t('context.group'),           shortcut: 'Ctrl+G',      action: 'group',   iconName: 'Folder',     cls: enabled(hasSelection) },
    { label: t('context.ungroup'),         shortcut: 'Ctrl+Shift+G',action: 'ungroup', iconName: 'FolderOpen', cls: enabled(someGrouped) },
    'sep',
    { label: t('context.selectionToCursor'), shortcut: '',         action: 'sel-to-cursor', iconName: 'Crosshair', cls: enabled(hasSelection) },
    { label: t('context.cursorToSelection'), shortcut: '',         action: 'cursor-to-sel', iconName: 'Crosshair', cls: enabled(hasSelection) },
    { label: t('context.cursorToWorldOrigin'), shortcut: '',      action: 'cursor-to-origin', iconName: 'Crosshair', cls: '' },
    'sep',
    { label: t('context.smartReplace'),   shortcut: '',            action: 'replace', iconName: 'RefreshCw',  cls: enabled(multi) },
    { label: t('context.transformSwab'),  shortcut: '',            action: 'swab',    iconName: 'Pipette',    cls: enabled(multi) },
    'sep',
    { label: t('context.alignCenterX'),   shortcut: '',            action: 'align-x-center', iconName: 'Crosshair', cls: enabled(multi) },
    { label: t('context.alignCenterY'),   shortcut: '',            action: 'align-y-center', iconName: 'Crosshair', cls: enabled(multi) },
    { label: t('context.alignCenterZ'),   shortcut: '',            action: 'align-z-center', iconName: 'Crosshair', cls: enabled(multi) },
    'sep',
    { label: t('context.booleanUnion'),     shortcut: '',          action: 'bool-union',     iconName: 'Box',   cls: enabled(multi) },
    { label: t('context.booleanSubtract'),  shortcut: '',          action: 'bool-subtract',  iconName: 'Box',   cls: enabled(multi) },
    { label: t('context.booleanIntersect'), shortcut: '',          action: 'bool-intersect', iconName: 'Box',   cls: enabled(multi) },
    'sep',
    { label: t('context.mirrorX'),          shortcut: '',          action: 'mirror-x',       iconName: 'Box', cls: enabled(hasSelection) },
    { label: t('context.mirrorY'),          shortcut: '',          action: 'mirror-y',       iconName: 'Box', cls: enabled(hasSelection) },
    { label: t('context.mirrorZ'),          shortcut: '',          action: 'mirror-z',       iconName: 'Box', cls: enabled(hasSelection) },
    'sep',
    { label: t('context.arrayX'),           shortcut: '',          action: 'array-x',        iconName: 'Copy', cls: enabled(hasSelection) },
    { label: t('context.arrayY'),           shortcut: '',          action: 'array-y',        iconName: 'Copy', cls: enabled(hasSelection) },
    { label: t('context.arrayZ'),           shortcut: '',          action: 'array-z',        iconName: 'Copy', cls: enabled(hasSelection) },
    'sep',
    { label: t('context.delete'),          shortcut: 'Del',         action: 'delete',  iconName: 'Trash2',     cls: enabled(hasSelection) + ' cm-danger' },
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
  if (action.startsWith('align-')) _align(action);
  if (action.startsWith('mirror-')) _mirror(action);
  if (action.startsWith('array-')) _array(action.split('-')[1]);
  if (action.startsWith('bool-'))  safeAsync(() => _boolean(action.slice(5)));
  if (action === 'sel-to-cursor') CursorTools.selectionToCursor();
  if (action === 'cursor-to-sel') CursorTools.cursorToSelection();
  if (action === 'cursor-to-origin') CursorTools.cursorToWorldOrigin();
  if (action === 'relink')     _relink(info.targetId);
  if (action === 'col-select') _selectCollectionMembers(info.targetId);
  if (action === 'col-rename') _renameCollection(info.targetId);
  if (action === 'col-delete') _deleteCollection(info.targetId);
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

// Interactive Boolean (ADR 0002). performBoolean is async (CSG2 + serialise); it
// applies the change + returns an already-applied command to push, or a blocked
// reason to surface.
async function _boolean(op) {
  const ids = Selection.getSelectedIds();
  if (ids.length < 2) return;
  const res = await performBoolean(ids, op);
  if (res && res.blocked) {
    const key = res.reason === 'needs-texture-bake' ? 'toast.booleanTextured'
      : res.reason === 'multi-part' ? 'toast.booleanMultiPart'
      : res.reason === 'too-large' ? 'toast.booleanTooLarge'
      : 'toast.booleanBlocked';
    Toast.show(t(key, { reason: res.reason }), 'warning', 4000);
    return;
  }
  push(res);
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
  const objects = getState().scene.objects;
  const ids = logicalObjectCommandIds(Selection.getSelectedIds(), objects);
  if (!ids.length) return;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.visible;
  const anyVisible = ids.some(id => objects[id]?.visible);
  push(new VisibilityCommand(ids, prev, !anyVisible));
}

function _toggleLock() {
  const objects = getState().scene.objects;
  const ids = logicalObjectCommandIds(Selection.getSelectedIds(), objects);
  if (!ids.length) return;
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
