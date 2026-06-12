// Viewport display toggles — docked under the NavCube (user request
// 2026-06-12): Wireframe Edges and Matte/flat (print preview, removes
// metallic), plus the edge-colour swatch shown while wireframe is on.
// These replaced the Print Panel's Preview tab so display modes are
// reachable from EVERY workspace, not just Print.

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { icon } from '../core/Icons.js';
import { escapeAttr } from './renderSafe.js';

let _root = null;

export function init() {
  _root = document.getElementById('viewport-toggles');
  if (!_root) return;
  _render();
  // Overlays arrive restored on load (spec load step 12) and reset on new.
  subscribe(EVENTS.PROJECT_LOADED, _render);
  subscribe(EVENTS.PROJECT_NEW, _render);
}

function _render() {
  if (!_root) return;
  const overlays = getState().scene.overlays ?? {};
  const wireOn  = overlays.wireframeEdges ?? false;
  const matteOn = overlays.printPreview ?? false;
  const wireColor = _safeHex(overlays.wireframeEdgeColor ?? '#ffcc00');

  _root.innerHTML = `
    <button class="vt-btn ${wireOn ? 'vt-on' : ''}" data-toggle="wireframeEdges"
            title="Wireframe edges — show edge outlines on models"
            aria-pressed="${wireOn ? 'true' : 'false'}">
      ${icon('Grid3x3', { width: 14, height: 14 })}
    </button>
    <input type="color" class="vp-wire-color ${wireOn ? '' : 'vp-hidden'}"
           value="${escapeAttr(wireColor)}" title="Wireframe edge color">
    <button class="vt-btn ${matteOn ? 'vt-on' : ''}" data-toggle="printPreview"
            title="Matte/flat preview — removes metallic for print-like shading"
            aria-pressed="${matteOn ? 'true' : 'false'}">
      ${icon('SunDim', { width: 14, height: 14 })}
    </button>
  `;
  _wire();
}

function _wire() {
  _root.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.toggle;
      const enabled = !(getState().scene.overlays?.[name] ?? false);
      setState(s => ({
        ...s,
        scene: { ...s.scene, overlays: { ...s.scene.overlays, [name]: enabled } },
      }), { silent: true });
      SceneManager.setOverlay(name, enabled);
      _render();
    });
  });
  _root.querySelector('.vp-wire-color')?.addEventListener('input', (e) => {
    const color = e.target.value;
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, wireframeEdgeColor: color } },
    }), { silent: true });
    SceneManager.setWireframeEdgeColor(color);
  });
}

function _safeHex(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value)) ? value : '#ffcc00';
}

export const ViewportToggles = { init };
