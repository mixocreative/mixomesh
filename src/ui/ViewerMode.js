// Phone viewer (overhaul 8.6). Under 768 px the app becomes a read-only
// viewer: the viewport fills the screen, a bottom sheet names the selection
// (name, size in mm, scale) and a project / "Open a file…" screen replaces the
// editing chrome. Layout + hiding are CSS (src/styles/viewer.css, the same
// 768 px breakpoint as core/ViewerModel.js); this module owns the behaviour:
//
//  - read-only: InputManager.setReadOnly (no shortcuts but camera/select, no
//    body drag, no context menu) + SceneManager.setViewOnly (no gizmo).
//    The editing and export surfaces (header, panels, toolbar, toggles) are
//    display:none, so nothing in them can be reached or focused.
//  - open: a file input for .mixo / GLB / glTF / 3MF / OBJ / STL that routes
//    through the existing entry points (PersistenceManager.openPicked,
//    importWithDedupe under safeImport) — no loader is duplicated here — and,
//    where the storage tier lists its own projects (OPFS), that list.
//  - nothing here dispatches a scene mutation; it only loads and selects.

import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { InputManager } from '../core/InputManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { storage } from '../core/storage/StorageAdapter.js';
import { importWithDedupe, beginImportBatch } from '../core/assets/AssetImport.js';
import { isTextureExt } from '../core/assets/AssetTypes.js';
import { canonicalObjectId } from '../core/LogicalObjects.js';
import { BU_TO_MM } from '../core/print/ExportContext.js';
import { withRestTransform } from '../core/scene/ImportBounce.js';
import {
  VIEWER_MAX_WIDTH, VIEWER_OPEN_EXTENSIONS, topLevelItems, unionExtents, describeItem,
  openKindFor, recencyBucket,
} from '../core/ViewerModel.js';
import { t } from '../i18n/index.js';
import { tr } from './lib/tr.js';
import { icon } from '../core/Icons.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { safeImport } from './ImportError.js';
import { safeAsync } from './Status.js';
import { selectionMeshes } from './MeshStats.js';

const SUBSCRIBED = [
  EVENTS.SELECTION_CHANGED, EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW,
  EVENTS.ASSET_INSTANTIATED, EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED,
  EVENTS.OBJECT_RENAMED, EVENTS.GROUP_CREATED, EVENTS.GROUP_DISSOLVED, EVENTS.PROJECT_RENAMED,
  EVENTS.TRANSFORM_COMMITTED, EVENTS.LOCALE_CHANGED,
];
const OPEN_ACCEPT = [...VIEWER_OPEN_EXTENSIONS, '.mtl', '.png', '.jpg', '.jpeg', '.bin'].join(',');

let _root = null;
let _active = false;
let _screen = 'home';          // 'home' (projects + open) | 'view'
let _listOpen = false;
let _sheetObserver = null;
let _input = null;

/** @returns {boolean} the viewer layout is active. */
export function isActive() { return _active; }

/**
 * Switch the viewer on/off (driven by the 768 px media query; exported so a
 * test can drive it without a real window).
 * @param {boolean} on
 */
export function setActive(on) {
  const next = !!on;
  if (next === _active && _root) return;
  _active = next;
  if (next) document.body.dataset.viewer = '1';
  else delete document.body.dataset.viewer;
  InputManager.setReadOnly(next);
  SceneManager.setViewOnly(next);
  if (next) {
    _listOpen = false;
    _screen = Object.keys(getState().scene.objects).length ? 'view' : 'home';
    // A selection left from the desktop layout is fine; clear any scope so a
    // tap always resolves at the top level of the file.
    Selection.setScope?.(null);
  }
  render();
}

// ── Data → DOM ───────────────────────────────────────────

function _hasContent() { return Object.keys(getState().scene.objects).length > 0; }

function _selectedItemId() {
  const { objects, groups } = getState().scene;
  const id = Selection.getActiveId() ?? Selection.getSelectedIds()[0] ?? null;
  if (!id) return null;
  if (groups[id]) return id;
  const lead = canonicalObjectId(id, objects);
  return objects[lead] ? lead : null;
}

