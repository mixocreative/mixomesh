import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { Selection } from '../core/Selection.js';
import { push, VisibilityCommand, LockCommand, RenameCommand, PrintPartCommand, ShaderAssignCommand, RenameCollectionCommand } from '../core/HistoryManager.js';
import { icon } from '../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';

let _root  = null;
let _listEl = null;
let _onContextMenu = null;

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

const SHADER_DRAG_MIME = 'application/x-mixomesh-shader';

const _SUBSCRIBE = [
  EVENTS.ASSET_INSTANTIATED,
  EVENTS.OBJECT_REMOVED,
  EVENTS.OBJECT_RESTORED,
  EVENTS.GROUP_CREATED,
  EVENTS.GROUP_DISSOLVED,
  EVENTS.PARENT_CHANGED,
  EVENTS.OBJECT_RENAMED,
  EVENTS.VISIBILITY_CHANGED,
  EVENTS.LOCK_CHANGED,
  EVENTS.OBJECT_UPDATED,
  EVENTS.SELECTION_CHANGED,
  EVENTS.ACTIVE_OBJECT_CHANGED,
  EVENTS.PROJECT_LOADED,
  EVENTS.VALIDATION_COMPLETE,   // status icons read the A6 cache
  EVENTS.TRANSFORM_COMMITTED,   // stale-marking after moves
  EVENTS.COLLECTION_CREATED,
  EVENTS.COLLECTION_REMOVED,
  EVENTS.COLLECTION_RENAMED,
  EVENTS.COLLECTION_MEMBERSHIP,
];

// ── Init ─────────────────────────────────────────────────

/** Initialise the Outliner panel. Must be called once after DOM is ready. */
export function init() {
  _root = document.getElementById('outliner');
  _root.innerHTML = `
    <div class="ol-header">
      <span class="ol-title" data-i18n-key="panel.outliner.title">Outliner</span>
    </div>
    <div class="ol-list" id="ol-list" role="tree" data-i18n-aria-label="outliner.sceneObjects"></div>
  `;
  _listEl = _root.querySelector('#ol-list');
  _listEl.addEventListener('click', _onListClick);
  _listEl.addEventListener('dblclick', _onListDblClick);
  _listEl.addEventListener('contextmenu', _onListContextMenu);
  _listEl.addEventListener('dragover', _onListDragOver);
  _listEl.addEventListener('dragleave', _onListDragLeave);
  _listEl.addEventListener('drop', _onListDrop);
  _listEl.addEventListener('keydown', _onListKeyDown);

  for (const ev of _SUBSCRIBE) subscribe(ev, _render);
  // Static `.ol-title` swaps language on locale change; the list body has no
  // section.* labels in scope for v1.
  subscribe(EVENTS.LOCALE_CHANGED, () => _retranslate(_root));
  _retranslate(_root);
  _render();
}

/** Register a callback for "open context menu at {x,y} for {target}". */
export function setContextMenuHandler(fn) {
  _onContextMenu = fn;
}

// ── Render ───────────────────────────────────────────────

function _render() {
  if (!_listEl) return;
  const { objects, groups, collections } = getState().scene;
  const collapsed = getState().ui.outlinerCollapsed ?? {};

  const groupCol = _computeGroupCollections(groups, objects);
  const topGroups = Object.values(groups).filter(g => !g.parentId);

  // Partition top-level groups by collection homogeneity.
  const groupsByCol = new Map();        // collectionId → group[]
  const mixedGroups = [];
  for (const g of topGroups) {
    const c = groupCol.get(g.id);
    if (c === 'mixed' || c == null) { mixedGroups.push(g); continue; }
    if (!groupsByCol.has(c)) groupsByCol.set(c, []);
    groupsByCol.get(c).push(g);
  }

  // Partition orphan (no parent group) objects by collection.
  const objsByCol = new Map();
  const uncolObjs = [];
  for (const o of Object.values(objects)) {
    if (o.parentId) continue;
    const c = o.collectionId;
    if (!c || !collections[c]) { uncolObjs.push(o); continue; }
    if (!objsByCol.has(c)) objsByCol.set(c, []);
    objsByCol.get(c).push(o);
  }

  const parts = [];
  for (const col of Object.values(collections)) {
    const memberGroups = groupsByCol.get(col.id) ?? [];
    const memberObjs   = objsByCol.get(col.id)   ?? [];
    if (!memberGroups.length && !memberObjs.length) continue;     // hide empty collection
    parts.push(_renderCollectionBranch(col, memberGroups, memberObjs, groups, objects, collapsed));
  }
  // Mixed-collection groups render at outliner root with a [Mixed] badge.
  for (const g of mixedGroups) parts.push(_renderGroupBranch(g, groups, objects, collapsed, 0, /*mixed*/ true));
  // Uncollected orphan objects render at root.
  for (const o of uncolObjs)   parts.push(_renderObjectRow(o, 0));

  if (!parts.length) {
    _listEl.innerHTML = `<div class="ol-empty">${_escape(t('outliner.empty'))}</div>`;
    return;
  }

  _listEl.innerHTML = parts.join('');
  _applySelectionHighlight();
}

