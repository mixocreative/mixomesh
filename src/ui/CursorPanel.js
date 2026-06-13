// Blender-style "N panel" — a slide-open sidebar docked to the viewport's
// right edge, holding a 3D Cursor tab. Toggled by Shift+N (plain N is taken by
// the docked right-panel toggle). Lets you read/type the cursor location in mm
// and run the snap ops. Opening the panel shows the cursor for feedback.

import { SceneManager } from '../core/SceneManager.js';
import { CursorTools } from '../core/CursorTools.js';
import { Selection } from '../core/Selection.js';
import { InputManager } from '../core/InputManager.js';
import { subscribe, getState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { icon } from '../core/Icons.js';
import { MM_PER_BU } from '../core/scene/SceneConstants.js';

let _root = null;
let _open = false;
let _inputs = {};   // { x, y, z } <input>

export function init() {
  const host = document.getElementById('viewport');
  if (!host) return;

  _root = document.createElement('aside');
  _root.id = 'n-panel';
  _root.className = 'n-panel';
  _root.setAttribute('aria-label', '3D Cursor');
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
    _inputs[axis].addEventListener('keydown', (e) => { if (e.key === 'Enter') _commitFromInputs(); });
  }

  _root.querySelector('[data-act="sel-to-cursor"]')?.addEventListener('click', () => CursorTools.selectionToCursor());
  _root.querySelector('[data-act="cursor-to-sel"]')?.addEventListener('click', () => CursorTools.cursorToSelection());
  _root.querySelector('[data-act="cursor-to-origin"]')?.addEventListener('click', () => CursorTools.cursorToWorldOrigin());
  _root.querySelector('[data-act="show-cursor"]')?.addEventListener('click', _toggleShowCursor);
  _root.querySelector('[data-act="pivot-cursor"]')?.addEventListener('click', _togglePivotCursor);

  InputManager.register('Shift+N', 'global', toggle);
  subscribe(EVENTS.CURSOR_CHANGED, () => { _refreshInputs(); _syncButtons(); });
  subscribe(EVENTS.SELECTION_CHANGED, _syncButtons);
  subscribe(EVENTS.PIVOT_MODE_CHANGED, _syncButtons);   // stay in sync with the toolbar's pivot group

  _refreshInputs();
  _syncButtons();
}

function _markup() {
  return `
    <button class="np-tab" title="3D Cursor (Shift+N)">${icon('Crosshair', { width: 15, height: 15 })}</button>
    <div class="np-body">
      <header class="np-header">${icon('Crosshair', { width: 13, height: 13 })}<span>3D Cursor</span></header>
      <div class="np-section">
        <div class="np-row-label">Location (mm)</div>
        ${['x', 'y', 'z'].map(a => `
          <label class="np-field">
            <span class="np-axis np-axis-${a}">${a.toUpperCase()}</span>
            <input type="number" step="1" data-axis="${a}" />
          </label>`).join('')}
      </div>
      <div class="np-section np-actions">
        <button class="np-btn" data-act="sel-to-cursor">Selection → Cursor</button>
        <button class="np-btn" data-act="cursor-to-sel">Cursor → Selection</button>
        <button class="np-btn" data-act="cursor-to-origin">Cursor → World Origin</button>
      </div>
      <div class="np-section">
        <button class="np-btn np-toggle" data-act="show-cursor">Show 3D Cursor</button>
        <button class="np-btn np-toggle" data-act="pivot-cursor">Use Cursor as Pivot</button>
      </div>
    </div>
  `;
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

function _toggleShowCursor() {
  SceneManager.setCursorVisible(!SceneManager.isCursorVisible());
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

function _togglePivotCursor() {
  const isCursor = getState().selection.pivotMode === 'cursor';
  Selection.setPivotMode(isCursor ? 'median' : 'cursor');
  _syncButtons();
}

function _syncButtons() {
  const pivotBtn = _root?.querySelector('[data-act="pivot-cursor"]');
  if (pivotBtn) {
    const on = getState().selection.pivotMode === 'cursor';
    pivotBtn.classList.toggle('np-on', on);
    pivotBtn.textContent = on ? 'Cursor Pivot: On' : 'Use Cursor as Pivot';
  }
  const showBtn = _root?.querySelector('[data-act="show-cursor"]');
  if (showBtn) {
    const vis = SceneManager.isCursorVisible();
    showBtn.classList.toggle('np-on', vis);
    showBtn.textContent = vis ? 'Hide 3D Cursor' : 'Show 3D Cursor';
  }
}

export const CursorPanel = { init, toggle };
