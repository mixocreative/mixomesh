// Workspace presets (Blueprint PART 13b): three fixed task layouts
// (Layout / Shade / Print) switched by a header pill or hotkeys, plus the
// N / T / \ panel-collapse panic keys. Workspace + manual overrides + per-
// workspace panel widths persist to localStorage (per-user preference, NOT
// the .mixo file). v1 scope: panel-level visibility — per-SECTION expand
// presets from the 13b table are a follow-up.
//
// Hotkey note: the spec said Ctrl+1/2/3, but Chrome reserves Ctrl+digit for
// tab switching and never delivers it to the page — we bind Ctrl+Shift+1/2/3.

import { EVENTS } from '../core/events.js';
import { subscribe, dispatch, getState, setState } from '../core/StateManager.js';
import { InputManager } from '../core/InputManager.js';
import { icon } from '../core/Icons.js';

const STORAGE_KEY = 'mixomesh_ui_workspace';
// v2: panelCollapsed went tri-state (absent = defer to workspace default).
// v1 blobs wrote a concrete false for every side, which v2 reads as
// force-show — parseStored migrates v1 by keeping only the `true` overrides.
const STORAGE_VERSION = 2;
const SILENT = { silent: true };

export const WORKSPACES = ['layout', 'shade', 'scene', 'print'];

/**
 * Per-workspace defaults. `right`/`bottom` are panel visibility (manual
 * panelCollapsed overrides layer on top); widths/heights feed the CSS grid
 * variables. Section visibility inside the right column (which of
 * Properties / Shader / Scene / Print show — one specialist section per
 * workspace, no repeats) is CSS-driven via body[data-workspace]
 * (see layout.css) so it needs no per-panel JS.
 */
export const WORKSPACE_DEFAULTS = {
  layout: { right: true, bottom: true,  outlinerWidth: 260, rightWidth: 300, assetHeight: 220, label: 'Layout',  icon: 'Box' },
  shade:  { right: true, bottom: false, outlinerWidth: 220, rightWidth: 340, assetHeight: 220, label: 'Shading', icon: 'Palette' },
  scene:  { right: true, bottom: false, outlinerWidth: 220, rightWidth: 320, assetHeight: 220, label: 'Scene',   icon: 'Boxes' },
  print:  { right: true, bottom: false, outlinerWidth: 220, rightWidth: 320, assetHeight: 220, label: 'Print',   icon: 'Printer' },
};

/**
 * Resolution rule (13b): a manual override always wins; otherwise the
 * workspace default decides. `collapsed[side] === true` hides; `false`
 * shows even when the workspace default hides; `undefined`/absent defers.
 * Pure — unit-tested headlessly.
 */
export function resolvePanelVisible(workspace, panelCollapsed, side) {
  const override = panelCollapsed?.[side];
  if (override === true) return false;
  const def = WORKSPACE_DEFAULTS[workspace] ?? WORKSPACE_DEFAULTS.layout;
  if (override === false) return true;
  return side === 'left' ? true : !!def[side];   // outliner is pinned (13b)
}

/** Parse + migrate a stored localStorage blob. Pure — unit-tested.
 * panelCollapsed is tri-state per side (true = force-hide, false =
 * force-show, absent = defer to workspace default) — only explicit booleans
 * survive parsing; coercing absent → false would force-show every panel and
 * erase the workspace differences. */
export function parseStored(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || (data.v !== STORAGE_VERSION && data.v !== 1)) return null;
    const panelCollapsed = {};
    for (const side of ['left', 'right', 'bottom']) {
      const v = data.panelCollapsed?.[side];
      // v1 wrote false for every side as its "no override" — keep only true.
      if (data.v === 1 ? v === true : typeof v === 'boolean') {
        panelCollapsed[side] = v;
      }
    }
    return {
      workspace: WORKSPACES.includes(data.workspace) ? data.workspace : 'layout',
      panelCollapsed,
      widths: (data.widths && typeof data.widths === 'object') ? data.widths : {},
    };
  } catch {
    return null;
  }
}

