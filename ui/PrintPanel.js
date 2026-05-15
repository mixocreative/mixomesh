import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { PrintManager, SCALE_PRESETS } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { SceneManager } from '../core/SceneManager.js';
import { push, RescaleWorldCommand } from '../core/HistoryManager.js';
import { Toast, safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';
import { Modal } from './Modal.js';

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

// Print-bed presets (interior build volume, mm). 'Custom' keeps current dims.
const BED_PRESETS = [
  { label: 'Elegoo Saturn 4 Ultra', x: 218.88, y: 122.88, z: 220 },
  { label: 'Bambu Lab P1S / X1C', x: 256, y: 256, z: 256 },
  { label: 'Bambu Lab A1',        x: 256, y: 256, z: 256 },
  { label: 'Bambu Lab A1 mini',   x: 180, y: 180, z: 180 },
  { label: 'Prusa MK4 / MK3S+',   x: 250, y: 210, z: 220 },
  { label: 'Creality Ender 3',    x: 220, y: 220, z: 250 },
  { label: 'Generic Large',       x: 300, y: 300, z: 400 },
  { label: 'Custom',              x: null, y: null, z: null },
];

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
  Modal.register('exportConfirm', _renderExportConfirmModal);

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
      if (!obj?._babylonMesh) return;

      try {
        const mesh = obj._babylonMesh;
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

  html += '</div>';

  html += '<div class="pp-field-group">';
  html += '<label>Format</label>';

  html += `<button class="pp-export-btn pp-export-obj" data-format="obj">`;
  html += `${icon('Download', 'inline')} Export OBJ + MTL`;
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

  // Wire export buttons
  el.querySelector('.pp-export-obj').addEventListener('click', async () => {
    const opts = getOptions();
    await safeAsync(async () => {
      const validationMap = await MeshValidator.validateAllPrintParts();
      const hasErrors = Array.from(validationMap.values()).some(results =>
        results.some(r => r.severity === 'error')
      );
      const hasWarnings = Array.from(validationMap.values()).some(results =>
        results.some(r => r.severity === 'warning')
      );

      if (hasErrors) {
        // Show error modal
        const errors = [];
        for (const [meshId, results] of validationMap) {
          const obj = getState().scene.objects[meshId];
          for (const r of results) {
            if (r.severity === 'error') {
              errors.push({ meshName: obj?.name || meshId, message: r.message });
            }
          }
        }
        Modal.open('validationErrors', { errors });
        return;
      }

      if (hasWarnings) {
        // Show confirm modal
        Modal.open('exportConfirm', {
          onConfirm: () => PrintManager.exportOBJ(opts),
        });
        return;
      }

      // No warnings/errors: export directly
      await PrintManager.exportOBJ(opts);
    });
  });

  el.querySelector('.pp-export-stl').addEventListener('click', async () => {
    const opts = getOptions();
    await safeAsync(async () => {
      const validationMap = await MeshValidator.validateAllPrintParts();
      const hasErrors = Array.from(validationMap.values()).some(results =>
        results.some(r => r.severity === 'error')
      );
      const hasWarnings = Array.from(validationMap.values()).some(results =>
        results.some(r => r.severity === 'warning')
      );

      if (hasErrors) {
        const errors = [];
        for (const [meshId, results] of validationMap) {
          const obj = getState().scene.objects[meshId];
          for (const r of results) {
            if (r.severity === 'error') {
              errors.push({ meshName: obj?.name || meshId, message: r.message });
            }
          }
        }
        Modal.open('validationErrors', { errors });
        return;
      }

      if (hasWarnings) {
        Modal.open('exportConfirm', {
          onConfirm: () => PrintManager.exportSTL(opts),
        });
        return;
      }

      await PrintManager.exportSTL(opts);
    });
  });

  return el;
}

// ── Bed Tab ──────────────────────────────────────────────

function _matchBedPreset(dims) {
  const p = BED_PRESETS.find(
    b => b.x === dims.x && b.y === dims.y && b.z === dims.z
  );
  return p ? p.label : 'Custom';
}

function _renderBedTab() {
  const state = getState();
  const dims = state.print.bedDimensions;
  const presetLabel = state.print.bedPreset || _matchBedPreset(dims);
  const showVolume = state.scene.overlays.bedPreview ?? false;

  let html = '<div class="pp-tab-content">';

  html += '<div class="pp-field-group">';
  html += '<label>Printer Bed</label>';
  html += '<select id="pp-bed-preset" class="pp-preset-select">';
  for (const b of BED_PRESETS) {
    const sel = b.label === presetLabel ? ' selected' : '';
    html += `<option value="${b.label}"${sel}>${b.label}</option>`;
  }
  html += '</select>';
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

  // Commit bed dims + preset to state (non-undoable metadata, like targetRatio).
  // Re-draw the volume box live when it is currently shown.
  const commit = (next) => {
    setState(s => ({
      ...s,
      print: { ...s.print, bedPreset: next.preset, bedDimensions: next.dims },
    }), { silent: true });
    // Scene floor footprint tracks the printer bed XY.
    SceneManager.rebuildBed();
    if (getState().scene.overlays.bedPreview) {
      SceneManager.updateBedPreview(next.dims);
    }
  };

  el.querySelector('#pp-bed-preset').addEventListener('change', (e) => {
    const b = BED_PRESETS.find(p => p.label === e.target.value);
    if (!b) return;
    if (b.x === null) {
      // Custom: keep current dims, just relabel.
      commit({ preset: 'Custom', dims: getState().print.bedDimensions });
    } else {
      commit({ preset: b.label, dims: { x: b.x, y: b.y, z: b.z } });
    }
    _render();
  });

  el.querySelectorAll('[data-bed-axis]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const axis = e.target.dataset.bedAxis;
      const v = parseFloat(e.target.value);
      if (!(v > 0)) { e.target.value = getState().print.bedDimensions[axis]; return; }
      const dims = { ...getState().print.bedDimensions, [axis]: v };
      commit({ preset: _matchBedPreset(dims), dims });
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

function _renderValidationErrorsModal(payload) {
  const { errors } = payload;

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
  el.querySelector('[data-action="close"]').addEventListener('click', () => {
    Modal.close();
  });
  return el;
}

function _renderExportConfirmModal(payload) {
  const { onConfirm } = payload;

  let html = '<div class="modal-content">';
  html += '<h3>Export Anyway?</h3>';
  html += '<p>Warnings detected. Export anyway?</p>';
  html += '<div class="modal-actions">';
  html += '<button class="btn btn-secondary" data-action="cancel">Cancel</button>';
  html += '<button class="btn btn-primary" data-action="confirm">Export</button>';
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    Modal.close();
  });
  el.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    Modal.close();
    if (onConfirm) {
      await safeAsync(onConfirm);
    }
  });
  return el;
}

export const PrintPanel = { init };