/**
 * For every group, compute the single collection its leaf meshes belong to,
 * or 'mixed' when leaves span multiple collections, or null when all leaves
 * are uncollected.
 */
function _computeGroupCollections(allGroups, allObjects) {
  const out = new Map();
  const groupArr = Object.values(allGroups);
  for (const g of groupArr) {
    const colls = new Set();
    const stack = [g];
    while (stack.length) {
      const cur = stack.pop();
      for (const id of cur.childIds ?? []) {
        const obj = allObjects[id];
        if (obj?.collectionId) colls.add(obj.collectionId);
        else if (obj)          colls.add('__none__');
      }
      for (const sg of groupArr) if (sg.parentId === cur.id) stack.push(sg);
    }
    colls.delete('__none__');
    if (colls.size === 0) out.set(g.id, null);
    else if (colls.size === 1) out.set(g.id, [...colls][0]);
    else out.set(g.id, 'mixed');
  }
  return out;
}

function _renderCollectionBranch(col, memberGroups, memberObjs, allGroups, allObjects, collapsed) {
  const isCollapsed = !!collapsed[col.id];
  const count = memberGroups.length + memberObjs.length;
  const iconName = isCollapsed ? 'Folder' : 'FolderOpen';
  const twirl = `<span class="ol-twirl">${icon(isCollapsed ? 'ChevronRight' : 'ChevronDown', { width: 12, height: 12 })}</span>`;
  const header = `
    <div class="ol-row ol-row-collection"
         data-id="${escapeAttr(col.id)}"
         data-kind="collection"
         data-has-children="true"
         role="treeitem"
         tabindex="0"
         aria-expanded="${isCollapsed ? 'false' : 'true'}"
         aria-selected="false"
         style="padding-left:0px">
      ${twirl}
      <span class="ol-icon">${icon(iconName, { width: 14, height: 14 })}</span>
      <span class="ol-name" data-name>${_escape(col.name)}</span><span class="ol-badge" title="${escapeAttr(t('outliner.itemCount', { n: count }))}">${count}</span>
      <span class="ol-icon-btn ol-print ol-print-placeholder"></span>
      <span class="ol-icon-btn ol-print ol-print-placeholder"></span>
      <span class="ol-icon-btn ol-print ol-print-placeholder"></span>
    </div>
  `;
  if (isCollapsed) return header;
  let html = header;
  for (const g of memberGroups) html += _renderGroupBranch(g, allGroups, allObjects, collapsed, 1, false);
  for (const o of memberObjs)   html += _renderObjectRow(o, 1);
  return html;
}

function _renderGroupBranch(group, allGroups, allObjects, collapsed, depth, mixed = false) {
  const isCollapsed = !!collapsed[group.id];
  const children = (group.childIds ?? []).map(id => allObjects[id]).filter(Boolean);
  const subgroups = Object.values(allGroups).filter(g => g.parentId === group.id);

  let html = _renderRow({
    id: group.id,
    kind: 'group',
    name: group.name,
    nameSuffix: mixed ? `<span class="ol-mixed-badge">${_escape(t('outliner.mixed'))}</span>` : '',
    visible: true,
    locked: false,
    depth,
    hasChildren: children.length + subgroups.length > 0,
    isCollapsed,
    iconName: isCollapsed ? 'Folder' : 'FolderOpen',
  });

  if (!isCollapsed) {
    for (const sg of subgroups) html += _renderGroupBranch(sg, allGroups, allObjects, collapsed, depth + 1);
    for (const c of children)   html += _renderObjectRow(c, depth + 1);
  }
  return html;
}

function _renderObjectRow(obj, depth) {
  return _renderRow({
    id: obj.id,
    kind: 'object',
    name: obj.name,
    nameSuffix: _validationBadge(obj.id),
    visible: obj.visible !== false,
    locked: !!obj.locked,
    isPrintPart: !!obj.isPrintPart,
    depth,
    hasChildren: false,
    isCollapsed: false,
    iconName: obj.isGhost ? 'CircleAlert' : (obj.isUnlinked ? 'Link' : 'Box'),
    isGhost: obj.isGhost,
    isUnlinked: obj.isUnlinked,
  });
}

