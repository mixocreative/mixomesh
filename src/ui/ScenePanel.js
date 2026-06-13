// Scene panel (#rp-scene) — scene-wide settings, moved OUT of the Properties
// panel so they're reachable while an object is selected (the old Scene
// section only rendered when nothing was active). Sections (each collapsible,
// per-user localStorage — Environment + Camera start collapsed so Rendering,
// the workspace's output workflow, is visible without scrolling):
//   Grid        — grid styling (cell mm / subdivisions) + grid/axes visibility
//   Environment — background, grade (exposure/contrast/tone map/saturation/
//                 vignette), shadow-catcher floor, studio lights
//                 (state.scene.render → SceneManager.applyRenderSettings,
//                 persisted in .mixo). Dependent rows (vignette amount,
//                 floor colour/height, shadow darkness) only render while
//                 their toggle is ON.
//   Camera      — optics (FOV / near clip)
//   Rendering   — output production (state.scene.renderOut): Still (PNG,
//                 optionally transparent, render-view compose toggle with
//                 frame overlay) and Turntable (preview + video) via
//                 core/RenderOutput.js
// Hidden outside the Scene workspace via body[data-workspace] CSS (layout.css).

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { register as registerShortcut } from '../core/InputManager.js';
import { sectionIcon } from '../core/Icons.js';
import {
  capturePng, recordTurntable, isRecording,
  previewTurntable, stopPreview, isPreviewing,
} from '../core/RenderOutput.js';
import { renderPngName, turntableVideoName, clampDimension } from '../core/render/RenderMath.js';
import { RenderFrame } from './RenderFrame.js';
import { Toast } from './Toast.js';
import { triggerDownload } from '../core/print/Download.js';
import {
  TONE_EXPOSURE, TONE_CONTRAST, SHADOW_DARKNESS,
  KEY_INTENSITY, FILL_INTENSITY, HEMI_INTENSITY,
} from '../core/scene/SceneConstants.js';

const SILENT = { silent: true };

const RENDER_DEFAULTS = {
  exposure: TONE_EXPOSURE,
  contrast: TONE_CONTRAST,
  shadowsEnabled: true,
  shadowDarkness: SHADOW_DARKNESS,
  background: 'light',
  keyIntensity: KEY_INTENSITY,
  fillIntensity: FILL_INTENSITY,
  hemiIntensity: HEMI_INTENSITY,
  fovDeg: 45.8,       // Babylon ArcRotateCamera default fov 0.8 rad
  clipNearMM: 1,      // CameraRig boots with minZ 0.001 BU = 1 mm
  toneMapping: 'aces',
  saturation: 0,
  vignette: false,
  vignetteWeight: 1.5,
  floorEnabled: false,
  floorColor: '#9a9a9a',
  floorZMM: 0,
  hdriEnabled: true,
  hdriPreset: 'studio',
  hdriIntensity: 0.6,
  ssaoEnabled: false,
  ssaoStrength: 1,
  textureCapPx: 0,
};

// Viewport texture-cap options (assets/TextureCap.js). 0 = full res.
const TEXCAP_PRESETS = [
  { px: 0,    label: 'Off (full res)' },
  { px: 4096, label: '4096 px' },
  { px: 2048, label: '2048 px' },
  { px: 1024, label: '1024 px' },
];

// Session-only inspection tool — never persisted (StateManager comment).
const SECTION_DEFAULTS = { enabled: false, axis: 'z', offsetMM: 0, flip: false };

const HDRI_PRESETS = [
  { id: 'studio',  label: 'Studio' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'outdoor', label: 'Outdoor' },
];

const RENDEROUT_DEFAULTS = {
  width: 1920, height: 1080, transparent: false, pose: null,
  turntable: { durationS: 8, fps: 30, direction: 'left', ease: true },
};

const RESOLUTION_PRESETS = [
  { label: '1080p — 1920 × 1080', w: 1920, h: 1080 },
  { label: '4K — 3840 × 2160',    w: 3840, h: 2160 },
  { label: 'Square — 2048 × 2048', w: 2048, h: 2048 },
  { label: 'Portrait — 1080 × 1920', w: 1080, h: 1920 },
];