// Measured at RESTING scale: a freshly opened model is mid import-bounce, and
// the transient pop factor would show the wrong size (30.8 vs 50 mm seen).
function _measure(id) {
  const extentsBU = withRestTransform(() => {
    const boxes = [];
    for (const m of selectionMeshes([id])) {
      if (!m?.geometry) continue;
      m.computeWorldMatrix?.(true);
      const bb = m.getBoundingInfo?.()?.boundingBox;
      if (bb) boxes.push({ min: bb.minimumWorld, max: bb.maximumWorld });
    }
    return unionExtents(boxes);   // inside: world boxes revert when fn returns
  });
  return { extentsBU, buToMm: BU_TO_MM };
}

function _renderBar() {
  const title = _root.querySelector('.vm-title');
  if (title) title.textContent = _screen === 'home' ? tr('viewer.projects', 'Projects') : (getState().project?.name || 'Untitled');
  const bar = _root.querySelector('.vm-bar');
  bar?.classList.toggle('vm-bar-home', _screen === 'home');
  const homeBtn = _root.querySelector('[data-vm="home"]');
  if (homeBtn) homeBtn.hidden = _screen === 'home';
  const backBtn = _root.querySelector('[data-vm="back"]');
  if (backBtn) backBtn.hidden = !(_screen === 'home' && _hasContent());
  const listBtn = _root.querySelector('[data-vm="list"]');
  if (listBtn) {
    listBtn.hidden = _screen === 'home';
    listBtn.setAttribute('aria-expanded', String(_listOpen));
  }
}

function _renderList() {
  const el = _root.querySelector('.vm-list');
  if (!el) return;
  el.hidden = !(_listOpen && _screen === 'view');
  if (el.hidden) return;
  const items = topLevelItems(getState().scene);
  const active = _selectedItemId();
  el.innerHTML = items.length
    ? items.map(it => `
      <button type="button" class="vm-item${it.id === active ? ' vm-item-on' : ''}" data-vm-item="${escapeAttr(it.id)}">
        <span class="vm-thumb">${icon(it.kind === 'group' ? 'Folder' : 'Box', { width: 18, height: 18 })}</span>
        <span class="vm-item-text"><b>${escapeHtml(it.name)}</b>${it.kind === 'group'
          ? `<span>${escapeHtml(t('outliner.itemCount', { n: it.count }))}</span>` : ''}</span>
      </button>`).join('')
    : `<p class="vm-empty">${escapeHtml(tr('viewer.emptyList', 'Nothing in this file yet.'))}</p>`;
}

