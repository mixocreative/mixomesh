// Scene panel (#rp-scene) — scene-wide settings, moved OUT of the Properties
// panel so they're reachable while an object is selected (the old Scene
// section only rendered when nothing was active). Two sections:
//   Scene  — grid styling (cell mm / subdivisions) + grid/axes visibility
//   Render — viewport look: exposure, contrast, shadows (state.scene.render,
//            applied via SceneManager.applyRenderSettings, persisted in .mixo)
// Hidden in the Print workspace via body[data-workspace] CSS (layout.css).

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import {
  TONE_EXPOSURE, TONE_CONTRAST, SHADOW_DARKNESS,
} from '../core/scene/SceneConstants.js';

const SILENT = { silent: true };

const RENDER_DEFAULTS = {
  exposure: TONE_EXPOSURE,
  contrast: TONE_CONTRAST,
  shadowsEnabled: true,
  shadowDarkness: SHADOW_DARKNESS,
};

let _bodyEl = null;

export function init() {
  _bodyEl = document.getElementById('rp-scene-body');
  if (!_bodyEl) return;
  _bodyEl.classList.add('pp-body');
  subscribe(EVENTS.PROJECT_LOADED, _render);
  subscribe(EVENTS.PROJECT_NEW, _render);
  _render();
}

function _render() {
  if (!_bodyEl) return;
  const s = getState();
  const grid = s.scene.grid ?? { cellMM: 10, subdivisions: 10 };
  const overlays = s.scene.overlays ?? {};
  const render = { ...RENDER_DEFAULTS, ...(s.scene.render ?? {}) };
  const bed = s.print.bedDimensions;

  _bodyEl.innerHTML = `
    <section class="pp-section">
      <header class="pp-section-header">Grid</header>
      <div class="pp-row">
        <label>Grid cell (mm)</label>
        <input type="number" step="1" min="0.1" data-grid="cellMM" value="${_fmt(grid.cellMM)}">
      </div>
      <div class="pp-row">
        <label>Subdivisions</label>
        <input type="number" step="1" min="1" data-grid="subdivisions" value="${_fmt(grid.subdivisions, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-overlay="grid" ${overlays.grid ? 'checked' : ''}> Grid</label>
        <label><input type="checkbox" data-overlay="axes" ${overlays.axes ? 'checked' : ''}> Axes</label>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Bed ${_fmt(bed.x)} × ${_fmt(bed.y)} mm — set in Print ▸ Bed.</span>
      </div>
    </section>
    <section class="pp-section">
      <header class="pp-section-header">Render</header>
      <div class="pp-row">
        <label>Exposure</label>
        <input type="number" step="0.05" min="0.1" max="4" data-render="exposure" value="${_fmt(render.exposure)}">
      </div>
      <div class="pp-row">
        <label>Contrast</label>
        <input type="number" step="0.05" min="0.1" max="4" data-render="contrast" value="${_fmt(render.contrast)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-render-toggle="shadowsEnabled" ${render.shadowsEnabled ? 'checked' : ''}> Shadows</label>
      </div>
      <div class="pp-row">
        <label>Shadow dark</label>
        <input type="number" step="0.05" min="0" max="1" data-render="shadowDarkness" value="${_fmt(render.shadowDarkness)}">
      </div>
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="render-reset">Reset render defaults</button>
      </div>
    </section>
  `;
  _wire();
}

function _wire() {
  // Grid styling → SceneManager.setGrid (writes state.scene.grid itself).
  _bodyEl.querySelectorAll('[data-grid]').forEach(input => {
    input.addEventListener('change', () => {
      const grid = getState().scene.grid ?? {};
      const cellEl = _bodyEl.querySelector('[data-grid="cellMM"]');
      const subEl  = _bodyEl.querySelector('[data-grid="subdivisions"]');
      const cellMM = parseFloat(cellEl.value);
      const subdivisions = parseInt(subEl.value, 10);
      if (!Number.isFinite(cellMM) || cellMM <= 0 ||
          !Number.isFinite(subdivisions) || subdivisions < 1) { _render(); return; }
      if (cellMM === grid.cellMM && subdivisions === grid.subdivisions) return;
      SceneManager.setGrid({ cellMM, subdivisions });
    });
    _escEnter(input);
  });

  // Grid/axes visibility — same overlay contract the viewport toggles use.
  _bodyEl.querySelectorAll('[data-overlay]').forEach(box => {
    box.addEventListener('change', () => {
      const name = box.dataset.overlay;
      const enabled = box.checked;
      setState(s => ({
        ...s,
        scene: { ...s.scene, overlays: { ...s.scene.overlays, [name]: enabled } },
      }), SILENT);
      SceneManager.setOverlay(name, enabled);
    });
  });

  // Render numbers.
  _bodyEl.querySelectorAll('[data-render]').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.render;
      const value = parseFloat(input.value);
      if (!Number.isFinite(value)) { _render(); return; }
      _setRender({ [key]: value });
    });
    _escEnter(input);
  });

  // Shadows toggle.
  _bodyEl.querySelector('[data-render-toggle="shadowsEnabled"]')?.addEventListener('change', (e) => {
    _setRender({ shadowsEnabled: e.target.checked });
  });

  _bodyEl.querySelector('[data-action="render-reset"]')?.addEventListener('click', () => {
    _setRender({ ...RENDER_DEFAULTS });
    _render();
  });
}

function _setRender(patch) {
  setState(s => ({
    ...s,
    scene: { ...s.scene, render: { ...RENDER_DEFAULTS, ...s.scene.render, ...patch } },
  }), SILENT);
  SceneManager.applyRenderSettings(getState().scene.render);
}

function _escEnter(input) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { _render(); }
  });
}

function _fmt(v, dp = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(parseFloat(n.toFixed(dp)));
}

export const ScenePanel = { init };