// Validation status badge from the A6 cache (Blueprint §13 Outliner row
// icons). Static trusted markup beside the escaped name — title carries the
// first message, escaped.
function _validationBadge(meshId) {
  const e = getState().scene.validation?.[meshId];
  if (!e || !e.results.length) return '';
  const hasErr = e.results.some(r => r.severity === 'error');
  const name = hasErr ? 'CircleAlert' : 'AlertTriangle';
  const cls = `ol-validation ${hasErr ? 'ol-validation-error' : 'ol-validation-warning'}${e.stale ? ' ol-validation-stale' : ''}`;
  const title = escapeAttr(`${e.stale ? `${t('outliner.stalePrefix')} ` : ''}${e.results[0]?.message ?? t('outliner.validationIssue')}`);
  return `<span class="${cls}" title="${title}">${icon(name, { width: 11, height: 11 })}</span>`;
}

function _renderRow({ id, kind, name, nameSuffix = '', visible, locked, isPrintPart, depth, hasChildren, isCollapsed, iconName, isGhost, isUnlinked }) {
  const indent  = depth * 14;
  const twirl   = hasChildren
    ? `<span class="ol-twirl">${icon(isCollapsed ? 'ChevronRight' : 'ChevronDown', { width: 12, height: 12 })}</span>`
    : `<span class="ol-twirl ol-twirl-empty"></span>`;
  const ghostCls = isGhost ? 'ol-ghost' : (isUnlinked ? 'ol-unlinked' : '');
  const lockedCls = locked ? 'ol-locked' : '';
  const hiddenCls = !visible ? 'ol-hidden' : '';
  const printBtn = kind === 'object'
    ? `<button class="ol-icon-btn ol-print ${isPrintPart ? 'ol-print-on' : ''}" type="button" data-action="print" title="${escapeAttr(t(isPrintPart ? 'outliner.removeFromPrint' : 'outliner.markPrintPart'))}">${icon('Printer', { width: 13, height: 13 })}</button>`
    : `<span class="ol-icon-btn ol-print ol-print-placeholder"></span>`;
  return `
    <div class="ol-row ${ghostCls} ${lockedCls} ${hiddenCls}"
         data-id="${escapeAttr(id)}"
         data-kind="${escapeAttr(kind)}"
         data-has-children="${hasChildren ? 'true' : 'false'}"
         role="treeitem"
         tabindex="0"
         ${hasChildren ? `aria-expanded="${isCollapsed ? 'false' : 'true'}"` : ''}
         aria-selected="false"
         style="padding-left:${indent}px">
      ${twirl}
      <span class="ol-icon">${icon(iconName, { width: 14, height: 14 })}</span>
      <span class="ol-name" data-name>${_escape(name)}</span>${nameSuffix}
      <button class="ol-icon-btn ol-vis"  type="button" data-action="vis"  title="${escapeAttr(t(visible ? 'outliner.hide' : 'outliner.show'))}">${icon(visible ? 'Eye' : 'EyeOff', { width: 13, height: 13 })}</button>
      <button class="ol-icon-btn ol-lock" type="button" data-action="lock" title="${escapeAttr(t(locked ? 'outliner.unlock' : 'outliner.lock'))}">${icon(locked ? 'Lock' : 'Unlock', { width: 13, height: 13 })}</button>
      ${printBtn}
    </div>
  `;
}

function _hasShaderPayload(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes(SHADER_DRAG_MIME);
}

function _readShaderDrop(e) {
  try {
    const raw = e.dataTransfer?.getData(SHADER_DRAG_MIME);
    if (!raw) return null;
    const { shaderId } = JSON.parse(raw);
    return getState().scene.shaders[shaderId] ? shaderId : null;
  } catch {
    return null;
  }
}

function _toggleVisibility(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  push(new VisibilityCommand([meshId], { [meshId]: !!obj.visible }, !obj.visible));
}

function _toggleLock(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  push(new LockCommand([meshId], { [meshId]: !!obj.locked }, !obj.locked));
}

function _togglePrintPart(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  push(new PrintPartCommand(meshId, !!obj.isPrintPart, !obj.isPrintPart));
}

function _toggleCollapsed(id) {
  const collapsed = !(getState().ui.outlinerCollapsed?.[id]);
  _setCollapsed(id, collapsed);
}

function _setCollapsed(id, collapsed) {
  setState(s => ({
    ...s,
    ui: { ...s.ui, outlinerCollapsed: { ...s.ui.outlinerCollapsed, [id]: collapsed } },
  }), { silent: true });
  _render();
}

function _rowFromEvent(e) {
  const row = e.target.closest?.('.ol-row');
  return row && _listEl.contains(row) ? row : null;
}

function _onListClick(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  const id = row.dataset.id;
  const actionBtn = e.target.closest?.('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === 'vis')   _toggleVisibility(id);
    if (action === 'lock')  _toggleLock(id);
    if (action === 'print') _togglePrintPart(id);
    return;
  }
  const twirl = e.target.closest?.('.ol-twirl');
  if (twirl && !twirl.classList.contains('ol-twirl-empty')) {
    e.stopPropagation();
    _toggleCollapsed(id);
    return;
  }
  _activateRow(row, e);
}

