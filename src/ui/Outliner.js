import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { Selection } from '../core/Selection.js';
import { push, beginBatch, endBatch, VisibilityCommand, LockCommand, RenameCommand, PrintPartCommand, ShaderAssignCommand, ReparentCommand, UnparentCommand } from '../core/HistoryManager.js';
import { validateParentChange } from '../core/hierarchy/HierarchyIntegrity.js';
import { cascadeObjectIds, cascadeLockIds, groupAnyVisible } from '../core/hierarchy/GroupCascade.js';
import { logicalObjectPartIds, shouldDisplayObject } from '../core/LogicalObjects.js';
import { icon } from '../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';
import { repairWithOverlay } from './RepairFeedback.js';

let _root  = null;
let _listEl = null;
let _footerEl = null;
let _onContextMenu = null;
let _searchQuery = '';
// Objects whose material-part rows are disclosed (session-only; parts are
// read-only rows under their lead, owner decision 2026-09-18).
const _openParts = new Set();

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

const SHADER_DRAG_MIME = 'application/x-mixomesh-shader';
const HIERARCHY_DRAG_MIME = 'application/x-mixomesh-hierarchy-node';
let _draggingNode = null;

// Collections are no longer an Outliner level (Decision 2): the schema stays
// for provenance, so their events are not subscribed here.
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
  EVENTS.PROJECT_LOADED,
  EVENTS.VALIDATION_COMPLETE,   // status pills read the A6 cache
  EVENTS.TRANSFORM_COMMITTED,   // stale-marking after moves
  EVENTS.REFINEMENT_CHANGED,
  EVENTS.REFINEMENT_PROGRESS,
  EVENTS.REFINEMENT_READY,
  EVENTS.REFINEMENT_FAILED,
  EVENTS.REFINEMENT_CANCELLED,
  EVENTS.REFINEMENT_STALE,
];

// ── Init ─────────────────────────────────────────────────

/** Initialise the Outliner panel. Must be called once after DOM is ready. */
export function init() {
  _root = document.getElementById('outliner');
  _root.innerHTML = `
    <div class="ol-header">
      <span class="ol-title" data-i18n-key="panel.outliner.title">Outliner</span>
    </div>
    <input class="ol-search" id="ol-search" type="search"
           placeholder="${escapeAttr(t('outliner.searchPlaceholder'))}"
           aria-label="${escapeAttr(t('outliner.searchLabel'))}">
    <div class="ol-list" id="ol-list" role="tree" aria-multiselectable="true" data-i18n-aria-label="outliner.sceneObjects"></div>
    <div class="ol-footer" id="ol-footer" aria-live="polite"></div>
  `;
  _listEl = _root.querySelector('#ol-list');
  _footerEl = _root.querySelector('#ol-footer');
  _root.querySelector('#ol-search').addEventListener('input', event => {
    _searchQuery = event.target.value;
    _render();
  });
  _listEl.addEventListener('click', _onListClick);
  _listEl.addEventListener('dblclick', _onListDblClick);
  _listEl.addEventListener('contextmenu', _onListContextMenu);
  _listEl.addEventListener('dragstart', _onListDragStart);
  _listEl.addEventListener('dragend', _onListDragEnd);
  _listEl.addEventListener('dragover', _onListDragOver);
  _listEl.addEventListener('dragleave', _onListDragLeave);
  _listEl.addEventListener('drop', _onListDrop);
  _listEl.addEventListener('keydown', _onListKeyDown);

  for (const ev of _SUBSCRIBE) subscribe(ev, _render);
  subscribe(EVENTS.ACTIVE_OBJECT_CHANGED, _revealActiveObject);
  // Locale changes must rebuild row markup generated from t(), then refresh
  // static title/list data-i18n attributes in one root walk.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _render(); _retranslate(_root); });
  _retranslate(_root);
  _render();
}

/** Register a callback for "open context menu at {x,y} for {target}". */
export function setContextMenuHandler(fn) {
  _onContextMenu = fn;
}

// ── Render ───────────────────────────────────────────────

function _subgroupsOf(groupId, groups) {
  return Object.values(groups).filter(g => g.parentId === groupId);
}

