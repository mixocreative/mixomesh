import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { Selection } from '../core/Selection.js';
import { icon } from '../core/Icons.js';

/**
 * Floating Fusion 360-style toolbar anchored bottom-centre of the viewport.
 *
 * Groups:
 *   A. Gizmo mode      — Move / Rotate / Scale
 *   B. Pivot mode      — World / Median / Active / Cursor
 *   ~. Orientation     — Local ↔ World (toggle)
 *   C. Camera mode     — Free / Follow Active / World Origin
 */

let _root = null;

const GIZMO_MODES = [
  { id: 'translate', label: 'Move',   iconName: 'Move3D' },
  { id: 'rotate',    label: 'Rotate', iconName: 'RotateCcw' },
  { id: 'scale',     label: 'Scale',  iconName: 'Maximize' },
];

const PIVOT_MODES = [
  { id: 'active', label: 'Active',       iconName: 'CheckCircle' },
  { id: 'median', label: 'Median',       iconName: 'Box' },
  { id: 'cursor', label: 'Cursor',       iconName: 'Plus' },
  { id: 'world',  label: 'World Origin', iconName: 'Circle' },
];

const FOLLOW_MODES = [
  { id: 'free',         label: 'Free Camera',          iconName: 'Move3D' },
  { id: 'followActive', label: 'Follow Active',        iconName: 'Eye' },
  { id: 'worldOrigin',  label: 'Look At World Origin', iconName: 'Maximize' },
];

export function init() {
  _root = document.getElementById('viewport-toolbar');
  if (!_root) return;
  _render();
  for (const ev of [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ACTIVE_OBJECT_CHANGED,
    EVENTS.CAMERA_PRESET_CHANGED,
    EVENTS.PROJECT_LOADED,
  ]) subscribe(ev, _render);
}

function _render() {
  if (!_root) return;
  const s = getState();
  const gizmoMode  = s.gizmo?.mode               ?? 'translate';
  const gizmoSpace = s.gizmo?.space              ?? 'world';
  const pivot      = s.selection?.pivotMode      ?? 'median';
  const follow     = s.scene?.camera?.followMode ?? 'free';

  _root.innerHTML = `
    <div class="vt-group" data-group="gizmo-mode">
      ${GIZMO_MODES.map(m => _btn(m, m.id === gizmoMode, 'gizmoMode')).join('')}
    </div>
    <div class="vt-sep"></div>
    <div class="vt-group" data-group="pivot">
      ${PIVOT_MODES.map(m => _btn(m, m.id === pivot, 'pivot')).join('')}
    </div>
    <div class="vt-sep"></div>
    <div class="vt-group" data-group="space">
      <button class="vt-btn ${gizmoSpace === 'local' ? 'vt-on' : ''}" data-kind="space" title="Toggle gizmo orientation (World ↔ Local)">
        ${icon('RotateCw', { width: 14, height: 14 })}
        <span class="vt-label">${gizmoSpace === 'local' ? 'Local' : 'World'}</span>
      </button>
    </div>
    <div class="vt-sep"></div>
    <div class="vt-group" data-group="follow">
      ${FOLLOW_MODES.map(m => _btn(m, m.id === follow, 'follow')).join('')}
    </div>
  `;
  _wire();
}

function _btn(mode, active, kind) {
  return `
    <button class="vt-btn ${active ? 'vt-on' : ''}" data-kind="${kind}" data-mode="${mode.id}" title="${mode.label}">
      ${icon(mode.iconName, { width: 14, height: 14 })}
    </button>
  `;
}

function _wire() {
  _root.querySelectorAll('[data-kind]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      const mode = btn.dataset.mode;
      if (kind === 'gizmoMode') SceneManager.setGizmoMode(mode);
      if (kind === 'pivot')     Selection.setPivotMode(mode);
      if (kind === 'follow')    SceneManager.setFollowMode(mode);
      if (kind === 'space') {
        const cur = getState().gizmo?.space ?? 'world';
        SceneManager.setGizmoSpace(cur === 'world' ? 'local' : 'world');
      }
      _render();
    });
  });
}

export const ViewportToolbar = { init };
