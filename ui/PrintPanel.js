import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { PrintManager, SCALE_PRESETS } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import { push, RescaleWorldCommand } from '../core/HistoryManager.js';
import { Toast } from './Toast.js';
import { icon } from '../core/Icons.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import printersData from '../config/printers.json' with { type: 'json' };

// Parse a print-scale ratio of the form M:N or M/N (both > 0). A bare number
// "N" is treated as "1:N". Returns the value N/M — i.e. how many real-world
// metres correspond to one printed metre. Values < 1 mean "upscaled" (2:1
// = double size); values > 1 mean "downscaled" (1:72 = 72× smaller).
function _parseRatio(str) {
  const s = String(str).trim();
  // M:N or M/N
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (a > 0 && b > 0) return b / a;
    return null;
  }
  // bare number → 1:N
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? n : null;
  }
  return null;
}

function _fmtRatio(n) {
  if (!Number.isFinite(n) || n <= 0) return '1:1';
  if (Math.abs(n - 1) < 1e-9) return '1:1';
  if (n > 1) {
    const r = Math.round(n);
    return Math.abs(n - r) < 1e-6 ? `1:${r}` : `1:${(+n.toFixed(3)).toString()}`;
  }
  const m = 1 / n;
  const r = Math.round(m);
  return Math.abs(m - r) < 1e-6 ? `${r}:1` : `${(+m.toFixed(3)).toString()}:1`;
}

// Printer profiles maintained in `config/printers.json` (single source of
// truth — also drives export pipeline + color mode + texture handling).
// `custom` entry has all-null bed dims; user types XYZ manually.
export const PRINTERS = printersData;

let _bodyEl = null;
let _activeTab = 'scale'; // 'scale' | 'validation' | 'bed' | 'preview' | 'export'

export function init() {
  _bodyEl = document.getElementById('rp-print-body');
  if (!_bodyEl) return;
  _bodyEl.classList.add('pp-body');

  // Re-render on state changes
  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.OBJECT_ADDED,
    EVENTS.OBJECT_REMOVED,
  ];
  for (const ev of events) subscribe(ev, _render);

  // Register validation modals
  Modal.register('validationErrors', _renderValidationErrorsModal);

  _render();
}

// ── Tabs ──────────────────────────────────────────────────

function _renderTabs() {
  const tabs = ['scale', 'validation', 'bed', 'preview', 'export'];
  const labels = {
    scale: 'Scale',
    validation: 'Validation',
    bed: 'Bed',
    preview: 'Preview',
    export: 'Export',
  };

  let html = '<div class="pp-tabs">';
  for (const tab of tabs) {
    const active = tab === _activeTab ? ' active' : '';
    html += `<button class="pp-tab${active}" data-tab="${tab}">${labels[tab]}</button>`;
  }
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('.pp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _render();
    });
  });

  return el;
}

// ── Scale Tab ─────────────────────────────────────────────

function _renderScaleTab() {
  const state = getState();
  const { workingRatio, targetRatio } = state.print;

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';

  // Working Ratio
  html += '<label>Working Ratio</label>';
  html += '<div class="pp-ratio-select">';
  html += '<select data-field="workingRatio" class="pp-preset-select">';
  html += '<option value="">Custom…</option>';
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      const selected = workingRatio === preset.ratio ? ' selected' : '';
      html += `<option value="${preset.ratio}"${selected}>${preset.label}</option>`;
    }
  }
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-field="workingRatio" value="${_fmtRatio(workingRatio)}" placeholder="1:1">`;
  html += '</div>';

  // Target Ratio
  html += '<label>Target Ratio (Print Scale)</label>';
  html += '<div class="pp-ratio-select">';
  html += '<select data-field="targetRatio" class="pp-preset-select">';
  html += '<option value="">Custom…</option>';
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      const selected = targetRatio === preset.ratio ? ' selected' : '';
      html += `<option value="${preset.ratio}"${selected}>${preset.label}</option>`;
    }
  }
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-field="targetRatio" value="${_fmtRatio(targetRatio)}" placeholder="1:35">`;
  html += '</div>';

  html += '</div>';

  // Export factor display
  const factor = (workingRatio / targetRatio) * 1000;
  html += `<div class="pp-info"><strong>Export factor:</strong> ${factor.toFixed(2)} (BU → mm)</div>`;

  // Example dimensions
  const selected = getState().selection.selectedIds;
  if (selected.length > 0) {
    const firstMesh = getState().scene.objects[selected[0]];
    if (firstMesh) {
      const dims = PrintManager.getExportedDimensions(selected[0]);
      if (dims) {
        html += `<div class="pp-info"><strong>Example (active):</strong> ${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)} mm</div>`;
      }
    }
  }

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Wire ratio inputs. workingRatio changes go through RescaleWorldCommand so
  // every scene mesh is rebaked at the new BU↔metres mapping and the action
  // is undoable. targetRatio is export-only metadata — direct setState is OK.
  const applyRatio = (field, val) => {
    if (field === 'workingRatio') {
      const prev = getState().print.workingRatio;
      if (val === prev) return;
      push(new RescaleWorldCommand(prev, val));
    } else {
      setState(s => ({ ...s, print: { ...s.print, [field]: val } }));
    }
  };

  el.querySelectorAll('.pp-preset-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      if (e.target.value) {
        const val = parseInt(e.target.value, 10);
        applyRatio(field, val);
        el.querySelector(`.pp-ratio-input[data-field="${field}"]`).value = _fmtRatio(val);
      }
    });
  });

  el.querySelectorAll('.pp-ratio-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      const val = _parseRatio(e.target.value);
      if (!val) { e.target.value = _fmtRatio(getState().print[field]); return; }
      e.target.value = _fmtRatio(val);
      applyRatio(field, val);
    });
  });

  return el;
}