function _render() {
  if (!_listEl) return;
  const { objects, groups, collections } = getState().scene;
  const collapsed = getState().ui.outlinerCollapsed ?? {};

  // Plain tree: top-level groups, then top-level objects (Decision 2: no
  // collection rows — an import that yielded several objects is a Group).
  const parts = [];
  for (const g of Object.values(groups)) {
    if (!g.parentId) parts.push(_renderGroupBranch(g, groups, objects, collapsed, 0));
  }
  for (const o of Object.values(objects)) {
    if (!shouldDisplayObject(o) || o.parentId) continue;
    parts.push(_renderObjectRow(o, 0, collections));
  }

  _renderFooter(objects, groups);
  if (!parts.length) {
    _listEl.innerHTML = `<div class="ol-empty">${_escape(t('outliner.empty'))}</div>`;
    return;
  }

  _listEl.innerHTML = parts.join('');
  _applySelectionHighlight();
  _applySearchFilter(objects, groups, collections);
}

function _renderFooter(objects, groups) {
  if (!_footerEl) return;
  const nObjects = Object.values(objects).filter(shouldDisplayObject).length;
  const nGroups = Object.keys(groups).length;
  const nSel = getState().selection.selectedIds.length;
  _footerEl.innerHTML = `<span>${_escape(t('outliner.footerObjects', { n: nObjects }))} · ${_escape(t('outliner.footerGroups', { n: nGroups }))}</span>`
    + `<span>${nSel ? _escape(t('outliner.footerSelected', { n: nSel })) : ''}</span>`;
}

function _applySearchFilter(objects, groups, collections) {
  let query = _searchQuery.trim().toLocaleLowerCase();
  if (!query) {
    _listEl.querySelectorAll('.ol-row').forEach(row => { row.hidden = false; });
    return;
  }
  // `file:name` filters by the import an object came from (collections are no
  // longer rows, Decision 2, but provenance stays searchable).
  const fileOnly = query.startsWith('file:');
  if (fileOnly) query = query.slice(5).trim();
  const visibleIds = new Set();
  const addGroupPath = (groupId) => {
    const seen = new Set();
    let id = groupId;
    while (id && !seen.has(id)) {
      seen.add(id);
      visibleIds.add(id);
      id = groups[id]?.parentId ?? null;
    }
  };
  for (const object of Object.values(objects)) {
    if (!shouldDisplayObject(object)) continue;
    const fileName = String(collections?.[object.collectionId]?.name ?? '').toLocaleLowerCase();
    const hit = fileOnly
      ? fileName.includes(query)
      : String(object.name ?? '').toLocaleLowerCase().includes(query) || fileName.includes(query);
    if (!hit) continue;
    visibleIds.add(object.id);
    addGroupPath(object.parentId);
  }
  if (!fileOnly) {
    for (const group of Object.values(groups)) {
      if (String(group.name ?? '').toLocaleLowerCase().includes(query)) addGroupPath(group.id);
    }
  }
  _listEl.querySelectorAll('.ol-row').forEach(row => {
    const id = row.dataset.kind === 'part' ? row.dataset.lead : row.dataset.id;
    row.hidden = !visibleIds.has(id);
  });
}

function _renderGroupBranch(group, allGroups, allObjects, collapsed, depth) {
  const isCollapsed = !!collapsed[group.id];
  const children = (group.childIds ?? []).map(id => allObjects[id]).filter(shouldDisplayObject);
  const subgroups = _subgroupsOf(group.id, allGroups);
  const count = children.length + subgroups.length;
  const scene = getState().scene;

  let html = _renderRow({
    id: group.id,
    kind: 'group',
    name: group.name,
    count,
    visible: groupAnyVisible(group.id, scene),
    locked: !!group.locked,
    inheritedLock: !group.locked && Selection.isEffectivelyLocked(group.id),
    depth,
    hasChildren: count > 0,
    isCollapsed,
    iconName: !isCollapsed && count > 0 ? 'FolderOpen' : 'Folder',
    typeTitle: t('outliner.typeGroup'),
  });

  if (!isCollapsed) {
    for (const sg of subgroups) html += _renderGroupBranch(sg, allGroups, allObjects, collapsed, depth + 1);
    for (const c of children)   html += _renderObjectRow(c, depth + 1, scene.collections);
  }
  return html;
}