// Per-user section collapse (localStorage, NEVER in .mixo — same per-user
// rule as workspaces). Environment + Camera start collapsed so the Rendering
// section is reachable without scrolling (UX audit P1).
const COLLAPSE_KEY = 'mixomesh.scenePanel.collapsed.v1';
const COLLAPSE_DEFAULTS = { grid: false, environment: true, camera: true, section: true, rendering: false };

function _loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? 'null');
    return { ...COLLAPSE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...COLLAPSE_DEFAULTS };
  }
}

function _saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(_collapsed)); } catch { /* private mode */ }
}

let _collapsed = _loadCollapsed();
let _bodyEl = null;
// Render-view compose mode — session-only. navPose = where the user's free
// navigation was when the toggle went on, restored on toggle off. While
// active, every camera move auto-stores the render pose (debounced via the
// camera's view-matrix observable) — there is no "Set view" button; the
// composition you leave is the composition you come back to.
const _rv = { active: false, navPose: null, camObs: null, camTimer: null };

export function init() {
  _bodyEl = document.getElementById('rp-scene-body');
  if (!_bodyEl) return;
  _bodyEl.classList.add('pp-body');
  subscribe(EVENTS.PROJECT_LOADED, () => { _exitRenderView(); _applySection(); _render(); });
  subscribe(EVENTS.PROJECT_NEW,    () => { _exitRenderView(); _applySection(); _render(); });
  // HDRI .env files stream in (~0.2–1 MB) — lighting pops without feedback
  // (UX audit U4). Only toast for USER-initiated changes; boot/load stay
  // silent.
  subscribe(EVENTS.HDRI_STATUS, ({ status, preset }) => {
    if (status === 'error') {
      Toast.show(`HDRI "${preset}" failed to load`, 'error', 4000);
    } else if (_hdriToastWanted) {
      Toast.show(`HDRI "${preset}" ready`, 'success', 2000);
    }
    _hdriToastWanted = false;
  });
  // Blender's F12 belongs to DevTools in a browser — Ctrl+Alt+E is the
  // export-still hotkey instead (UX audit U3).
  registerShortcut('Ctrl+Alt+E', 'global', () => { if (!_busy) _exportPng(); });
  _render();
}

let _hdriToastWanted = false;
let _busy = false;   // a capture/preview is running — gate buttons + hotkey

function _watchRenderPose() {
  const cam = SceneManager.getCamera?.();
  if (!cam?.onViewMatrixChangedObservable) return;
  _rv.camObs = cam.onViewMatrixChangedObservable.add(() => {
    clearTimeout(_rv.camTimer);
    _rv.camTimer = setTimeout(() => {
      if (_rv.active) _setRenderOut({ pose: SceneManager.saveCameraState() });
    }, 250);
  });
}

function _unwatchRenderPose() {
  clearTimeout(_rv.camTimer);
  _rv.camTimer = null;
  if (_rv.camObs) {
    SceneManager.getCamera?.()?.onViewMatrixChangedObservable?.remove(_rv.camObs);
    _rv.camObs = null;
  }
}

// Drop out of compose mode without touching the camera — on project switch
// the loaded/new camera state wins, the stale navPose must not clobber it
// (and the stale pose must not be written into the incoming project).
function _exitRenderView() {
  _unwatchRenderPose();
  _rv.active = false;
  _rv.navPose = null;
  RenderFrame.hide();
}

const SECTION_ICONS = {
  grid: 'Grid3x3', environment: 'Sun', camera: 'Camera',
  section: 'Scissors', rendering: 'Clapperboard',
};

function _section(key, title, inner) {
  return `
    <section class="pp-section ${_collapsed[key] ? 'pp-collapsed' : ''}" data-sec="${key}">
      <header class="pp-section-header">${sectionIcon(SECTION_ICONS[key] ?? '')}${title}</header>
      ${inner}
    </section>`;
}

// Sub-group label with a leading icon (Scene panel only). Mirrors the
// .pp-subhead markup so styling is unchanged; the icon sits inline.
function _subhead(label, iconName) {
  return `<div class="pp-subhead">${sectionIcon(iconName)}${label}</div>`;
}