// ── Validation Tab ───────────────────────────────────────

async function _renderValidationTab() {
  const validationMap = await MeshValidator.validateAllPrintParts();
  const state = getState();

  let html = '<div class="pp-tab-content">';

  if (validationMap.size === 0) {
    html += '<p class="pp-empty">No print parts to validate.</p>';
  } else {
    for (const [meshId, results] of validationMap) {
      const obj = state.scene.objects[meshId];
      if (!obj) continue;

      const hasErrors = results.some(r => r.severity === 'error');
      const hasWarnings = results.some(r => r.severity === 'warning' && !hasErrors);
      const icon_name = hasErrors ? 'AlertCircle' : hasWarnings ? 'AlertTriangle' : 'Check';
      const icon_class = hasErrors ? 'error' : hasWarnings ? 'warning' : 'success';

      html += `<div class="pp-mesh-validation ${icon_class}">`;
      html += `<div class="pp-mesh-header">`;
      html += `${icon(icon_name, 'inline')}`;
      html += `<span class="pp-mesh-name">${obj.name}</span>`;
      html += `</div>`;

      if (results.length > 0) {
        html += '<ul class="pp-result-list">';
        for (const result of results) {
          const canFix = result.autoFixAvailable && !result.fixed;
          html += `<li class="pp-result ${result.severity}">`;
          html += `<span>${result.message}</span>`;
          if (canFix) {
            html += `<button class="pp-autofix-btn" data-mesh-id="${meshId}" data-result-type="${result.type}">Auto-Fix</button>`;
          }
          html += '</li>';
        }
        html += '</ul>';
      }

      html += '</div>';
    }
  }

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Wire auto-fix buttons
  el.querySelectorAll('.pp-autofix-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const meshId = btn.dataset.meshId;
      const obj = getState().scene.objects[meshId];
      if (!obj) return;
      const mesh = AssetLoader.getBabylonMesh(meshId);
      if (!mesh) return;

      try {
        const results = await MeshValidator.validateMesh(mesh);
        await MeshValidator.autoFix(mesh, results);
        Toast.show(`✓ Fixed ${obj.name}`, 'success', 2000);
        _render();
      } catch (err) {
        console.error('Auto-fix failed:', err);
        Toast.show(`✗ Auto-fix failed: ${err.message}`, 'error', 0);
      }
    });
  });

  return el;
}

// ── Export Tab ────────────────────────────────────────────