function _renderObjectRow(obj, depth, collections = {}) {
  const objects = getState().scene.objects;
  const partIds = logicalObjectPartIds(obj.id, objects).filter(id => id !== obj.id && objects[id]);
  const partCount = partIds.length ? partIds.length + 1 : 0;
  const open = partCount > 0 && _openParts.has(obj.id);
  const fileName = collections?.[obj.collectionId]?.name ?? '';
  let html = _renderRow({
    id: obj.id,
    kind: 'object',
    name: obj.name,
    visible: obj.visible !== false,
    locked: !!obj.locked,
    inheritedLock: !obj.locked && Selection.isEffectivelyLocked(obj.id),
    isPrintPart: !!obj.isPrintPart,
    depth,
    hasChildren: partCount > 0,
    isCollapsed: !open,
    partCount,
    pill: _statusPill(obj.id) + _mixoPill(obj),
    iconName: obj.isGhost ? 'CircleAlert' : (obj.isUnlinked ? 'Link' : 'Box'),
    typeTitle: fileName ? t('outliner.fromFile', { file: fileName }) : t('outliner.typeObject'),
    isGhost: obj.isGhost,
    isUnlinked: obj.isUnlinked,
  });
  if (open) {
    for (const partId of partIds) {
      html += `
    <div class="ol-row ol-row-part" data-id="${escapeAttr(partId)}" data-kind="part" data-lead="${escapeAttr(obj.id)}"
         role="treeitem" tabindex="-1" draggable="false" aria-selected="false"
         title="${escapeAttr(t('outliner.internalPart', { name: obj.name }))}"
         style="--ol-depth:${depth + 1}">
      <span class="ol-twirl ol-twirl-empty"></span>
      <span class="ol-icon">${icon('Box', { width: 14, height: 14 })}</span>
      <span class="ol-name-cell"><span class="ol-name">${_escape(objects[partId].name)}</span></span>
    </div>`;
    }
  }
  return html;
}

function _mixoPill(obj) {
  if (!obj?.mixoProvenance || obj.isInternalPart) return '';
  const status = obj.printRefinement?.status;
  const suffix = status && status !== 'idle' ? ` · ${status === 'ready' && obj.printRefinement.preview === 'refined' ? `Refined L${obj.printRefinement.requestedLevel}` : status}` : '';
  const label = `Mixo 3D${suffix}`;
  return `<span class="ol-pill ol-mixo" title="${escapeAttr(label)}">${icon('Box', { width: 10, height: 10, 'aria-hidden': 'true' })}<span>${_escape(label)}</span></span>`;
}

// Validation status pill from the A6 cache (Blueprint §13 Outliner row
// status). Static trusted markup; the title carries the first message, escaped.
function _statusPill(meshId) {
  const e = getState().scene.validation?.[meshId];
  if (!e || !e.results.length) return '';
  const hasErr = e.results.some(r => r.severity === 'error');
  const fixable = e.results.some(r => r.autoFixAvailable && !r.fixed);
  const cls = `ol-pill ol-validation ${hasErr ? 'ol-validation-error' : 'ol-validation-warning'}${e.stale ? ' ol-validation-stale' : ''}${fixable ? ' ol-validation-fixable' : ''}`;
  const baseMessage = `${e.stale ? `${t('outliner.stalePrefix')} ` : ''}${e.results[0]?.message ?? t('outliner.validationIssue')}`;
  const title = escapeAttr(fixable ? `${baseMessage} — ${t('outliner.repairHint')}` : baseMessage);
  const label = t(fixable ? 'outliner.statusRepair' : 'outliner.statusIssue');
  const glyph = fixable ? icon('Wrench', { width: 10, height: 10 }) : icon(hasErr ? 'CircleAlert' : 'AlertTriangle', { width: 10, height: 10 });
  const open = fixable ? 'button type="button"' : 'span';
  const close = fixable ? 'button' : 'span';
  const dataAction = fixable ? ' data-action="repair"' : '';
  return `<${open} class="${cls}" title="${title}"${dataAction}>${glyph}<span>${_escape(label)}</span></${close}>`;
}