// Toggle BUTTON for boolean feature/mode switches. Checkbox→toggle audit
// (2026-06-13): on/off FEATURES read better as a pressed button than a tick —
// checkboxes are kept only for sub-options nested under an already-enabled
// feature (Transparent PNG, Ease, Flip side). aria-pressed drives a11y, the
// styled dot, and the wiring's current-state read. `dataAttr` reuses the
// existing change-handler hooks (data-render-toggle / data-overlay /
// data-sect-toggle / data-action) so only the event type differs.
function _toggle(dataAttr, key, label, on) {
  return `<button type="button" class="pp-toggle${on ? ' pp-toggle-on' : ''}" `
    + `${dataAttr}="${key}" aria-pressed="${on ? 'true' : 'false'}">`
    + `<span class="pp-toggle-dot" aria-hidden="true"></span>${label}</button>`;
}
// New value to APPLY when an element fires: a button toggles its aria-pressed,
// a checkbox reports its post-change `checked`.
const _nextVal = (el) => el.tagName === 'BUTTON' ? el.getAttribute('aria-pressed') !== 'true' : el.checked;
const _evt     = (el) => el.tagName === 'BUTTON' ? 'click' : 'change';
function _reflectToggle(el, on) {
  if (el.tagName !== 'BUTTON') return;
  el.classList.toggle('pp-toggle-on', on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function _render() {
  if (!_bodyEl) return;
  const s = getState();
  const grid = s.scene.grid ?? { cellMM: 10, subdivisions: 10 };
  const overlays = s.scene.overlays ?? {};
  const render = { ...RENDER_DEFAULTS, ...(s.scene.render ?? {}) };
  const ro = _ro();
  const tt = ro.turntable;
  const bed = s.print.bedDimensions;
  const presetIdx = RESOLUTION_PRESETS.findIndex(p => p.w === ro.width && p.h === ro.height);

  const gridSec = `
      <div class="pp-row">
        <label>Grid cell (mm)</label>
        <input type="number" step="1" min="0.1" data-grid="cellMM" value="${_fmt(grid.cellMM)}">
      </div>
      <div class="pp-row">
        <label>Subdivisions</label>
        <input type="number" step="1" min="1" data-grid="subdivisions" value="${_fmt(grid.subdivisions, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        ${_toggle('data-overlay', 'grid', 'Grid', overlays.grid)}
        ${_toggle('data-overlay', 'axes', 'Axes', overlays.axes)}
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Bed ${_fmt(bed.x)} × ${_fmt(bed.y)} mm — set in Print ▸ Bed.</span>
      </div>`;

  // Dependent rows render only while their toggle is ON (UX audit P1 —
  // dead-looking controls). The toggles re-render the panel on change.
  const envSec = `
      <div class="pp-row">
        <label>Background</label>
        <select data-render-select="background">
          <option value="light" ${render.background !== 'dark' ? 'selected' : ''}>Light</option>
          <option value="dark" ${render.background === 'dark' ? 'selected' : ''}>Dark</option>
        </select>
      </div>
      ${_subhead('HDRI lighting', 'Globe')}
      <div class="pp-row pp-row-inline">
        ${_toggle('data-render-toggle', 'hdriEnabled', 'HDRI', render.hdriEnabled)}
      </div>
      ${render.hdriEnabled ? `
      <div class="pp-row">
        <label>Preset</label>
        <select data-render-select="hdriPreset">
          ${HDRI_PRESETS.map(p =>
            `<option value="${p.id}" ${render.hdriPreset === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="pp-row">
        <label>Intensity</label>
        <input type="number" step="0.1" min="0" max="4" data-render="hdriIntensity" value="${_fmt(render.hdriIntensity, 1)}">
      </div>` : ''}
      ${_subhead('Grade', 'Wand2')}
      <div class="pp-row">
        <label>Exposure</label>
        <input type="number" step="0.05" min="0.1" max="4" data-render="exposure" value="${_fmt(render.exposure)}">
      </div>
      <div class="pp-row">
        <label>Contrast</label>
        <input type="number" step="0.05" min="0.1" max="4" data-render="contrast" value="${_fmt(render.contrast)}">
      </div>
      <div class="pp-row">
        <label>Tone map</label>
        <select data-render-select="toneMapping">
          <option value="aces" ${render.toneMapping === 'aces' ? 'selected' : ''}>ACES (filmic)</option>
          <option value="neutral" ${render.toneMapping === 'neutral' ? 'selected' : ''}>Neutral (KHR)</option>
          <option value="standard" ${render.toneMapping === 'standard' ? 'selected' : ''}>Standard</option>
          <option value="off" ${render.toneMapping === 'off' ? 'selected' : ''}>Off (linear)</option>
        </select>
      </div>
      <div class="pp-row">
        <label>Saturation</label>
        <input type="number" step="5" min="-100" max="100" data-render="saturation" value="${_fmt(render.saturation, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        ${_toggle('data-render-toggle', 'vignette', 'Vignette', render.vignette)}
      </div>
      ${render.vignette ? `
      <div class="pp-row">
        <label>Vignette amt</label>
        <input type="number" step="0.25" min="0" max="10" data-render="vignetteWeight" value="${_fmt(render.vignetteWeight)}">
      </div>` : ''}
      ${_subhead('Floor', 'FloorPlane')}
      <div class="pp-row pp-row-inline">
        ${_toggle('data-render-toggle', 'floorEnabled', 'Floor', render.floorEnabled)}
        ${render.floorEnabled ? `<input type="color" data-render-color="floorColor" value="${render.floorColor}" title="Floor colour">` : ''}
      </div>
      ${render.floorEnabled ? `
      <div class="pp-row">
        <label>Floor Z (mm)</label>
        <input type="number" step="1" data-render="floorZMM" value="${_fmt(render.floorZMM, 1)}">
      </div>` : ''}
      ${render.floorEnabled && !render.shadowsEnabled ? `
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Shadows are off — the floor won't catch any.</span>
      </div>` : ''}
      ${_subhead('Lights', 'Lightbulb')}
      <div class="pp-row pp-row-inline">
        ${_toggle('data-render-toggle', 'shadowsEnabled', 'Shadows', render.shadowsEnabled)}
      </div>
      ${render.shadowsEnabled ? `
      <div class="pp-row">
        <label>Shadow dark</label>
        <input type="number" step="0.05" min="0" max="1" data-render="shadowDarkness" value="${_fmt(render.shadowDarkness)}">
      </div>` : ''}
      <div class="pp-row">
        <label>Key light</label>
        <input type="number" step="0.05" min="0" max="3" data-render="keyIntensity" value="${_fmt(render.keyIntensity)}">
      </div>
      <div class="pp-row">
        <label>Fill light</label>
        <input type="number" step="0.05" min="0" max="3" data-render="fillIntensity" value="${_fmt(render.fillIntensity)}">
      </div>
      <div class="pp-row">
        <label>Ambient</label>
        <input type="number" step="0.05" min="0" max="3" data-render="hemiIntensity" value="${_fmt(render.hemiIntensity)}">
      </div>
      ${_subhead('Ambient occlusion', 'Aperture')}
      <div class="pp-row pp-row-inline">
        ${_toggle('data-render-toggle', 'ssaoEnabled', 'SSAO contact shadows', render.ssaoEnabled)}
      </div>
      ${render.ssaoEnabled ? `
      <div class="pp-row">
        <label>AO strength</label>
        <input type="number" step="0.1" min="0" max="2" data-render="ssaoStrength" value="${_fmt(render.ssaoStrength, 1)}">
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Viewport shading only — not in PNG/video exports.</span>
      </div>` : ''}
      ${_subhead('Performance', 'Gauge')}
      <div class="pp-row">
        <label>Texture cap</label>
        <select data-texcap>
          ${TEXCAP_PRESETS.map(p =>
            `<option value="${p.px}" ${(render.textureCapPx || 0) === p.px ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Caps GPU texture size to save VRAM on heavy scenes. Exports stay full-res.</span>
      </div>
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="render-reset">Reset environment</button>
      </div>`;

  const camSec = `
      <div class="pp-row">
        <label>FOV (deg)</label>
        <input type="number" step="1" min="5" max="140" data-render="fovDeg" value="${_fmt(render.fovDeg, 1)}">
      </div>
      <div class="pp-row">
        <label>Near clip (mm)</label>
        <input type="number" step="0.5" min="0.1" max="100" data-render="clipNearMM" value="${_fmt(render.clipNearMM, 1)}">
      </div>`;

  // Cross-section inspection plane (session-only). Cuts CONTENT only — the
  // grid/floor/axes stay; offset is print-space mm along the chosen axis.
  const section = { ...SECTION_DEFAULTS, ...(s.scene.section ?? {}) };
  const sectionSec = `
      <div class="pp-row pp-row-inline">
        ${_toggle('data-sect-toggle', 'enabled', 'Cut view', section.enabled)}
      </div>
      ${section.enabled ? `
      <div class="pp-row">
        <label>Axis</label>
        <select data-sect-select="axis">
          <option value="x" ${section.axis === 'x' ? 'selected' : ''}>X</option>
          <option value="y" ${section.axis === 'y' ? 'selected' : ''}>Y</option>
          <option value="z" ${section.axis !== 'x' && section.axis !== 'y' ? 'selected' : ''}>Z (height)</option>
        </select>
      </div>
      <div class="pp-row">
        <label>Offset (mm)</label>
        <input type="number" step="1" data-sect="offsetMM" value="${_fmt(section.offsetMM, 1)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-sect-toggle="flip" ${section.flip ? 'checked' : ''}> Flip side</label>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Models only — grid and floor stay. Shows in exports; shadows stay uncut.</span>
      </div>` : ''}`;

  const renderingSec = `
      ${_subhead('Still', 'ImageDown')}
      <div class="pp-row">
        <label>Resolution</label>
        <select data-ro-preset>
          ${RESOLUTION_PRESETS.map((p, i) =>
            `<option value="${i}" ${i === presetIdx ? 'selected' : ''}>${p.label}</option>`).join('')}
          <option value="custom" ${presetIdx === -1 ? 'selected' : ''}>Custom</option>
        </select>
      </div>
      <div class="pp-row">
        <label>Width px</label>
        <input type="number" step="1" min="16" max="8192" data-ro="width" value="${_fmt(ro.width, 0)}">
      </div>
      <div class="pp-row">
        <label>Height px</label>
        <input type="number" step="1" min="16" max="8192" data-ro="height" value="${_fmt(ro.height, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-ro-toggle="transparent" ${ro.transparent ? 'checked' : ''}> Transparent background (PNG)</label>
      </div>
      <div class="pp-row pp-row-inline">
        ${_toggle('data-action', 'render-view', 'Render view', _rv.active)}
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">While on, the camera position is remembered automatically.${ro.pose ? ' Exports shoot from the remembered view.' : ''}</span>
      </div>
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="export-png" title="Ctrl+Alt+E">Export PNG</button>
      </div>
      ${_subhead('Turntable', 'Disc3')}
      <div class="pp-row">
        <label>Duration (s)</label>
        <input type="number" step="1" min="1" max="120" data-tt="durationS" value="${_fmt(tt.durationS, 0)}">
      </div>
      <div class="pp-row">
        <label>FPS</label>
        <select data-tt-select="fps">
          <option value="30" ${tt.fps !== 60 ? 'selected' : ''}>30</option>
          <option value="60" ${tt.fps === 60 ? 'selected' : ''}>60</option>
        </select>
      </div>
      <div class="pp-row">
        <label>Direction</label>
        <select data-tt-select="direction">
          <option value="left" ${tt.direction !== 'right' ? 'selected' : ''}>Left</option>
          <option value="right" ${tt.direction === 'right' ? 'selected' : ''}>Right</option>
        </select>
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-tt-toggle="ease" ${tt.ease ? 'checked' : ''}> Ease in / out</label>
      </div>
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="preview-turntable">${isPreviewing() ? 'Stop preview' : 'Preview'}</button>
        <button type="button" class="pp-btn" data-action="export-video">Export video</button>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">One full 360° at the resolution above.</span>
      </div>`;

  _bodyEl.innerHTML =
    _section('grid', 'Grid', gridSec)
    + _section('environment', 'Environment', envSec)
    + _section('camera', 'Camera', camSec)
    + _section('section', 'Cross Section', sectionSec)
    + _section('rendering', 'Rendering', renderingSec);
  _wire();
}

// renderOut accessor — state merged over defaults (turntable merged one level
// deeper so a partial old save can't drop fields).
function _ro() {
  const stored = getState().scene.renderOut ?? {};
  return {
    ...RENDEROUT_DEFAULTS, ...stored,
    turntable: { ...RENDEROUT_DEFAULTS.turntable, ...(stored.turntable ?? {}) },
  };
}

function _setRenderOut(patch) {
  setState(s => {
    const cur = s.scene.renderOut ?? RENDEROUT_DEFAULTS;
    const next = { ...RENDEROUT_DEFAULTS, ...cur, ...patch };
    if (patch.turntable) {
      next.turntable = { ...RENDEROUT_DEFAULTS.turntable, ...cur.turntable, ...patch.turntable };
    }
    return { ...s, scene: { ...s.scene, renderOut: next } };
  }, SILENT);
  if (_rv.active) {
    const ro = _ro();
    RenderFrame.show({ width: ro.width, height: ro.height });
  }
}

function _wire() {
  // Section collapse — same .pp-collapsed pattern as the Properties panel,
  // but persisted per-user.
  _bodyEl.querySelectorAll('.pp-section[data-sec]').forEach(sec => {
    sec.querySelector(':scope > .pp-section-header')?.addEventListener('click', () => {
      const key = sec.dataset.sec;
      sec.classList.toggle('pp-collapsed');
      _collapsed[key] = sec.classList.contains('pp-collapsed');
      _saveCollapsed();
    });
  });

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

  // Grid/axes visibility — toggle buttons (checkbox→toggle audit). No
  // dependent rows, so reflect the pressed state in place instead of a full
  // re-render.
  _bodyEl.querySelectorAll('[data-overlay]').forEach(el => {
    el.addEventListener(_evt(el), () => {
      const name = el.dataset.overlay;
      const enabled = _nextVal(el);
      setState(s => ({
        ...s,
        scene: { ...s.scene, overlays: { ...s.scene.overlays, [name]: enabled } },
      }), SILENT);
      SceneManager.setOverlay(name, enabled);
      _reflectToggle(el, enabled);
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

  // Boolean render features — now toggle BUTTONS (checkbox→toggle audit).
  // vignette / floorEnabled / shadowsEnabled / hdriEnabled / ssaoEnabled gate
  // dependent rows, so those re-render the panel (which also re-paints the
  // pressed state from fresh state).
  _bodyEl.querySelectorAll('[data-render-toggle]').forEach(el => {
    el.addEventListener(_evt(el), () => {
      const key = el.dataset.renderToggle;
      const next = _nextVal(el);
      if (key === 'hdriEnabled' && next) _hdriToastWanted = true;
      _setRender({ [key]: next });
      if (['vignette', 'floorEnabled', 'shadowsEnabled', 'hdriEnabled', 'ssaoEnabled'].includes(key)) _render();
      else _reflectToggle(el, next);
    });
  });

  // Render selects (background / tone mapping / HDRI preset).
  _bodyEl.querySelectorAll('[data-render-select]').forEach(sel => {
    sel.addEventListener('change', () => {
      if (sel.dataset.renderSelect === 'hdriPreset') _hdriToastWanted = true;
      _setRender({ [sel.dataset.renderSelect]: sel.value });
    });
  });

  // Section plane — session-only state + SceneManager.setSectionPlane.
  // NB attribute prefix is data-SECT: data-sec is taken by the collapsible
  // <section data-sec> wrappers, and change events BUBBLE — a [data-sec]
  // selector here would attach to every section element and re-render the
  // panel on any child input's change (the render-view detach bug).
  // Cut view = toggle button (gates dependent rows → _render). Flip = checkbox
  // (sub-option of an enabled cut). _evt/_nextVal handle both element kinds.
  _bodyEl.querySelectorAll('[data-sect-toggle]').forEach(el => {
    el.addEventListener(_evt(el), () => {
      const key = el.dataset.sectToggle;
      _setSection({ [key]: _nextVal(el) });
      if (key === 'enabled') _render();
    });
  });
  _bodyEl.querySelector('[data-sect-select="axis"]')?.addEventListener('change', (e) => {
    _setSection({ axis: e.target.value });
  });
  _bodyEl.querySelectorAll('[data-sect]').forEach(input => {
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) { _render(); return; }
      _setSection({ [input.dataset.sect]: v });
    });
    _escEnter(input);
  });

  // Colour pickers (floor). `input` not `change` — live drag preview.
  _bodyEl.querySelectorAll('[data-render-color]').forEach(picker => {
    picker.addEventListener('input', () => {
      _setRender({ [picker.dataset.renderColor]: picker.value });
    });
  });

  // Texture cap — store on scene.render then re-cap every live texture.
  // Downscales from / restores to the per-texture full-res source; export
  // reads that source so output stays full-res regardless of the cap.
  _bodyEl.querySelector('[data-texcap]')?.addEventListener('change', (e) => {
    const px = Number(e.target.value) || 0;
    _setRender({ textureCapPx: px });
    AssetLoader.recapAllTextures(px);
  });

  _bodyEl.querySelector('[data-action="render-reset"]')?.addEventListener('click', () => {
    _setRender({ ...RENDER_DEFAULTS });
    _render();
    AssetLoader.recapAllTextures(RENDER_DEFAULTS.textureCapPx);
  });

  _wireRendering();
}

// ── Rendering (output) section ───────────────────────────

function _wireRendering() {
  _bodyEl.querySelector('[data-ro-preset]')?.addEventListener('change', (e) => {
    const preset = RESOLUTION_PRESETS[Number(e.target.value)];
    if (!preset) return;                      // Custom — W/H inputs drive it
    _setRenderOut({ width: preset.w, height: preset.h });
    _render();
  });

  _bodyEl.querySelectorAll('[data-ro]').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.ro;
      const value = clampDimension(input.value, RENDEROUT_DEFAULTS[key]);
      _setRenderOut({ [key]: value });
      _render();
    });
    _escEnter(input);
  });

  _bodyEl.querySelector('[data-ro-toggle="transparent"]')?.addEventListener('change', (e) => {
    _setRenderOut({ transparent: e.target.checked });
  });

  // Render view — compose mode. ON: park free navigation, jump to the stored
  // render pose (when one exists), show the frame, and auto-store every
  // subsequent camera move as the new render pose. OFF: snapshot the final
  // pose, back to free nav.
  _bodyEl.querySelector('[data-action="render-view"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = !_rv.active;     // toggle button
    const ro = _ro();
    if (on) {
      _rv.navPose = SceneManager.saveCameraState();
      if (ro.pose) SceneManager.restoreCameraState(ro.pose);
      else _setRenderOut({ pose: _rv.navPose });   // first use: current view IS the composition
      RenderFrame.show({ width: ro.width, height: ro.height });
      _rv.active = true;
      _watchRenderPose();
    } else {
      _setRenderOut({ pose: SceneManager.saveCameraState() });   // final snapshot
      const navPose = _rv.navPose;
      _exitRenderView();
      if (navPose) SceneManager.restoreCameraState(navPose);
    }
    _reflectToggle(btn, _rv.active);
  });

  _bodyEl.querySelector('[data-action="export-png"]')?.addEventListener('click', () => _exportPng());

  _bodyEl.querySelectorAll('[data-tt]').forEach(input => {
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v <= 0) { _render(); return; }
      _setRenderOut({ turntable: { [input.dataset.tt]: v } });
    });
    _escEnter(input);
  });
  _bodyEl.querySelectorAll('[data-tt-select]').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.ttSelect;
      _setRenderOut({ turntable: { [key]: key === 'fps' ? Number(sel.value) : sel.value } });
    });
  });
  _bodyEl.querySelector('[data-tt-toggle="ease"]')?.addEventListener('change', (e) => {
    _setRenderOut({ turntable: { ease: e.target.checked } });
  });

  // Preview — plays the sweep live (camera + lights rotate around the world
  // axis together), no recording. Button toggles to Stop; Esc also stops.
  _bodyEl.querySelector('[data-action="preview-turntable"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (isPreviewing()) { stopPreview(); return; }
    if (isRecording() || _busy) return;
    const tt = _ro().turntable;
    btn.textContent = 'Stop preview';
    _setBusy(true, { keepPreview: true });   // changing settings mid-sweep does nothing (U2)
    try {
      await previewTurntable(tt);
    } finally {
      btn.textContent = 'Preview';
      _setBusy(false);
    }
  });

  _bodyEl.querySelector('[data-action="export-video"]')?.addEventListener('click', async (e) => {
    if (isRecording() || _busy) return;
    const btn = e.currentTarget;
    const ro = _ro();
    const tt = ro.turntable;
    _setBusy(true);
    try {
      // Offline WebCodecs render at the output resolution (falls back to
      // realtime MediaRecorder only when WebCodecs is missing). Shoots from
      // the stored render composition when one exists (U1).
      const result = await recordTurntable({
        ...tt,
        width: ro.width,
        height: ro.height,
        pose: ro.pose ?? null,
        onProgress: (f) => { btn.textContent = `Rendering… ${Math.round(f * 100)}% — Esc cancels`; },
      });
      if (!result) {
        Toast.show('Turntable recording cancelled', 'info', 2500);
      } else {
        await triggerDownload(result.blob,
          turntableVideoName(getState().project.name, tt.durationS, result.ext),
          { mime: result.mime, ext: result.ext, description: 'Turntable video' });
        Toast.show(`Turntable exported (${tt.durationS}s ${result.ext.toUpperCase()})`, 'success', 3500);
      }
    } catch (err) {
      console.error('Turntable recording failed:', err);
      Toast.show('Turntable recording failed — see console', 'error', 5000);
    } finally {
      btn.textContent = 'Export video';
      _setBusy(false);
    }
  });
}