function _onListDblClick(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  const nameEl = row.querySelector('[data-name]');
  if (!nameEl?.contains(e.target)) return;
  _beginRename(row, row.dataset.id, row.dataset.kind);
}

function _onListContextMenu(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  const id = row.dataset.id;
  const kind = row.dataset.kind;
  e.preventDefault();
  e.stopPropagation();
  if (kind === 'object' && !Selection.getSelectedIds().includes(id)) {
    Selection.set([id], id);
  }
  if (_onContextMenu) _onContextMenu({ x: e.clientX, y: e.clientY, source: 'outliner', targetId: id, targetKind: kind });
}

function _onListDragOver(e) {
  const row = _rowFromEvent(e);
  if (!row || row.dataset.kind !== 'object' || !_hasShaderPayload(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  row.classList.add('ol-drop-shader');
}

function _onListDragLeave(e) {
  const row = _rowFromEvent(e);
  if (!row || row.contains(e.relatedTarget)) return;
  row.classList.remove('ol-drop-shader');
}

function _onListDrop(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  row.classList.remove('ol-drop-shader');
  if (row.dataset.kind !== 'object') return;
  const shaderId = _readShaderDrop(e);
  if (!shaderId) return;
  e.preventDefault();
  e.stopPropagation();
  const id = row.dataset.id;
  const obj = getState().scene.objects[id];
  if (!obj || obj.shaderId === shaderId) return;
  push(new ShaderAssignCommand([id], shaderId));
}

function _onListKeyDown(e) {
  if (e.target.closest?.('button,input,select,textarea')) return;
  const row = _rowFromEvent(e);
  if (!row) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    _activateRow(row, e);
  } else if (e.key === 'F2') {
    e.preventDefault();
    _beginRename(row, row.dataset.id, row.dataset.kind);
  } else if (row.dataset.hasChildren === 'true' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    _setCollapsed(row.dataset.id, e.key === 'ArrowLeft');
  }
}

function _activateRow(row, e = {}) {
  const id = row.dataset.id;
  const kind = row.dataset.kind;
  if (kind === 'object') {
    if (e.ctrlKey || e.metaKey) Selection.toggle(id);
    else if (e.shiftKey)        Selection.add(id);
    else                        Selection.set([id], id);
  } else if (kind === 'group') {
    _selectGroup(id);
  } else if (kind === 'collection') {
    _selectCollection(id);
  }
}

function _selectGroup(groupId) {
  // Selecting a group selects all its descendant objects.
  const { objects, groups } = getState().scene;
  const g = groups[groupId];
  if (!g) return;
  const ids = [];
  const stack = [g];
  while (stack.length) {
    const cur = stack.pop();
    for (const id of cur.childIds ?? []) {
      if (objects[id]) ids.push(id);
    }
    for (const sg of Object.values(groups)) if (sg.parentId === cur.id) stack.push(sg);
  }
  if (ids.length) Selection.set(ids, ids[ids.length - 1]);
}

function _selectCollection(collectionId) {
  // Selecting a collection selects every mesh tagged with it.
  const { objects } = getState().scene;
  const ids = Object.values(objects).filter(o => o.collectionId === collectionId).map(o => o.id);
  if (ids.length) Selection.set(ids, ids[ids.length - 1]);
}

function _beginRename(rowEl, id, kind) {
  const nameEl = rowEl.querySelector('[data-name]');
  const cur = nameEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = cur;
  input.className = 'ol-rename-input';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = (apply) => {
    const replacement = document.createElement('span');
    replacement.className = 'ol-name';
    replacement.setAttribute('data-name', '');
    const newName = apply ? input.value.trim() : cur;
    replacement.textContent = newName || cur;
    input.replaceWith(replacement);
    if (!apply || !newName || newName === cur) return;
    if (kind === 'collection') {
      _renameCollection(id, newName);
    } else {
      push(new RenameCommand(id, cur, newName));
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();   // don't let G/R/S/Delete fire
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

function _renameCollection(collectionId, newName) {
  const prev = getState().scene.collections?.[collectionId]?.name;
  if (prev == null || prev === newName) return;
  push(new RenameCollectionCommand(collectionId, prev, newName));   // undoable (L30)
}

function _applySelectionHighlight() {
  const { selectedIds, activeId } = getState().selection;
  _listEl.querySelectorAll('.ol-row').forEach(row => {
    const selected = selectedIds.includes(row.dataset.id);
    row.classList.toggle('ol-selected', selected);
    row.classList.toggle('ol-active',   row.dataset.id === activeId);
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

export const Outliner = { init, setContextMenuHandler };