function _renderRow({ id, kind, name, count = 0, partCount = 0, pill = '', visible, locked, inheritedLock = false, isPrintPart, depth, hasChildren, isCollapsed, iconName, typeTitle = '', isGhost, isUnlinked }) {
  const twirl = hasChildren
    ? `<span class="ol-twirl">${icon(isCollapsed ? 'ChevronRight' : 'ChevronDown', { width: 12, height: 12 })}</span>`
    : `<span class="ol-twirl ol-twirl-empty"></span>`;
  const cls = [
    isGhost ? 'ol-ghost' : (isUnlinked ? 'ol-unlinked' : ''),
    locked ? 'ol-locked' : '',
    inheritedLock ? 'ol-locked-inherited' : '',
    !visible ? 'ol-hidden' : '',
    kind === 'object' && !isPrintPart ? 'ol-print-off' : '',
  ].filter(Boolean).join(' ');
  const badge = kind === 'group'
    ? `<span class="ol-badge ol-num" title="${escapeAttr(t('outliner.itemCount', { n: count }))}">${count}</span>`
    : '';
  const partsPill = partCount > 0
    ? `<button type="button" class="ol-pill ol-parts-pill" data-action="parts" title="${escapeAttr(t('outliner.showParts'))}" aria-label="${escapeAttr(t('outliner.showParts'))}">${_escape(t('outliner.partsLabel'))} <span class="ol-num">${partCount}</span></button>`
    : '';
  const printBtn = kind === 'object'
    ? `<button class="ol-icon-btn ol-print ${isPrintPart ? 'ol-print-on' : ''}" type="button" data-action="print" aria-pressed="${isPrintPart ? 'true' : 'false'}" title="${escapeAttr(t(isPrintPart ? 'outliner.removeFromPrint' : 'outliner.markPrintPart'))}">${icon('Printer', { width: 13, height: 13 })}</button>`
    : '';
  return `
    <div class="ol-row ol-row-${escapeAttr(kind)} ${cls}"
         data-id="${escapeAttr(id)}"
         data-kind="${escapeAttr(kind)}"
         data-has-children="${hasChildren ? 'true' : 'false'}"
         role="treeitem"
         tabindex="0"
         draggable="${kind === 'object' || kind === 'group' ? 'true' : 'false'}"
         ${hasChildren ? `aria-expanded="${isCollapsed ? 'false' : 'true'}"` : ''}
         aria-selected="false"
         style="--ol-depth:${depth}">
      ${twirl}
      <span class="ol-icon" title="${escapeAttr(typeTitle)}">${icon(iconName, { width: 14, height: 14 })}</span>
      <span class="ol-name-cell"><span class="ol-name" data-name>${_escape(name)}</span>${kind === 'group' && count === 0 ? `<span class="ol-empty-badge">${_escape(t('outliner.emptyGroup'))}</span>` : ''}</span>
      <span class="ol-trail">
        ${pill}${partsPill}${badge}
        <button class="ol-icon-btn ol-vis" type="button" data-action="vis" aria-pressed="${visible ? 'false' : 'true'}" title="${escapeAttr(t(visible ? 'outliner.hide' : 'outliner.show'))}">${icon(visible ? 'Eye' : 'EyeOff', { width: 13, height: 13 })}</button>
        <button class="ol-icon-btn ol-lock" type="button" data-action="lock" aria-pressed="${locked ? 'true' : 'false'}" title="${escapeAttr(t(locked ? 'outliner.unlock' : 'outliner.lock'))}">${icon(locked ? 'Lock' : 'Unlock', { width: 13, height: 13 })}</button>
        ${printBtn}
      </span>
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

function _readHierarchyDrop(e) {
  if (_draggingNode) return _draggingNode;
  try {
    const raw = e.dataTransfer?.getData(HIERARCHY_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id && (parsed.kind === 'object' || parsed.kind === 'group') ? parsed : null;
  } catch {
    return null;
  }
}

function _isValidParentDrop(node, parentId) {
  if (!node?.id || !parentId) return false;
  const state = getState();
  const currentParent = node.kind === 'group'
    ? state.scene.groups[node.id]?.parentId ?? null
    : state.scene.objects[node.id]?.parentId ?? null;
  if (currentParent === parentId) return false;
  try {
    validateParentChange(node.id, parentId, state);
    return true;
  } catch {
    return false;
  }
}

function _isValidRootDrop(node) {
  if (!node?.id) return false;
  const state = getState();
  const currentParent = node.kind === 'group'
    ? state.scene.groups[node.id]?.parentId ?? null
    : state.scene.objects[node.id]?.parentId ?? null;
  return !!currentParent;
}

// Hide cascades down a group (any visible descendant hides the whole group,
// else show them all); lock lives on the group node and cascades by ancestry.
function _toggleVisibility(id) {
  const scene = getState().scene;
  const ids = cascadeObjectIds([id], scene);
  if (!ids.length) return;
  const isGroup = !scene.objects[id] && !!scene.groups[id];
  const show = isGroup ? !groupAnyVisible(id, scene) : !scene.objects[id]?.visible;
  const prev = Object.fromEntries(ids.map(i => [i, !!scene.objects[i]?.visible]));
  push(new VisibilityCommand(ids, prev, show));
}

function _toggleLock(id) {
  const scene = getState().scene;
  const ids = cascadeLockIds([id], scene);
  if (!ids.length) return;
  const own = scene.objects[id] ?? scene.groups[id];
  const prev = Object.fromEntries(ids.map(i => [i, !!(scene.objects[i] ?? scene.groups[i])?.locked]));
  push(new LockCommand(ids, prev, !own?.locked));
}

function _togglePrintPart(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  const ids = logicalObjectPartIds(meshId, getState().scene.objects);
  beginPrintPartBatch(ids, !obj.isPrintPart);
}


async function _repairFromOutliner(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  // Blocking overlay + percentage + outcome, same runner as the status-bar
  // Fix button and the context menu.
  await repairWithOverlay([meshId], { title: t('print.repairing') });
}

function beginPrintPartBatch(ids, next) {
  beginBatch('Print');
  for (const id of ids) {
    const obj = getState().scene.objects[id];
    if (!obj) continue;
    push(new PrintPartCommand(id, !!obj.isPrintPart, next));
  }
  endBatch();
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

function _toggleParts(id) {
  if (_openParts.has(id)) _openParts.delete(id); else _openParts.add(id);
  _render();
}

function _revealActiveObject() {
  reveal(getState().selection.activeId);
}

/** Expand the ancestors of an object or group row and scroll it into view. */
export function reveal(nodeId) {
  const state = getState();
  const node = state.scene.objects[nodeId] ?? state.scene.groups[nodeId];
  if (!node) { _render(); return; }
  const revealIds = [];
  let parentId = node.parentId;
  const seen = new Set();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    revealIds.push(parentId);
    parentId = state.scene.groups[parentId]?.parentId ?? null;
  }
  if (revealIds.some(id => state.ui.outlinerCollapsed?.[id])) {
    setState(s => {
      const outlinerCollapsed = { ...s.ui.outlinerCollapsed };
      for (const id of revealIds) outlinerCollapsed[id] = false;
      return { ...s, ui: { ...s.ui, outlinerCollapsed } };
    }, { silent: true });
  }
  _render();
  requestAnimationFrame(() => {
    const row = _listEl?.querySelector(`[data-id="${CSS.escape(node.id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });
}

/** Inline-rename the active object's or group's row (F2, context-menu Rename). */
export function renameActive() {
  const id = getState().selection.activeId;
  if (!id || !_listEl) return false;
  reveal(id);   // expand collapsed ancestors so the row exists
  const row = _listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row || row.dataset.kind === 'part' || row.querySelector('.ol-rename-input')) return false;
  _beginRename(row, id);
  return true;
}

