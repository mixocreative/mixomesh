// Viewport display controls — a toggle strip across the viewport's top-right,
// reachable from EVERY workspace (overhaul 5.7): Grid / Axes / Build volume /
// Cross-section feature toggles, then a mutually-exclusive SHADING MODE selector (Shaded / Matte /
// Base Color — they all replace how the surface shades, so only one at a time)
// plus independent OVERLAY toggles (Wireframe edges) that layer on any mode.
// Matte = print-preview (no metallic); Base Color = flat albedo (what Mimaki
// inks). Modes are viewport-only and export-safe (mirror print-preview's
// store/restore; export reads source materials).

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { icon } from '../core/Icons.js';
import { escapeAttr, escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';
import { tr } from './lib/tr.js';
import { ScenePanel } from './ScenePanel.js';
import { ScopeBreadcrumb } from './ScopeBreadcrumb.js';
import { SettingsStore } from '../core/SettingsStore.js';

let _root = null;

// Feature toggles (viewport-only chrome; none touch the export). `overlay`
// ones are scene.overlays flags; Cross-section is scene.section.enabled.
const FEATURE_TOGGLES = [
  { id: 'grid',    kind: 'overlay', iconName: 'Grid3x3', key: 'viewport.toggle.grid',    fallback: 'Grid' },
  { id: 'axes',    kind: 'overlay', iconName: 'Move3D',  key: 'viewport.toggle.axes',    fallback: 'Axes' },
  { id: 'bedPreview', kind: 'overlay', iconName: 'Box',  key: 'viewport.toggle.bed',     fallback: 'Build volume' },
  { id: 'section', kind: 'section', iconName: 'Scissors', key: 'viewport.toggle.section', fallback: 'Cross-section' },
  // View-only, per-user (persisted): welded STL renders faceted unless this is on (review I1).
  { id: 'smoothShading', kind: 'overlay', iconName: 'Disc3', key: 'viewport.toggle.smooth', fallback: 'Smooth shading', titleKey: 'viewport.smoothShadingTitle', persist: true },
];
const SECTION_DEFAULTS = { enabled: false, axis: 'z', offsetMM: 0, flip: false };

export function init() {
  _root = document.getElementById('viewport-toggles');
  if (!_root) return;
  _render();
  ScopeBreadcrumb.init();   // viewport top-left chrome, same lifecycle as the toggle strip
  // Overlays arrive restored on load (spec load step 12) and reset on new.
  subscribe(EVENTS.PROJECT_LOADED, _render);
  subscribe(EVENTS.PROJECT_NEW, _render);
  subscribe(EVENTS.LOCALE_CHANGED, _render);
}

function _render() {
  if (!_root) return;
  const overlays = getState().scene.overlays ?? {};
  const wireOn  = overlays.wireframeEdges ?? false;
  const invOn   = overlays.invertedFaces ?? false;
  const sectionOn = getState().scene.section?.enabled ?? false;
  const wireColor = _safeHex(overlays.wireframeEdgeColor ?? '#ffcc00');
  const mode = overlays.uvCheckerView ? 'uv'
    : overlays.baseColorView ? 'base'
    : overlays.printPreview ? 'matte'
    : 'shaded';

  const featureBtns = FEATURE_TOGGLES.map(f => {
    const on = f.kind === 'section' ? sectionOn : !!overlays[f.id];
    const label = tr(f.key, f.fallback);
    const title = f.titleKey ? t(f.titleKey) : label;
    return `<button class="vt-btn vt-feature ${on ? 'vt-on' : ''}" data-feature="${escapeAttr(f.id)}"
            title="${escapeAttr(title)}" aria-pressed="${on ? 'true' : 'false'}">
      ${icon(f.iconName, { width: 14, height: 14 })}<span class="vt-label">${escapeHtml(label)}</span>
    </button>`;
  }).join('');

  _root.innerHTML = `
    <div class="vt-group" data-group="features">${featureBtns}</div>
    <span class="vt-sep" aria-hidden="true"></span>
    <select class="vt-mode" data-mode title="${escapeAttr(t('viewport.displayModeTitle'))}">
      <option value="shaded" ${mode === 'shaded' ? 'selected' : ''}>${t('viewport.mode.shaded')}</option>
      <option value="matte"  ${mode === 'matte'  ? 'selected' : ''}>${t('viewport.mode.matte')}</option>
      <option value="base"   ${mode === 'base'   ? 'selected' : ''}>${t('viewport.mode.baseColor')}</option>
      <option value="uv"     ${mode === 'uv'     ? 'selected' : ''}>${t('viewport.mode.uvChecker')}</option>
    </select>
    <button class="vt-btn ${wireOn ? 'vt-on' : ''}" data-toggle="wireframeEdges"
            title="${escapeAttr(t('viewport.wireframeEdgesTitle'))}"
            aria-pressed="${wireOn ? 'true' : 'false'}">
      ${icon('MeshTriangle', { width: 15, height: 15 })}
    </button>
    <input type="color" class="vp-wire-color ${wireOn ? '' : 'vp-hidden'}"
           value="${escapeAttr(wireColor)}" title="${escapeAttr(t('viewport.wireframeEdgeColorTitle'))}">
    <button class="vt-btn ${invOn ? 'vt-on' : ''}" data-toggle="invertedFaces"
            title="${escapeAttr(t('viewport.invertedFacesTitle'))}"
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
  _root.querySelectorAll('[data-feature]').forEach(btn => {
    btn.addEventListener('click', () => _toggleFeature(btn.dataset.feature));
  });
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

function _toggleFeature(id) {
  const f = FEATURE_TOGGLES.find(x => x.id === id);
  if (!f) return;
  if (f.kind === 'section') {
    const cur = { ...SECTION_DEFAULTS, ...(getState().scene.section ?? {}) };
    const next = { ...cur, enabled: !cur.enabled };
    setState(s => ({ ...s, scene: { ...s.scene, section: next } }), { silent: true });
    SceneManager.setSectionPlane(next);
  } else {
    const enabled = !(getState().scene.overlays?.[id] ?? false);
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, [id]: enabled } },
    }), { silent: true });
    SceneManager.setOverlay(id, enabled);
    if (f.persist) SettingsStore.scheduleSave();
  }
  _render();
  ScenePanel.refresh();   // keep the Scene panel's own toggles in step
}

function _safeHex(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value)) ? value : '#ffcc00';
}

export const ViewportToggles = { init };
