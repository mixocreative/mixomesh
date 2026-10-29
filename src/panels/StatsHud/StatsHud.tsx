// Viewport statistics HUD (owner request 2026-10-21), bottom-left of the viewport: "Selected 2 / 5 ·
// Faces 1,234,567 · Vertices 617,890", or the scene totals when nothing is selected. After a geometry
// change (Subdivide, decimate, Boolean, repair, undo/redo, import) the changed count reads
// "12,000 → 48,000" for ~3 s, then settles. Event-driven and coalesced, no per-frame polling; counts
// come from core/scene/TriangleCount (the one counter). React twin: a small controller (events,
// microtask coalescing, settle timer) feeds a view model; the component only renders it, and the model
// is replaced only when its text changes, so an unchanged readout costs no React commit.
// Toggled from the viewport display strip ("Statistics"), default on, per-user persisted, never stored
// in a project. Not a live region (it would spam screen readers); the readout is the accessible label.

import { useSyncExternalStore } from 'react';
import { Button } from '../../kit/index.ts';
import { mountPanel, useT } from '../../react/index.ts';
import { EVENTS } from '../../core/events.js';
import { subscribe, getState, setState } from '../../core/StateManager.js';
import { nextHighlight, statsView } from '../../core/scene/SceneStats.js';
import { SettingsStore } from '../../core/SettingsStore.js';
import { t, getLocale } from '../../i18n/index.js';
import { snapshot } from './snapshot.ts';

export { snapshot };

// Events that can change counts (geometry) vs. only what is counted (selection).
const GEOMETRY_EVENTS = [
  EVENTS.GEOMETRY_CHANGED, EVENTS.ASSET_INSTANTIATED, EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED,
  EVENTS.HISTORY_PUSHED, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE, EVENTS.VALIDATION_COMPLETE,
  EVENTS.REFINEMENT_READY, EVENTS.REFINEMENT_CHANGED, EVENTS.REFINEMENT_CANCELLED, EVENTS.REFINEMENT_STALE,
  EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW,
];
const VIEW_EVENTS = [EVENTS.SELECTION_CHANGED, EVENTS.LOCALE_CHANGED];

interface Model {
  visible: boolean;
  scope: string; triangles: string; vertices: string;
  changedTris: boolean; changedVerts: boolean;
  aria: string;
}
const EMPTY: Model = { visible: true, scope: '', triangles: '', vertices: '', changedTris: false, changedVerts: false, aria: '' };

let _model: Model = EMPTY;
const _subs = new Set<() => void>();
function _publish(next: Model) {
  const same = (Object.keys(next) as (keyof Model)[]).every((k) => next[k] === _model[k]);
  if (same) return;
  _model = next;
  _subs.forEach((fn) => fn());
}
const _subscribe = (fn: () => void) => { _subs.add(fn); return () => { _subs.delete(fn); }; };

let _unmount: (() => void) | null = null;
let _visible = true;
let _queued = false;
let _geometryPending = false;
let _prev: ReturnType<typeof snapshot> | null = null;
let _highlight: { from: { tris: number; verts: number }; until: number } | null = null;
let _settleTimer: ReturnType<typeof setTimeout> | undefined;
let _now = () => Date.now();
let _offs: Array<() => void> = [];

/** Test seam: replace the clock. */
export function setClock(fn: (() => number) | null) { _now = fn ?? (() => Date.now()); }

function _render(geometryChanged = false) {
  _queued = false;
  const snap = snapshot();
  const now = _now();
  _highlight = nextHighlight(_prev, snap, _highlight, now, geometryChanged);
  _prev = snap;
  const view = statsView({ ...snap, highlight: _highlight, now, locale: getLocale?.() ?? 'en', t });
  _publish({
    visible: _visible,
    scope: view.scope, triangles: view.triangles, vertices: view.vertices,
    changedTris: !!view.changed.tris, changedVerts: !!view.changed.verts,
    aria: `${t('stats.region')}: ${(view as { ariaLabel?: string }).ariaLabel ?? view.label}`,
  });
  clearTimeout(_settleTimer);
  if (_highlight) _settleTimer = setTimeout(() => _schedule(false), Math.max(0, _highlight.until - now) + 20);
}

function _schedule(geometry: boolean) {
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

/** Show / hide the HUD. `persist` writes the per-user setting (hide button, toggle). */
export function setStatsVisible(on: boolean, { persist = false }: { persist?: boolean } = {}) {
  _visible = !!on;
  if (persist) {
    setState((s: { scene: { overlays: object } }) => ({ ...s, scene: { ...s.scene, overlays: { ...s.scene.overlays, stats: _visible } } }), { silent: true });
    SettingsStore.scheduleSave?.();
    try { _onToggleChange?.(); } catch { /* strip not mounted */ }
  }
  _publish({ ..._model, visible: _visible });
  if (_visible) _schedule(false);
}

let _onToggleChange: (() => void) | null = null;
/** The viewport toggle strip registers here so the hide button keeps it in sync. */
export function onVisibilityChange(fn: () => void) { _onToggleChange = fn; }

function HudView() {
  const tt = useT();
  const m = useSyncExternalStore(_subscribe, () => _model, () => _model);
  return (
    <div id="stats-hud" className="stats-hud" role="group" aria-label={m.aria} hidden={!m.visible}>
      <span className="sh-scope">{m.scope}</span><span className="sh-sep" aria-hidden="true">·</span>
      <span className={`sh-tris${m.changedTris ? ' sh-changed' : ''}`}>{m.triangles}</span><span className="sh-sep" aria-hidden="true">·</span>
      <span className={`sh-verts${m.changedVerts ? ' sh-changed' : ''}`}>{m.vertices}</span>
      <Button
        variant="icon" className="sh-hide" aria-label={tt('stats.hide')} title={tt('stats.hide')}
        onClick={(e) => { e.stopPropagation(); setStatsVisible(false, { persist: true }); }}
      >×</Button>
    </div>
  );
}

/** Mount and subscribe. Call once after the viewport exists. */
export function init() {
  if (_unmount) return;
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  _visible = getState().scene?.overlays?.stats !== false;
  const root = document.createElement('div');
  root.id = 'stats-hud-root';
  root.className = 'mx-kit';
  root.style.display = 'contents';
  viewport.appendChild(root);
  _model = { ...EMPTY, visible: _visible };
  _unmount = mountPanel('stats-hud-root', <HudView />);
  for (const ev of GEOMETRY_EVENTS) _offs.push(subscribe(ev, () => _schedule(true)) as () => void);
  for (const ev of VIEW_EVENTS) _offs.push(subscribe(ev, () => _schedule(false)) as () => void);
  for (const ev of [EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW, EVENTS.SETTINGS_RESET]) {
    _offs.push(subscribe(ev, () => setStatsVisible(getState().scene?.overlays?.stats !== false)) as () => void);
  }
  _render(false);
}

export function unmount() {
  _offs.forEach((off) => off());
  _offs = [];
  clearTimeout(_settleTimer);
  _unmount?.();
  _unmount = null;
  document.getElementById('stats-hud-root')?.remove();
  _prev = null; _highlight = null; _queued = false; _geometryPending = false;
  _model = EMPTY;
}

export const StatsHud = { init, unmount, refresh, snapshot, setStatsVisible, onVisibilityChange, setClock };
