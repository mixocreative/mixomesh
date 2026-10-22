// Viewport statistics HUD (owner request 2026-10-21), bottom-left of the
// viewport: "Selected 2 / 5 · Faces 1,234,567 · Vertices 617,890", or the
// scene totals when nothing is selected. After a geometry change (Subdivide,
// decimate, Boolean, repair, undo/redo, import) the changed count reads
// "12,000 → 48,000" for ~3 s, then settles. Event-driven and coalesced — no
// per-frame polling; counts come from core/scene/TriangleCount (the one counter).
// Non-interactive except its hide button; toggled from the viewport display
// strip ("Statistics"), default on, per-user persisted, never stored in a
// project. Not a live region (it would spam screen readers); the readout is
// the element's accessible label instead.

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { canonicalObjectId } from '../core/LogicalObjects.js';
import { nextHighlight, statsView } from '../core/scene/SceneStats.js';
import { displayedCounts, sceneObjectMeshes } from '../core/scene/TriangleCount.js';
import { selectionMeshes } from './MeshStats.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { t, getLocale } from '../i18n/index.js';

// Events that can change counts (geometry) vs. only what is counted (selection).
const GEOMETRY_EVENTS = [
  EVENTS.GEOMETRY_CHANGED, EVENTS.ASSET_INSTANTIATED, EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED,
  EVENTS.HISTORY_PUSHED, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE, EVENTS.VALIDATION_COMPLETE,
  EVENTS.REFINEMENT_READY, EVENTS.REFINEMENT_CHANGED, EVENTS.REFINEMENT_CANCELLED, EVENTS.REFINEMENT_STALE,
  EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW,
];
const VIEW_EVENTS = [EVENTS.SELECTION_CHANGED, EVENTS.LOCALE_CHANGED];

let _root = null;
let _els = null;
let _visible = true;
let _queued = false;
let _geometryPending = false;
let _prev = null;
let _highlight = null;
let _settleTimer = null;
let _now = () => Date.now();

/** Test seam: replace the clock. */
export function setClock(fn) { _now = fn ?? (() => Date.now()); }

/**
 * Current snapshot (pure over state + registry; exported for tests).
 * @returns {{ kind: string, key: string, selected: number, total: number, tris: number, verts: number }}
 */
export function snapshot() {
  const state = getState();
  const objects = state.scene?.objects ?? {};
  const sel = state.selection?.selectedIds ?? [];
  const leads = new Set(Object.keys(objects).filter(id => !objects[id]?.isGhost).map(id => canonicalObjectId(id, objects)));
  const total = leads.size;
  const meshes = sel.length ? selectionMeshes(sel) : sceneObjectMeshes(objects);
  const { tris, verts } = displayedCounts(meshes, { objects });
  return {
    kind: sel.length ? 'selection' : 'scene',
    key: sel.length ? [...sel].sort().join('|') : 'scene',
    selected: sel.length, total, tris, verts,
  };
}

function _ensure() {
  if (_root) return true;
  const viewport = document.getElementById('viewport');
  if (!viewport) return false;
  _root = document.createElement('div');
  _root.id = 'stats-hud';
  _root.className = 'stats-hud';
  _root.setAttribute('role', 'group');
  _root.innerHTML = `
    <span class="sh-scope"></span><span class="sh-sep" aria-hidden="true">·</span>
    <span class="sh-tris"></span><span class="sh-sep" aria-hidden="true">·</span>
    <span class="sh-verts"></span>
    <button type="button" class="sh-hide">×</button>`;
  _els = {
    scope: _root.querySelector('.sh-scope'),
    tris: _root.querySelector('.sh-tris'),
    verts: _root.querySelector('.sh-verts'),
    hide: _root.querySelector('.sh-hide'),
  };
  _els.hide.addEventListener('click', (e) => { e.stopPropagation(); setStatsVisible(false, { persist: true }); });
  viewport.appendChild(_root);
  return true;
}

function _render(geometryChanged = false) {
  _queued = false;
  if (!_ensure()) return;
  const snap = snapshot();
  const now = _now();
  _highlight = nextHighlight(_prev, snap, _highlight, now, geometryChanged);
  _prev = snap;
  const view = statsView({ ...snap, highlight: _highlight, now, locale: getLocale?.() ?? 'en', t });
  _els.scope.textContent = view.scope;
  _els.tris.textContent = view.triangles;
  _els.verts.textContent = view.vertices;
  _els.tris.classList.toggle('sh-changed', view.changed.tris);
  _els.verts.classList.toggle('sh-changed', view.changed.verts);
  _root.setAttribute('aria-label', `${t('stats.region')}: ${view.ariaLabel}`);
  _els.hide.setAttribute('aria-label', t('stats.hide'));
  _els.hide.title = t('stats.hide');
  _root.hidden = !_visible;
  clearTimeout(_settleTimer);
  if (_highlight) _settleTimer = setTimeout(() => _schedule(false), Math.max(0, _highlight.until - now) + 20);
}

function _schedule(geometry) {
  if (geometry) _geometryPending = true;
  if (_queued) return;
  _queued = true;
  queueMicrotask(() => {
    const g = _geometryPending;
    _geometryPending = false;
    _render(g);
  });
}

/** Recompute now (tests). */
export function refresh(geometryChanged = false) { _render(geometryChanged); }

/**
 * Show / hide the HUD. `persist` writes the per-user setting (hide button, toggle).
 * @param {boolean} on
 * @param {{ persist?: boolean }} [opts]
 */
export function setStatsVisible(on, { persist = false } = {}) {
  _visible = !!on;
  if (persist) {
    setState(s => ({ ...s, scene: { ...s.scene, overlays: { ...s.scene.overlays, stats: _visible } } }), { silent: true });
    SettingsStore.scheduleSave?.();
    dispatchToggleRefresh();
  }
  if (_root) _root.hidden = !_visible;
  if (_visible) _schedule(false);
}

let _onToggleChange = null;
/** The viewport toggle strip registers here so the hide button keeps it in sync. */
export function onVisibilityChange(fn) { _onToggleChange = fn; }
function dispatchToggleRefresh() { try { _onToggleChange?.(); } catch { /* strip not mounted */ } }

/** Mount and subscribe. Call once after the viewport exists. */
export function init() {
  _visible = getState().scene?.overlays?.stats !== false;
  _ensure();
  for (const ev of GEOMETRY_EVENTS) subscribe(ev, () => _schedule(true));
  for (const ev of VIEW_EVENTS) subscribe(ev, () => _schedule(false));
  for (const ev of [EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW, EVENTS.SETTINGS_RESET]) {
    subscribe(ev, () => setStatsVisible(getState().scene?.overlays?.stats !== false));
  }
  _render(false);
}

export const StatsHud = { init, refresh, snapshot, setStatsVisible, onVisibilityChange, setClock };