let _widths = {};   // workspace → { outlinerWidth, rightWidth, assetHeight }
let _scroll = {};   // workspace → { [rp-body id]: scrollTop } — session-only
let _pillEl = null;

// ── Init ─────────────────────────────────────────────────

/** Seed state from localStorage, render the header pill, bind hotkeys. */
export function init() {
  const stored = typeof localStorage !== 'undefined'
    ? parseStored(localStorage.getItem(STORAGE_KEY))
    : null;
  if (stored) {
    _widths = stored.widths;
    setState(s => ({
      ...s,
      ui: { ...s.ui, workspace: stored.workspace, panelCollapsed: stored.panelCollapsed },
    }), SILENT);
  }

  _renderPill();
  _applyDom();

  InputManager.register('Ctrl+Shift+!', 'global', () => setWorkspace('layout'));
  InputManager.register('Ctrl+Shift+@', 'global', () => setWorkspace('shade'));
  InputManager.register('Ctrl+Shift+#', 'global', () => setWorkspace('scene'));
  InputManager.register('Ctrl+Shift+$', 'global', () => setWorkspace('print'));
  // Shift+digit produces the symbol on US layouts; register the digit form
  // too so non-US layouts that report '1'..'4' still work.
  InputManager.register('Ctrl+Shift+1', 'global', () => setWorkspace('layout'));
  InputManager.register('Ctrl+Shift+2', 'global', () => setWorkspace('shade'));
  InputManager.register('Ctrl+Shift+3', 'global', () => setWorkspace('scene'));
  InputManager.register('Ctrl+Shift+4', 'global', () => setWorkspace('print'));

  InputManager.register('N',  'global', () => togglePanel('right'));
  InputManager.register('T',  'global', () => togglePanel('bottom'));
  InputManager.register('\\', 'global', maxViewport);
}

// ── Public API ───────────────────────────────────────────

/** Switch workspace. Resets manual panel overrides (13b resolution rule). */
export function setWorkspace(name) {
  if (!WORKSPACES.includes(name)) return;
  const from = getState().ui.workspace;
  if (from === name) return;

  _captureWidths(from);
  _captureScroll(from);
  // Reset = NO overrides ({}), so the new workspace's defaults decide.
  // `false` would be a force-show override on every side — the bug that made
  // Layout and Shade look identical.
  setState(s => ({
    ...s,
    ui: { ...s.ui, workspace: name, panelCollapsed: {} },
  }), SILENT);
  _applyDom();
  _restoreScroll(name);
  _persist();
  dispatch(EVENTS.WORKSPACE_CHANGED, { from, to: name });
}

/** Flip one side's manual override (N / T hotkeys, 13b panic pattern). */
export function togglePanel(side) {
  const ui = getState().ui;
  const visibleNow = resolvePanelVisible(ui.workspace, ui.panelCollapsed, side);
  const collapsed = { ...ui.panelCollapsed, [side]: visibleNow };   // hide if visible, show if hidden
  setState(s => ({ ...s, ui: { ...s.ui, panelCollapsed: collapsed } }), SILENT);
  _applyDom();
  _persist();
  dispatch(EVENTS.PANEL_COLLAPSED_CHANGED, { side, collapsed: visibleNow });
}

/** \ — collapse right + bottom together; outliner stays pinned (13b). */
export function maxViewport() {
  setState(s => ({
    ...s,
    ui: { ...s.ui, panelCollapsed: { right: true, bottom: true } },
  }), SILENT);
  _applyDom();
  _persist();
  dispatch(EVENTS.PANEL_COLLAPSED_CHANGED, { side: 'right', collapsed: true });
  dispatch(EVENTS.PANEL_COLLAPSED_CHANGED, { side: 'bottom', collapsed: true });
}

// ── DOM application ──────────────────────────────────────