function _renderExportTab() {
  const bakeSolids = getState().print?.objBakeSolidTextures ?? true;

  let html = '<div class="pp-tab-content">';

  html += '<div class="pp-field-group">';
  html += '<label>Export Options</label>';

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-selected-only" data-option="selectedOnly">';
  html += '<label for="pp-selected-only">Selected only</label>';
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-individually" data-option="individually">';
  html += '<label for="pp-individually">Each individually (separate files)</label>';
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-bake-solid" ${bakeSolids ? 'checked' : ''}>`;
  html += '<label for="pp-bake-solid">Bake solid colors to texture (OBJ, Mimaki-friendly)</label>';
  html += '</div>';

  html += '</div>';

  html += '<div class="pp-field-group">';
  html += '<label>Format</label>';

  html += `<button class="pp-export-btn pp-export-obj" data-format="obj">`;
  html += `${icon('Download', 'inline')} Export OBJ + MTL`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-3mf" data-format="3mf">`;
  html += `${icon('Download', 'inline')} Export 3MF (color)`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-stl" data-format="stl">`;
  html += `${icon('Download', 'inline')} Export STL`;
  html += `</button>`;

  html += '</div>';

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Collect options
  const getOptions = () => {
    const selectedOnly = el.querySelector('#pp-selected-only').checked;
    const individually = el.querySelector('#pp-individually').checked;
    return { selectedOnly, individually };
  };

  // Wire export buttons. Validation now happens INSIDE the export (after the
  // file-type auto-fix), so the panel just runs the export and only surfaces
  // the error list for problems the auto-fix couldn't resolve.
  const runExport = async (fn, opts) => {
    ProgressOverlay.show('Exporting…');
    try {
      await fn({ ...opts, onProgress: (frac, msg) => ProgressOverlay.update(frac, msg) });
    } catch (err) {
      if (err?.validationErrors?.length) {
        Modal.open('validationErrors', { errors: err.validationErrors });
      } else {
        console.error(err);
        Toast.show(`Error: ${err.message}`, 'error', 0);
      }
    } finally {
      ProgressOverlay.hide();
    }
  };

  el.querySelector('#pp-bake-solid').addEventListener('change', (e) => {
    const on = !!e.target.checked;
    setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: on } }), { silent: true });
  });

  el.querySelector('.pp-export-obj').addEventListener('click', () =>
    runExport(PrintManager.exportOBJ, getOptions()));

  el.querySelector('.pp-export-3mf').addEventListener('click', () =>
    runExport(PrintManager.exportThreeMF, getOptions()));

  el.querySelector('.pp-export-stl').addEventListener('click', () =>
    runExport(PrintManager.exportSTL, getOptions()));

  return el;
}

// ── Bed Tab ──────────────────────────────────────────────

function _matchPrinterByBed(dims) {
  for (const [id, p] of Object.entries(PRINTERS)) {
    if (id === 'custom') continue;
    const b = p.bed;
    if (b && b.x === dims.x && b.y === dims.y && b.z === dims.z) return id;
  }
  return 'custom';
}

function _renderBedTab() {
  const state = getState();
  const dims = state.print.bedDimensions;
  const printerId = state.print.targetPrinterId || _matchPrinterByBed(dims);
  const showVolume = state.scene.overlays.bedPreview ?? false;

  let html = '<div class="pp-tab-content">';

  html += '<div class="pp-field-group">';
  html += '<label>Target Printer</label>';
  html += '<select id="pp-printer-select" class="pp-preset-select">';
  for (const [id, p] of Object.entries(PRINTERS)) {
    const sel = id === printerId ? ' selected' : '';
    html += `<option value="${id}"${sel}>${p.displayName}</option>`;
  }
  html += '</select>';
  const cur = PRINTERS[printerId];
  if (cur) {
    const fmt = cur.format;
    const colorMode = cur.color?.mode;
    html += `<div class="pp-info">${cur.vendor} · ${fmt} · ${colorMode}</div>`;
  }
  html += '</div>';

  html += '<div class="pp-field-group">';
  html += '<label>Build Volume (mm)</label>';
  html += '<div class="pp-xyz-row">';
  for (const axis of ['x', 'y', 'z']) {
    html += `<label class="pp-xyz">${axis.toUpperCase()}`;
    html += `<input type="number" min="1" step="1" data-bed-axis="${axis}" value="${dims[axis]}"></label>`;
  }
  html += '</div>';
  html += '</div>';

  html += '<div class="pp-field-group">';
  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-bed-show" ${showVolume ? 'checked' : ''}>`;
  html += '<label for="pp-bed-show">Show bed volume in viewport</label>';
  html += '</div>';
  html += '<div class="pp-info">Models exceeding the bed are flagged in Validation.</div>';
  html += '</div>';

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Commit target printer + bed dims to state (non-undoable metadata, like
  // targetRatio). Re-draw the volume box live when currently shown.
  const commit = (next) => {
    setState(s => ({
      ...s,
      print: { ...s.print, targetPrinterId: next.printerId, bedDimensions: next.dims },
    }), { silent: true });
    SceneManager.rebuildBed();
    if (getState().scene.overlays.bedPreview) {
      SceneManager.updateBedPreview(next.dims);
    }
  };

  el.querySelector('#pp-printer-select').addEventListener('change', (e) => {
    const id = e.target.value;
    const p = PRINTERS[id];
    if (!p) return;
    if (!p.bed || p.bed.x === null) {
      // Custom: keep current dims, just retarget.
      commit({ printerId: id, dims: getState().print.bedDimensions });
    } else {
      commit({ printerId: id, dims: { x: p.bed.x, y: p.bed.y, z: p.bed.z } });
    }
    _render();
  });

  el.querySelectorAll('[data-bed-axis]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const axis = e.target.dataset.bedAxis;
      const v = parseFloat(e.target.value);
      if (!(v > 0)) { e.target.value = getState().print.bedDimensions[axis]; return; }
      const dims = { ...getState().print.bedDimensions, [axis]: v };
      commit({ printerId: _matchPrinterByBed(dims), dims });
      _render();
    });
  });

  el.querySelector('#pp-bed-show').addEventListener('change', (e) => {
    const on = e.target.checked;
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, bedPreview: on } },
    }), { silent: true });
    SceneManager.setOverlay('bedPreview', on);
  });

  return el;
}

