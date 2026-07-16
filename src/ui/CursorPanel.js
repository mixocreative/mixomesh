// Blender-style "N panel" — a slide-open sidebar docked to the viewport's
// right edge, holding a 3D Cursor tab. Toggled by Shift+N (plain N is taken by
// the docked right-panel toggle). Lets you read/type the cursor location in mm
// plus show/pivot cursor toggles. Opening the panel shows the cursor for feedback.

import { SceneManager } from '../core/SceneManager.js';
import { Selection } from '../core/Selection.js';
import { InputManager } from '../core/InputManager.js';
import { subscribe, getState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { icon } from '../core/Icons.js';
import { MM_PER_BU } from '../core/scene/SceneConstants.js';
import { applyTranslations } from '../i18n/index.js';
import { escEnter } from './lib/fields.js';

let _root = null;
let _open = false;
let _inputs = {};   // { x, y, z } <input>

export function init() {
  const host = document.getElementById('viewport');
  if (!host) return;

  _root = document.createElement('aside');
  _root.id = 'n-panel';
  _root.className = 'n-panel';
  _root.dataset.i18nAriaLabel = 'cursor.panelTitle';
  _root.innerHTML = _markup();
  host.appendChild(_root);

  _inputs = {
    x: _root.querySelector('[data-axis="x"]'),
    y: _root.querySelector('[data-axis="y"]'),
    z: _root.querySelector('[data-axis="z"]'),
  };

  // Tab pull-handle toggles too (clickable edge tab).
  _root.querySelector('.np-tab')?.addEventListener('click', toggle);

  for (const axis of ['x', 'y', 'z']) {
    _inputs[axis].addEventListener('change', () => _commitFromInputs());
    escEnter(_inputs[axis]);   // Enter blurs → change commits; no Escape revert
  }

  _root.querySelector('[data-act="show-cursor"]')?.addEventListener('change', _toggleShowCursor);
  _root.querySelector('[data-act="pivot-cursor"]')?.addEventListener('change', _togglePivotCursor);

  InputManager.register('Shift+N', 'global', toggle);
  subscribe(EVENTS.CURSOR_CHANGED, () => { _refreshInputs(); _syncButtons(); });
  subscribe(EVENTS.PIVOT_MODE_CHANGED, _syncButtons);   // stay in sync with the toolbar's pivot group
  subscribe(EVENTS.LOCALE_CHANGED, () => _retranslate(_root));

  _retranslate(_root);
  _refreshInputs();
  _syncButtons();
}

function _markup() {
  return `
    <button class="np-tab" data-i18n-title="cursor.panelTitleWithShortcut" data-i18n-aria-label="cursor.panelTitle">${icon('Crosshair', { width: 15, height: 15 })}</button>
    <div class="np-body">
      <header class="np-header">${icon('Crosshair', { width: 13, height: 13 })}<span data-i18n-key="cursor.panelTitle">3D Cursor</span></header>
      <div class="np-section">
        <div class="np-row-label" data-i18n-key="cursor.locationMm">Location (mm)</div>
        ${['x', 'y', 'z'].map(a => `
          <label class="np-field">
            <span class="np-axis np-axis-${a}">${a.toUpperCase()}</span>
            <input type="number" step="1" data-axis="${a}" />
          </label>`).join('')}
      </div>
      <div class="np-section">
        <label class="np-check"><input type="checkbox" data-act="show-cursor"> <span data-i18n-key="cursor.show">Show 3D cursor</span></label>
        <label class="np-check"><input type="checkbox" data-act="pivot-cursor"> <span data-i18n-key="cursor.useAsPivot">Use cursor as pivot</span></label>
      </div>
    </div>
  `;
}

function _retranslate(root) {
  applyTranslations(root);
}

export function toggle() {
  _open = !_open;
  _root.classList.toggle('open', _open);
  if (_open) {
    SceneManager.setCursorVisible(true);
    _refreshInputs();
  } else {
    // Restore: cursor only stays visible if it's the active pivot.
    SceneManager.setCursorVisible(getState().selection.pivotMode === 'cursor');
  }
  _syncButtons();
}

function _toggleShowCursor(e) {
  SceneManager.setCursorVisible(!!e.target.checked);
  _syncButtons();
}

function _commitFromInputs() {
  const BABYLON = window.BABYLON;
  const mm = (el) => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : 0; };
  const v = new BABYLON.Vector3(
    mm(_inputs.x) / MM_PER_BU,
    mm(_inputs.y) / MM_PER_BU,
    mm(_inputs.z) / MM_PER_BU,
  );
  SceneManager.setCursor(v);
}

function _refreshInputs() {
  if (!_inputs.x) return;
  const c = SceneManager.getCursor();
  // Don't stomp a field the user is mid-edit in.
  const active = document.activeElement;
  if (active !== _inputs.x) _inputs.x.value = (c.x * MM_PER_BU).toFixed(1);
  if (active !== _inputs.y) _inputs.y.value = (c.y * MM_PER_BU).toFixed(1);
  if (active !== _inputs.z) _inputs.z.value = (c.z * MM_PER_BU).toFixed(1);
}

function _togglePivotCursor(e) {
  Selection.setPivotMode(e.target.checked ? 'cursor' : 'median');
  _syncButtons();
}

function _syncButtons() {
  const pivotCb = _root?.querySelector('[data-act="pivot-cursor"]');
  if (pivotCb) pivotCb.checked = getState().selection.pivotMode === 'cursor';
  const showCb = _root?.querySelector('[data-act="show-cursor"]');
  if (showCb) showCb.checked = SceneManager.isCursorVisible();
}

export const CursorPanel = { init, toggle };