function _applyDom() {
  const { workspace, panelCollapsed } = getState().ui;
  const def = WORKSPACE_DEFAULTS[workspace];
  const app = document.getElementById('app');
  const rpEl = document.getElementById('right-panel');
  const apEl = document.getElementById('asset-panel');
  if (!app || !rpEl || !apEl) return;

  document.body.dataset.workspace = workspace;

  const w = _widths[workspace] ?? {};
  const setVar = (name, val) => app.style.setProperty(name, `${val}px`);

  const rightVisible  = resolvePanelVisible(workspace, panelCollapsed, 'right');
  const bottomVisible = resolvePanelVisible(workspace, panelCollapsed, 'bottom');

  rpEl.classList.toggle('rp-outer-collapsed', !rightVisible);
  setVar('--right-panel-width', rightVisible ? (w.rightWidth ?? def.rightWidth) : 32);

  apEl.classList.toggle('ap-outer-collapsed', !bottomVisible);
  setVar('--asset-panel-height', bottomVisible ? (w.assetHeight ?? def.assetHeight) : 32);

  setVar('--outliner-width', w.outlinerWidth ?? def.outlinerWidth);

  _syncPill(workspace);
}

// Remember each right-panel body's scroll position per workspace (session
// only) — switching away and back shouldn't lose your place in a long panel.
function _captureScroll(workspace) {
  const out = {};
  document.querySelectorAll('#right-panel .rp-body').forEach(el => {
    if (el.id && el.scrollTop > 0) out[el.id] = el.scrollTop;
  });
  _scroll[workspace] = out;
}

function _restoreScroll(workspace) {
  const saved = _scroll[workspace];
  if (!saved) return;
  // After the panels re-render for the new workspace.
  requestAnimationFrame(() => {
    for (const [id, top] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el) el.scrollTop = top;
    }
  });
}

function _captureWidths(workspace) {
  const olEl = document.getElementById('outliner');
  const rpEl = document.getElementById('right-panel');
  const apEl = document.getElementById('asset-panel');
  if (!olEl || !rpEl || !apEl) return;
  const cur = {
    outlinerWidth: Math.round(olEl.getBoundingClientRect().width),
    rightWidth:    Math.round(rpEl.getBoundingClientRect().width),
    assetHeight:   Math.round(apEl.getBoundingClientRect().height),
  };
  // Don't memorise collapsed strips as "the width" — keep prior/default.
  const prev = _widths[workspace] ?? {};
  const def = WORKSPACE_DEFAULTS[workspace];
  _widths[workspace] = {
    outlinerWidth: cur.outlinerWidth > 60 ? cur.outlinerWidth : (prev.outlinerWidth ?? def.outlinerWidth),
    rightWidth:    cur.rightWidth    > 60 ? cur.rightWidth    : (prev.rightWidth    ?? def.rightWidth),
    assetHeight:   cur.assetHeight   > 60 ? cur.assetHeight   : (prev.assetHeight   ?? def.assetHeight),
  };
}

function _persist() {
  if (typeof localStorage === 'undefined') return;
  const { workspace, panelCollapsed } = getState().ui;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION, workspace, panelCollapsed, widths: _widths,
    }));
  } catch { /* quota/privacy mode — preference loss only */ }
}

// ── Header pill ──────────────────────────────────────────

function _renderPill() {
  const header = document.getElementById('header');
  if (!header) return;
  _pillEl = document.createElement('div');
  _pillEl.className = 'ws-switcher';
  _pillEl.setAttribute('role', 'tablist');
  _pillEl.setAttribute('aria-label', 'Workspace');
  for (const name of WORKSPACES) {
    const def = WORKSPACE_DEFAULTS[name];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-btn';
    btn.dataset.ws = name;
    btn.innerHTML = `${icon(def.icon, { width: 13, height: 13 })}<span>${def.label}</span>`;
    btn.title = `${def.label} workspace (Ctrl+Shift+${WORKSPACES.indexOf(name) + 1})`;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => setWorkspace(name));
    _pillEl.appendChild(btn);
  }
  header.appendChild(_pillEl);
}

function _syncPill(workspace) {
  if (!_pillEl) return;
  _pillEl.querySelectorAll('.ws-btn').forEach(b => {
    const active = b.dataset.ws === workspace;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

export const Workspace = { init, setWorkspace, togglePanel, maxViewport };
