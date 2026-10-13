// Slide-over panel sheets (overhaul 8.3). Below 1280 px the Outliner,
// Properties (right column) and Asset panel stop squeezing the viewport and
// become sheets that slide over it; this module owns the edge tabs that open
// and close them and mirrors the active layout tier on <body data-layout>.
// All geometry lives in src/styles/responsive.css (same breakpoints as
// core/ViewerModel.js). At >= 1280 px the tabs are display:none and nothing
// here has any visible effect — the desktop layout is untouched.

import { layoutModeForWidth } from '../core/ViewerModel.js';
import { tr } from './lib/tr.js';
import { subscribe } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

const SHEETS = [
  { id: 'outliner',  panel: 'outliner',    expand: '.ol-expand-strip', key: 'sheets.outliner',   fallback: 'Outliner' },
  { id: 'inspector', panel: 'right-panel', expand: '.rp-expand-strip', key: 'sheets.properties', fallback: 'Properties' },
  { id: 'assets',    panel: 'asset-panel', expand: '.ap-expand-strip', key: 'sheets.assets',     fallback: 'Assets' },
];

let _tabs = [];
let _open = '';

/** @returns {string} id of the open sheet ('' = none). */
export function openSheet() { return _open; }

/**
 * Open one sheet (closing any other) or close all with ''.
 * @param {''|'outliner'|'inspector'|'assets'} id
 */
export function setSheet(id) {
  const next = SHEETS.some(s => s.id === id) ? id : '';
  _open = next;
  if (next) document.body.dataset.sheet = next;
  else delete document.body.dataset.sheet;
  const def = SHEETS.find(s => s.id === next);
  if (def) {
    // A panel the user collapsed on desktop would open as an empty strip:
    // use its own expand control so width + class state stay in step.
    const panel = document.getElementById(def.panel);
    if (panel?.matches('.ol-outer-collapsed, .rp-outer-collapsed, .ap-outer-collapsed')) {
      /** @type {HTMLElement|null} */ (panel.querySelector(def.expand))?.click();
    }
  }
  _syncTabs();
}

function _syncTabs() {
  for (const tab of _tabs) {
    const on = tab.dataset.sheetToggle === _open;
    tab.setAttribute('aria-expanded', String(on));
    tab.classList.toggle('open', on);
  }
}

function _labels() {
  for (const tab of _tabs) {
    const def = SHEETS.find(s => s.id === tab.dataset.sheetToggle);
    if (!def) continue;
    const label = tr(def.key, def.fallback);
    tab.textContent = label;
    tab.setAttribute('aria-label', label);
  }
}

function _syncLayout() {
  const mode = layoutModeForWidth(window.innerWidth);
  if (document.body.dataset.layout !== mode) document.body.dataset.layout = mode;
  if (mode === 'full' || mode === 'viewer') { if (_open) setSheet(''); }
}

function _syncHeaderHeight() {
  const header = document.getElementById('header');
  if (!header) return;
  const set = () => document.documentElement.style.setProperty('--hdr-h', `${Math.round(header.getBoundingClientRect().height) || 40}px`);
  set();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(header);
}

/** Mount the edge tabs into #viewport and start tracking the layout tier. */
export function init() {
  const host = document.body;
  if (!host) return;
  _tabs = SHEETS.map(def => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sheet-tab sheet-tab-${def.id}`;
    b.dataset.sheetToggle = def.id;
    b.setAttribute('aria-controls', def.panel);
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => setSheet(_open === def.id ? '' : def.id));
    host.appendChild(b);
    return b;
  });
  _labels();
  subscribe(EVENTS.LOCALE_CHANGED, _labels);
  window.addEventListener('resize', _syncLayout);
  window.addEventListener('keydown', (e) => {
    // Esc closes an open sheet unless something more specific owns the key.
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(/** @type {Element} */ (e.target)?.tagName ?? '');
    if (e.key === 'Escape' && _open && !typing && !e.defaultPrevented && !document.querySelector('#modal-root:not(.hidden)')) setSheet('');
  });
  _syncLayout();
  _syncHeaderHeight();
}

export const PanelSheets = { init, setSheet, openSheet };
