import { EVENTS } from '../core/events.js';
import { subscribe, dispatch, getState, setState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { push, VisibilityCommand, LockCommand, RenameCommand, PrintPartCommand } from '../core/HistoryManager.js';
import { icon } from '../core/Icons.js';

let _root  = null;
let _listEl = null;
let _onContextMenu = null;

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
      <span class="ol-title">Outliner</span>
    </div>
    <div class="ol-list" id="ol-list"></div>
  `;
  _listEl = _root.querySelector('#ol-list');

  for (const ev of _SUBSCRIBE) subscribe(ev, _render);
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
    _listEl.innerHTML = `<div class="ol-empty">Drop a 3D file on the viewport to begin.</div>`;
    return;
  }

  _listEl.innerHTML = parts.join('');
  _wireRowEvents();
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
         data-id="${col.id}"
         data-kind="collection"
         style="padding-left:0px">
      ${twirl}
      <span class="ol-icon">${icon(iconName, { width: 14, height: 14 })}</span>
      <span class="ol-name" data-name>${_escape(col.name)}<span class="ol-badge" title="${count} item${count === 1 ? '' : 's'}">${count}</span></span>
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
    name: mixed ? `${group.name} <span class="ol-mixed-badge">Mixed</span>` : group.name,
    visible: true,
    locked: false,
    depth,
    hasChildren: children.length + subgroups.length > 0,
    isCollapsed,
    iconName: isCollapsed ? 'Folder' : 'FolderOpen',
    nameIsHtml: mixed,
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

function _renderRow({ id, kind, name, visible, locked, isPrintPart, depth, hasChildren, isCollapsed, iconName, isGhost, isUnlinked, nameIsHtml }) {
  const indent  = depth * 14;
  const twirl   = hasChildren
    ? `<span class="ol-twirl">${icon(isCollapsed ? 'ChevronRight' : 'ChevronDown', { width: 12, height: 12 })}</span>`
    : `<span class="ol-twirl ol-twirl-empty"></span>`;
  const ghostCls = isGhost ? 'ol-ghost' : (isUnlinked ? 'ol-unlinked' : '');
  const lockedCls = locked ? 'ol-locked' : '';
  const hiddenCls = !visible ? 'ol-hidden' : '';
  const printBtn = kind === 'object'
    ? `<button class="ol-icon-btn ol-print ${isPrintPart ? 'ol-print-on' : ''}" data-action="print" title="${isPrintPart ? 'Remove from print' : 'Mark as print part'}">${icon('Printer', { width: 13, height: 13 })}</button>`
    : `<span class="ol-icon-btn ol-print ol-print-placeholder"></span>`;
  const nameMarkup = nameIsHtml ? name : _escape(name);
  return `
    <div class="ol-row ${ghostCls} ${lockedCls} ${hiddenCls}"
         data-id="${id}"
         data-kind="${kind}"
         style="padding-left:${indent}px">
      ${twirl}
      <span class="ol-icon">${icon(iconName, { width: 14, height: 14 })}</span>
      <span class="ol-name" data-name>${nameMarkup}</span>
      <button class="ol-icon-btn ol-vis"  data-action="vis"  title="${visible ? 'Hide' : 'Show'}">${icon(visible ? 'Eye' : 'EyeOff', { width: 13, height: 13 })}</button>
      <button class="ol-icon-btn ol-lock" data-action="lock" title="${locked ? 'Unlock' : 'Lock'}">${icon(locked ? 'Lock' : 'Unlock', { width: 13, height: 13 })}</button>
      ${printBtn}
    </div>
  `;
}

function _wireRowEvents() {
  _listEl.querySelectorAll('.ol-row').forEach(row => {
    const id   = row.dataset.id;
    const kind = row.dataset.kind;

    row.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === 'vis')   _toggleVisibility(id);
        if (action === 'lock')  _toggleLock(id);
        if (action === 'print') _togglePrintPart(id);
        return;
      }
      const twirl = e.target.closest('.ol-twirl');
      if (twirl && !twirl.classList.contains('ol-twirl-empty')) {
        e.stopPropagation();
        _toggleCollapsed(id);
        return;
      }
      if (kind === 'object') {
        if (e.ctrlKey || e.metaKey) Selection.toggle(id);
        else if (e.shiftKey)        Selection.add(id);
        else                        Selection.set([id], id);
      } else if (kind === 'group') {
        _selectGroup(id);
      } else if (kind === 'collection') {
        _selectCollection(id);
      }
    });

    row.addEventListener('dblclick', (e) => {
      const nameEl = row.querySelector('[data-name]');
      if (!nameEl?.contains(e.target)) return;
      _beginRename(row, id, kind);
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind === 'object') {
        if (!Selection.getSelectedIds().includes(id)) Selection.set([id], id);
      }
      if (_onContextMenu) _onContextMenu({ x: e.clientX, y: e.clientY, source: 'outliner', targetId: id, targetKind: kind });
    });
  });
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
  const prev = { isPrintPart: !!obj.isPrintPart, partLabel: obj.partLabel ?? '', partTolerance: obj.partTolerance ?? 0 };
  const next = { isPrintPart: !obj.isPrintPart, partLabel: prev.partLabel, partTolerance: prev.partTolerance };
  push(new PrintPartCommand(meshId, prev, next));
}

function _toggleCollapsed(id) {
  setState(s => ({
    ...s,
    ui: { ...s.ui, outlinerCollapsed: { ...s.ui.outlinerCollapsed, [id]: !(s.ui.outlinerCollapsed?.[id]) } },
  }), { silent: true });
  _render();
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
  setState(s => {
    const col = s.scene.collections?.[collectionId];
    if (!col) return s;
    return {
      ...s,
      scene: {
        ...s.scene,
        collections: { ...s.scene.collections, [collectionId]: { ...col, name: newName } },
      },
    };
  });
  dispatch(EVENTS.COLLECTION_RENAMED, { collectionId, name: newName });
}

function _applySelectionHighlight() {
  const { selectedIds, activeId } = getState().selection;
  _listEl.querySelectorAll('.ol-row').forEach(row => {
    row.classList.toggle('ol-selected', selectedIds.includes(row.dataset.id));
    row.classList.toggle('ol-active',   row.dataset.id === activeId);
  });
}

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export const Outliner = { init, setContextMenuHandler };