// ── Preview Tab ──────────────────────────────────────────

function _renderPreviewTab() {
  const state = getState();
  const isOn = state.scene.overlays.printPreview ?? false;
  const wireOn = state.scene.overlays.wireframeEdges ?? false;
  const wireColor = state.scene.overlays.wireframeEdgeColor ?? '#ffcc00';

  let html = '<div class="pp-tab-content">';

  html += '<div class="pp-field-group">';
  html += '<label>Print Preview Mode</label>';
  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-preview-toggle" ${isOn ? 'checked' : ''}>`;
  html += '<label for="pp-preview-toggle">Matte/flat (removes metallic)</label>';
  html += '</div>';
  html += '</div>';

  html += '<div class="pp-field-group">';
  html += '<label>Wireframe Edges</label>';
  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-wire-toggle" ${wireOn ? 'checked' : ''}>`;
  html += '<label for="pp-wire-toggle">Show edge outlines on models</label>';
  html += '</div>';
  html += `<div class="pp-wire-color-row ${wireOn ? '' : 'pp-hidden'}">`;
  html += '<label>Edge color</label>';
  html += `<input type="color" id="pp-wire-color" value="${wireColor}">`;
  html += '</div>';
  html += '</div>';

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  el.querySelector('#pp-preview-toggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, printPreview: enabled } },
    }), { silent: true });
    SceneManager.setOverlay('printPreview', enabled);
  });

  const wireToggle = el.querySelector('#pp-wire-toggle');
  const wireColorRow = el.querySelector('.pp-wire-color-row');
  const wireColorInput = el.querySelector('#pp-wire-color');

  wireToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    wireColorRow.classList.toggle('pp-hidden', !enabled);
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, wireframeEdges: enabled } },
    }), { silent: true });
    SceneManager.setOverlay('wireframeEdges', enabled);
  });

  wireColorInput.addEventListener('input', (e) => {
    const color = e.target.value;
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, wireframeEdgeColor: color } },
    }), { silent: true });
    SceneManager.setWireframeEdgeColor(color);
  });

  return el;
}

// ── Main render ───────────────────────────────────────────

async function _render() {
  if (!_bodyEl) return;
  _bodyEl.innerHTML = '';

  // Add tabs
  _bodyEl.appendChild(_renderTabs());

  // Add active tab content
  if (_activeTab === 'scale') {
    _bodyEl.appendChild(_renderScaleTab());
  } else if (_activeTab === 'validation') {
    const el = await _renderValidationTab();
    _bodyEl.appendChild(el);
  } else if (_activeTab === 'bed') {
    _bodyEl.appendChild(_renderBedTab());
  } else if (_activeTab === 'preview') {
    _bodyEl.appendChild(_renderPreviewTab());
  } else if (_activeTab === 'export') {
    _bodyEl.appendChild(_renderExportTab());
  }
}

// ── Modals ────────────────────────────────────────────────

function _renderValidationErrorsModal({ data, close }) {
  const errors = data?.errors ?? [];

  let html = '<div class="modal-content">';
  html += '<h3>Validation Errors</h3>';
  html += '<p>Cannot export while errors are present. Fix them first:</p>';
  html += '<ul>';
  for (const { meshName, message } of errors) {
    html += `<li><strong>${meshName}:</strong> ${message}</li>`;
  }
  html += '</ul>';
  html += '<div class="modal-actions">';
  html += '<button class="btn btn-primary" data-action="close">OK</button>';
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

export const PrintPanel = { init };