function _rowFromEvent(e) {
  const row = e.target.closest?.('.ol-row');
  return row && _listEl.contains(row) ? row : null;
}

function _onListClick(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  // A read-only internal-part row selects its LEAD; parts are not selectable.
  if (row.dataset.kind === 'part') {
    e.stopPropagation();
    const lead = row.dataset.lead;
    if (lead) Selection.set([lead], lead);
    return;
  }
  const id = row.dataset.id;
  const actionBtn = e.target.closest?.('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === 'vis')    _toggleVisibility(id);
    if (action === 'lock')   _toggleLock(id);
    if (action === 'print')  _togglePrintPart(id);
    if (action === 'repair') _repairFromOutliner(id);
    if (action === 'parts')  _toggleParts(id);
    return;
  }
  const twirl = e.target.closest?.('.ol-twirl');
  if (twirl && !twirl.classList.contains('ol-twirl-empty')) {
    e.stopPropagation();
    if (row.dataset.kind === 'group') _toggleCollapsed(id);
    else _toggleParts(id);
    return;
  }
  _activateRow(row, e);
}

function _onListDblClick(e) {
  const row = _rowFromEvent(e);
  if (!row || row.dataset.kind === 'part') return;   // parts are read-only
  const nameEl = row.querySelector('[data-name]');
  if (!nameEl?.contains(e.target)) return;
  _beginRename(row, row.dataset.id);
}

function _onListContextMenu(e) {
  const row = _rowFromEvent(e);
  if (!row) return;
  // A part row acts as its lead object for the menu.
  const id = row.dataset.kind === 'part' ? row.dataset.lead : row.dataset.id;
  const kind = row.dataset.kind === 'part' ? 'object' : row.dataset.kind;
  e.preventDefault();
  e.stopPropagation();
  if (!Selection.getSelectedIds().includes(id)) Selection.set([id], id);
  if (_onContextMenu) _onContextMenu({ x: e.clientX, y: e.clientY, source: 'outliner', targetId: id, targetKind: kind });
}