function _renderSheet() {
  const el = _root.querySelector('.vm-sheet');
  if (!el) return;
  const id = _screen === 'view' && _active ? _selectedItemId() : null;
  const info = id ? describeItem(getState().scene, id, _measure(id)) : null;
  if (!info) {
    el.hidden = _screen !== 'view' || !_hasContent();
    el.classList.add('vm-sheet-hint');
    el.innerHTML = `<span class="vm-handle"></span><p class="vm-hint">${escapeHtml(tr('viewer.tapHint', 'Tap an object to see its size and scale.'))}</p>`;
    return;
  }
  el.hidden = false;
  el.classList.remove('vm-sheet-hint');
  const scale = info.scale ?? tr('viewer.mixedScale', 'Mixed');
  const rows = [
    [tr('viewer.size', 'Size'), info.size || '–'],
    [tr('viewer.scale', 'Scale'), scale],
  ];
  if (info.kind === 'group') rows.push([tr('viewer.contains', 'Contains'), t('outliner.itemCount', { n: info.count })]);
  el.innerHTML = `
    <span class="vm-handle"></span>
    <h4>${escapeHtml(info.name)}</h4>
    <dl class="vm-kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
}

async function _renderProjects() {
  const el = _root.querySelector('.vm-projects');
  if (!el) return;
  el.hidden = _screen !== 'home';
  if (_screen !== 'home') return;
  let projects = [];
  let failed = false;
  if (typeof storage.listProjects === 'function') {
    try { projects = await storage.listProjects(); } catch { failed = true; }
  }
  if (_screen !== 'home') return;   // switched while the list loaded
  if (failed) {
    el._projects = [];
    el.innerHTML = `<p class="vm-empty vm-error" role="alert">${escapeHtml(tr('viewer.projectsError', 'Your saved projects could not be read.'))}</p>
      <button type="button" class="vm-open" data-vm="retry">${escapeHtml(tr('viewer.retry', 'Try again'))}</button>`;
    return;
  }
  const now = Date.now();
  el.innerHTML = projects.length
    ? projects.map((p, i) => {
      const b = recencyBucket(p.lastModified, now);
      const when = b === 'today' ? tr('viewer.editedToday', 'Edited today')
        : b === 'yesterday' ? tr('viewer.editedYesterday', 'Edited yesterday')
          : tr('viewer.editedOn', 'Edited {date}').replace('{date}', new Date(p.lastModified).toLocaleDateString());
      return `
      <button type="button" class="vm-item" data-vm-project="${i}">
        <span class="vm-thumb">${icon('Box', { width: 18, height: 18 })}</span>
        <span class="vm-item-text"><b>${escapeHtml(String(p.name).replace(/\.mixo$/i, ''))}</b><span>${escapeHtml(when)}</span></span>
      </button>`;
    }).join('')
    : `<p class="vm-empty">${escapeHtml(tr('viewer.noProjects', 'No saved projects here yet. Open a file to start.'))}</p>`;
  el._projects = projects;
}

/** Re-render every viewer surface. */
export function render() {
  if (!_root) return;
  _renderBar();
  _root.querySelector('.vm-home').hidden = _screen !== 'home';
  _renderList();
  _renderSheet();
  _syncSheetHeight();
  if (_screen === 'home' && _active) _renderProjects();
}

function _syncSheetHeight() {
  const el = _root?.querySelector('.vm-sheet');
  const h = el && !el.hidden && _active ? Math.round(el.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--vm-sheet-h', `${h}px`);
}

// ── Actions ──────────────────────────────────────────────

function _show(screen) {
  _screen = screen;
  _listOpen = false;
  render();
}

async function _openProjectEntry(entry) {
  const picked = await storage.pickOpenProject({ ref: entry.ref });
  if (!picked) return;
  await PersistenceManager.openPicked(picked);
  _show('view');
}

async function _openFiles(files) {
  const project = files.find(f => openKindFor(f.name) === 'project');
  if (project) {
    // OPFS tier keeps its own copy so the project shows up in the list next
    // time; other tiers load straight from the picked file.
    const picked = typeof storage.importProjectFile === 'function'
      ? await storage.importProjectFile(project, project.name)
      : { ref: null, file: project };
    await PersistenceManager.openPicked(picked);
    _show('view');
    return;
  }
  const meshes = files.filter(f => openKindFor(f.name) === 'model');
  if (!meshes.length) return;
  const siblingFiles = files.filter(f => {
    const n = f.name.toLowerCase();
    return n.endsWith('.mtl') || isTextureExt(n.slice(n.lastIndexOf('.')));
  });
  // A viewer shows one file at a time: start from a blank scene (the dirty
  // confirm inside newProject protects anything unsaved; cancelling keeps it).
  if (_hasContent()) {
    await PersistenceManager.newProject();
    if (_hasContent()) return;
  }
  const B = window.BABYLON;
  let at = B.Vector3.Zero();
  const batch = beginImportBatch();   // Cancel ends the whole open (review I5)
  try {
    for (const file of meshes) {
      if (batch.signal.aborted) break;
      const ids = await safeImport(() => batch.run(signal => importWithDedupe(file, file.name, at, { ...(siblingFiles.length ? { siblingFiles } : {}), signal })), file.name);
      if (Array.isArray(ids) && ids.length) {
        const w = withRestTransform(() => {
          const bb = selectionMeshes(ids).map(m => { m?.computeWorldMatrix?.(true); return m?.getBoundingInfo?.()?.boundingBox; }).filter(Boolean);
          return bb.length ? Math.max(...bb.map(b => b.maximumWorld.x - b.minimumWorld.x)) : 0;
        });
        if (w) at = at.add(new B.Vector3(w * 1.1, 0, 0));
      }
    }
  } finally {
    batch.end();
  }
  if (_hasContent()) _show('view');
}

function _onClick(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const vm = /** @type {HTMLElement|null} */ (target.closest('[data-vm]'))?.dataset.vm;
  if (vm === 'open') { _input?.click(); return; }
  if (vm === 'home') { _show('home'); return; }
  if (vm === 'back') { _show('view'); return; }
  if (vm === 'list') { _listOpen = !_listOpen; render(); return; }
  if (vm === 'retry') { _renderProjects(); return; }
  const itemId = /** @type {HTMLElement|null} */ (target.closest('[data-vm-item]'))?.dataset.vmItem;
  if (itemId) {
    Selection.setScope?.(null);
    Selection.set([itemId], itemId);
    _listOpen = false;
    render();
    SceneManager.frameSelected?.();
    return;
  }
  const pi = /** @type {HTMLElement|null} */ (target.closest('[data-vm-project]'))?.dataset.vmProject;
  if (pi != null) {
    const entry = /** @type {any} */ (_root.querySelector('.vm-projects'))?._projects?.[Number(pi)];
    if (entry) safeAsync(() => _openProjectEntry(entry));
  }
}

// ── Mount ────────────────────────────────────────────────

function _build() {
  _root = document.createElement('div');
  _root.id = 'viewer-root';
  _root.innerHTML = `
    <header class="vm-bar">
      <button type="button" class="vm-btn" data-vm="home" aria-label="${escapeAttr(tr('viewer.toProjects', 'Projects'))}">${icon('ChevronLeft', { width: 20, height: 20 })}</button>
      <button type="button" class="vm-btn" data-vm="back" hidden aria-label="${escapeAttr(tr('viewer.backToModel', 'Back to model'))}">${icon('ChevronLeft', { width: 20, height: 20 })}</button>
      <b class="vm-title"></b>
      <button type="button" class="vm-btn" data-vm="list" aria-expanded="false" aria-label="${escapeAttr(tr('viewer.objects', 'Objects'))}">${icon('Layers', { width: 20, height: 20 })}</button>
    </header>
    <section class="vm-home" aria-label="${escapeAttr(tr('viewer.projects', 'Projects'))}">
      <div class="vm-projects"></div>
      <footer class="vm-foot">
        <button type="button" class="vm-open" data-vm="open">${escapeHtml(tr('viewer.openFile', 'Open a file…'))}</button>
        <span class="vm-foot-hint">${escapeHtml(tr('viewer.openHint', '.mixo, GLB, glTF, 3MF, OBJ, STL · stays on this device'))}</span>
      </footer>
    </section>
    <section class="vm-list" hidden aria-label="${escapeAttr(tr('viewer.objects', 'Objects'))}"></section>
    <section class="vm-sheet" hidden aria-live="polite"></section>
    <input type="file" class="vm-file" multiple accept="${escapeAttr(OPEN_ACCEPT)}" hidden>`;
  document.body.appendChild(_root);
  _input = _root.querySelector('.vm-file');
  _input.addEventListener('change', () => {
    const files = [...(_input.files ?? [])];
    _input.value = '';
    if (files.length) safeAsync(() => _openFiles(files));
  });
  _root.addEventListener('click', _onClick);
}

/** Build the viewer DOM and follow the 768 px media query. */
export function init() {
  if (_root) return;
  _build();
  for (const ev of SUBSCRIBED) subscribe(ev, () => { if (_root) render(); });
  // The viewport shrinks by the sheet's height (CSS var) so the model stays visible above it.
  if (typeof ResizeObserver !== 'undefined') {
    _sheetObserver = new ResizeObserver(_syncSheetHeight);
    _sheetObserver.observe(_root.querySelector('.vm-sheet'));
  }
  const mq = window.matchMedia?.(`(max-width: ${VIEWER_MAX_WIDTH - 1}px)`);
  if (!mq) return;
  mq.addEventListener?.('change', (e) => setActive(e.matches));
  setActive(mq.matches);
}

export const ViewerMode = { init, isActive, setActive, render };
