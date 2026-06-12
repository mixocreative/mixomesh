// Scene panel (#rp-scene) — scene-wide settings, moved OUT of the Properties
// panel so they're reachable while an object is selected (the old Scene
// section only rendered when nothing was active). Sections:
//   Grid      — grid styling (cell mm / subdivisions) + grid/axes visibility
//   Render    — viewport look: exposure, contrast, tone map, saturation,
//               vignette, shadows, lights (state.scene.render, applied via
//               SceneManager.applyRenderSettings, persisted in .mixo)
//   Camera    — optics (FOV / near clip)
//   Rendering — output production (state.scene.renderOut): PNG stills
//               (optionally transparent), render-view compose toggle with
//               frame overlay, and turntable video (core/RenderOutput.js)
// Hidden outside the Scene workspace via body[data-workspace] CSS (layout.css).

import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { SceneManager } from '../core/SceneManager.js';
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
};

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
  subscribe(EVENTS.PROJECT_LOADED, () => { _exitRenderView(); _render(); });
  subscribe(EVENTS.PROJECT_NEW,    () => { _exitRenderView(); _render(); });
  _render();
}

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
      <header class="pp-section-header">Environment</header>
      <div class="pp-row">
        <label>Background</label>
        <select data-render-select="background">
          <option value="light" ${render.background !== 'dark' ? 'selected' : ''}>Light</option>
          <option value="dark" ${render.background === 'dark' ? 'selected' : ''}>Dark</option>
        </select>
      </div>
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
        <label><input type="checkbox" data-render-toggle="vignette" ${render.vignette ? 'checked' : ''}> Vignette</label>
      </div>
      <div class="pp-row">
        <label>Vignette amt</label>
        <input type="number" step="0.25" min="0" max="10" data-render="vignetteWeight" value="${_fmt(render.vignetteWeight)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-render-toggle="floorEnabled" ${render.floorEnabled ? 'checked' : ''}> Floor</label>
        <input type="color" data-render-color="floorColor" value="${render.floorColor}" title="Floor colour">
      </div>
      <div class="pp-row">
        <label>Floor Z (mm)</label>
        <input type="number" step="1" data-render="floorZMM" value="${_fmt(render.floorZMM, 1)}">
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" data-render-toggle="shadowsEnabled" ${render.shadowsEnabled ? 'checked' : ''}> Shadows</label>
      </div>
      <div class="pp-row">
        <label>Shadow dark</label>
        <input type="number" step="0.05" min="0" max="1" data-render="shadowDarkness" value="${_fmt(render.shadowDarkness)}">
      </div>
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
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="render-reset">Reset render defaults</button>
      </div>
    </section>
    <section class="pp-section">
      <header class="pp-section-header">Camera</header>
      <div class="pp-row">
        <label>FOV (deg)</label>
        <input type="number" step="1" min="5" max="140" data-render="fovDeg" value="${_fmt(render.fovDeg, 1)}">
      </div>
      <div class="pp-row">
        <label>Near clip (mm)</label>
        <input type="number" step="0.5" min="0.1" max="100" data-render="clipNearMM" value="${_fmt(render.clipNearMM, 1)}">
      </div>
    </section>
    <section class="pp-section">
      <header class="pp-section-header">Rendering</header>
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
        <label><input type="checkbox" data-action="render-view" ${_rv.active ? 'checked' : ''}> Render view</label>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">While on, the camera position is remembered automatically.</span>
      </div>
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-btn" data-action="export-png">Export PNG</button>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Turntable — one full 360° around the current view.</span>
      </div>
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
        <span class="pp-hint">Video records the viewport live — Esc cancels.</span>
      </div>
    </section>
  `;
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

  // Boolean render toggles (shadows / vignette).
  _bodyEl.querySelectorAll('[data-render-toggle]').forEach(box => {
    box.addEventListener('change', () => {
      _setRender({ [box.dataset.renderToggle]: box.checked });
    });
  });

  // Render selects (background / tone mapping).
  _bodyEl.querySelectorAll('[data-render-select]').forEach(sel => {
    sel.addEventListener('change', () => {
      _setRender({ [sel.dataset.renderSelect]: sel.value });
    });
  });

  // Colour pickers (floor). `input` not `change` — live drag preview.
  _bodyEl.querySelectorAll('[data-render-color]').forEach(picker => {
    picker.addEventListener('input', () => {
      _setRender({ [picker.dataset.renderColor]: picker.value });
    });
  });

  _bodyEl.querySelector('[data-action="render-reset"]')?.addEventListener('click', () => {
    _setRender({ ...RENDER_DEFAULTS });
    _render();
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
  _bodyEl.querySelector('[data-action="render-view"]')?.addEventListener('change', (e) => {
    const on = e.target.checked;
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
  });

  _bodyEl.querySelector('[data-action="export-png"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ro = _ro();
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const blob = await capturePng(ro);
      await triggerDownload(blob, renderPngName(getState().project.name, ro),
        { mime: 'image/png', ext: 'png', description: 'PNG image' });
      Toast.show(`PNG rendered (${ro.width} × ${ro.height})`, 'success', 3000);
    } catch (err) {
      console.error('PNG render failed:', err);
      Toast.show('PNG render failed — see console', 'error', 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export PNG';
    }
  });

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

  // Preview — plays the sweep live (camera + lights rotate around world
  // origin together), no recording. Button toggles to Stop; Esc also stops.
  _bodyEl.querySelector('[data-action="preview-turntable"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (isPreviewing()) { stopPreview(); return; }
    if (isRecording()) return;
    const tt = _ro().turntable;
    btn.textContent = 'Stop preview';
    try {
      await previewTurntable(tt);
    } finally {
      btn.textContent = 'Preview';
    }
  });

  _bodyEl.querySelector('[data-action="export-video"]')?.addEventListener('click', async (e) => {
    if (isRecording()) return;
    const btn = e.currentTarget;
    const tt = _ro().turntable;
    btn.disabled = true;
    try {
      const result = await recordTurntable({
        ...tt,
        onProgress: (f) => { btn.textContent = `Recording… ${Math.round(f * 100)}%`; },
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
      btn.disabled = false;
      btn.textContent = 'Export video';
    }
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