// One capture at a time: disable the rendering action buttons while any
// runs (UX audit U2). keepPreview leaves the Preview button live — it
// doubles as the Stop button during its own sweep.
function _setBusy(on, { keepPreview = false } = {}) {
  _busy = on;
  for (const sel of ['export-png', 'export-video', 'preview-turntable']) {
    if (keepPreview && sel === 'preview-turntable') continue;
    const btn = _bodyEl?.querySelector(`[data-action="${sel}"]`);
    if (btn) btn.disabled = on;
  }
}

// Shared by the Export PNG button and Ctrl+Alt+E. Shoots from the stored
// render composition when one exists (U1); current view otherwise.
async function _exportPng() {
  if (_busy) return;
  const btn = _bodyEl?.querySelector('[data-action="export-png"]');
  const ro = _ro();
  _setBusy(true);
  if (btn) btn.textContent = 'Rendering…';
  try {
    const blob = await capturePng({ ...ro, pose: ro.pose ?? null });
    await triggerDownload(blob, renderPngName(getState().project.name, ro),
      { mime: 'image/png', ext: 'png', description: 'PNG image' });
    Toast.show(`PNG rendered (${ro.width} × ${ro.height})`, 'success', 3000);
  } catch (err) {
    console.error('PNG render failed:', err);
    Toast.show('PNG render failed — see console', 'error', 5000);
  } finally {
    if (btn) btn.textContent = 'Export PNG';
    _setBusy(false);
  }
}

function _setRender(patch) {
  setState(s => ({
    ...s,
    scene: { ...s.scene, render: { ...RENDER_DEFAULTS, ...s.scene.render, ...patch } },
  }), SILENT);
  SceneManager.applyRenderSettings(getState().scene.render);
}

function _setSection(patch) {
  setState(s => ({
    ...s,
    scene: { ...s.scene, section: { ...SECTION_DEFAULTS, ...s.scene.section, ...patch } },
  }), SILENT);
  _applySection();
}

function _applySection() {
  SceneManager.setSectionPlane({ ...SECTION_DEFAULTS, ...(getState().scene.section ?? {}) });
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