function _onListDragStart(e) {
  const row = _rowFromEvent(e);
  if (!row || (row.dataset.kind !== 'object' && row.dataset.kind !== 'group')) return;
  const id = row.dataset.id;
  const state = getState();
  if (row.dataset.kind === 'object') {
    const obj = state.scene.objects[id];
    if (!obj || obj.isGhost || obj.isUnlinked) {
      e.preventDefault();
      return;
    }
  } else if (!state.scene.groups[id]) {
    e.preventDefault();
    return;
  }
  _draggingNode = { id, kind: row.dataset.kind };
  if (e.dataTransfer) {
    e.dataTransfer.setData(HIERARCHY_DRAG_MIME, JSON.stringify(_draggingNode));
    e.dataTransfer.effectAllowed = 'move';
  }
  row.classList.add('ol-dragging');
}

function _onListDragEnd() {
  _draggingNode = null;
  _listEl?.classList.remove('ol-drop-root');
  _listEl?.querySelectorAll('.ol-dragging,.ol-drop-parent,.ol-drop-shader')
    .forEach(row => row.classList.remove('ol-dragging', 'ol-drop-parent', 'ol-drop-shader'));
}

function _onListDragOver(e) {
  const row = _rowFromEvent(e);
  if (row?.dataset.kind === 'object' && _hasShaderPayload(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    row.classList.add('ol-drop-shader');
    return;
  }

  const node = _readHierarchyDrop(e);
  if (!node) return;
  if (row?.dataset.kind === 'group' && _isValidParentDrop(node, row.dataset.id)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('ol-drop-parent');
    return;
  }
  if (!row && _isValidRootDrop(node)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    _listEl.classList.add('ol-drop-root');
  }
}

function _onListDragLeave(e) {
  const row = _rowFromEvent(e);
  if (!row) {
    if (!_listEl.contains(e.relatedTarget)) _listEl.classList.remove('ol-drop-root');
    return;
  }
  if (row.contains(e.relatedTarget)) return;
  row.classList.remove('ol-drop-shader', 'ol-drop-parent');
}

function _onListDrop(e) {
  const row = _rowFromEvent(e);
  _listEl.classList.remove('ol-drop-root');
  row?.classList.remove('ol-drop-shader', 'ol-drop-parent');

  if (row?.dataset.kind === 'object') {
    const shaderId = _readShaderDrop(e);
    if (shaderId) {
      e.preventDefault();
      e.stopPropagation();
      const id = row.dataset.id;
      const obj = getState().scene.objects[id];
      if (!obj || obj.shaderId === shaderId) return;
      push(new ShaderAssignCommand(logicalObjectPartIds(id, getState().scene.objects), shaderId));
      return;
    }
  }

  const node = _readHierarchyDrop(e);
  if (!node) return;
  if (row?.dataset.kind === 'group' && _isValidParentDrop(node, row.dataset.id)) {
    e.preventDefault();
    e.stopPropagation();
    push(new ReparentCommand(node.id, row.dataset.id));
    _setCollapsed(row.dataset.id, false);
    return;
  }
  if (!row && _isValidRootDrop(node)) {
    e.preventDefault();
    e.stopPropagation();
    push(new UnparentCommand(node.id));
  }
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
    e.stopPropagation();   // handled here; keep the global F2 binding from firing a second rename
    if (row.dataset.kind !== 'part') _beginRename(row, row.dataset.id);
  } else if (row.dataset.hasChildren === 'true' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const collapse = e.key === 'ArrowLeft';
    if (row.dataset.kind === 'group') _setCollapsed(row.dataset.id, collapse);
    else if (_openParts.has(row.dataset.id) === collapse) _toggleParts(row.dataset.id);
  }
}

function _activateRow(row, e = {}) {
  const id = row.dataset.id;
  const kind = row.dataset.kind;
  if (kind !== 'object' && kind !== 'group') return;
  // Plain row click: scope = the row's parent group (plan §4.5, task 3.2).
  const plain = !(e.ctrlKey || e.metaKey || e.shiftKey);
  if (plain) Selection.scopeToParentOf(id);
  // A group row selects the group itself (a rigid unit, plan §4.5), never its
  // children; Selection accepts both id kinds (2.1).
  if (e.ctrlKey || e.metaKey) Selection.toggle(id);
  else if (e.shiftKey)        Selection.add(id);
  else                        Selection.set([id], id);
}

function _beginRename(rowEl, id) {
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
    push(new RenameCommand(id, cur, newName));
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();   // don't let G/R/S/Delete fire
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
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

export const Outliner = { init, setContextMenuHandler, reveal, renameActive };
