// Viewport display controls — docked under the NavCube, reachable from EVERY
// workspace. A mutually-exclusive SHADING MODE selector (Shaded / Matte /
// Base Color — they all replace how the surface shades, so only one at a time)
// plus independent OVERLAY toggles (Wireframe edges) that layer on any mode.
// Matte = print-preview (no metallic); Base Color = flat albedo (what Mimaki
// inks). Modes are viewport-only and export-safe (mirror print-preview's
// store/restore; export reads source materials).

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
  const invOn   = overlays.invertedFaces ?? false;
  const wireColor = _safeHex(overlays.wireframeEdgeColor ?? '#ffcc00');
  const mode = overlays.uvCheckerView ? 'uv'
    : overlays.baseColorView ? 'base'
    : overlays.printPreview ? 'matte'
    : 'shaded';

  _root.innerHTML = `
    <select class="vt-mode" data-mode title="Display mode (shading)">
      <option value="shaded" ${mode === 'shaded' ? 'selected' : ''}>Shaded</option>
      <option value="matte"  ${mode === 'matte'  ? 'selected' : ''}>Matte</option>
      <option value="base"   ${mode === 'base'   ? 'selected' : ''}>Base Color</option>
      <option value="uv"     ${mode === 'uv'     ? 'selected' : ''}>UV Checker</option>
    </select>
    <button class="vt-btn ${wireOn ? 'vt-on' : ''}" data-toggle="wireframeEdges"
            title="Wireframe edges — show edge outlines on models"
            aria-pressed="${wireOn ? 'true' : 'false'}">
      ${icon('MeshTriangle', { width: 15, height: 15 })}
    </button>
    <input type="color" class="vp-wire-color ${wireOn ? '' : 'vp-hidden'}"
           value="${escapeAttr(wireColor)}" title="Wireframe edge color">
    <button class="vt-btn ${invOn ? 'vt-on' : ''}" data-toggle="invertedFaces"
            title="Inverted / back-face check — red where back faces show (holes or flipped faces)"
            aria-pressed="${invOn ? 'true' : 'false'}">
      ${icon('AlertTriangle', { width: 15, height: 15 })}
    </button>
  `;
  _wire();
}

// Set the exclusive shading mode: matte = printPreview, base = baseColorView,
// shaded = neither. Always drive BOTH overlays so switching modes turns the
// other off.
function _setMode(mode) {
  const matte = mode === 'matte';
  const base  = mode === 'base';
  const uv    = mode === 'uv';
  setState(s => ({
    ...s,
    scene: { ...s.scene, overlays: { ...s.scene.overlays, printPreview: matte, baseColorView: base, uvCheckerView: uv } },
  }), { silent: true });
  SceneManager.setOverlay('printPreview', matte);
  SceneManager.setOverlay('baseColorView', base);
  SceneManager.setOverlay('uvCheckerView', uv);
}

function _wire() {
  _root.querySelector('.vt-mode')?.addEventListener('change', (e) => _setMode(e.target.value));
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
