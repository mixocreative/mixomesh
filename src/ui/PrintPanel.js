import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { PrintManager, SCALE_PRESETS } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { push, RescaleWorldCommand } from '../core/HistoryManager.js';
import { Toast } from './Toast.js';
import { icon, sectionIcon } from '../core/Icons.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { Workspace } from './Workspace.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import printersData from '../config/printers.json' with { type: 'json' };
import { formatScaleRatio, parseScaleRatioText } from '../core/scale/ScaleMath.js';
import { exportFactor } from '../core/print/PrintScale.js';

// Printer profiles maintained in `config/printers.json` (single source of
// truth — also drives export pipeline + color mode + texture handling).
// `custom` entry has all-null bed dims; user types XYZ manually.
export const PRINTERS = printersData;

let _bodyEl = null;
let _root   = null;
let _activeTab = 'scale'; // 'scale' | 'validation' | 'bed' | 'export'

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

export function init() {
  _bodyEl = document.getElementById('rp-print-body');
  _root   = document.getElementById('rp-print');
  if (!_bodyEl) return;
  _bodyEl.classList.add('pp-body');
  // Re-translate the static `.rp-title` in index.html + any body-level keys
  // on locale switch. The Print panel's body uses tabbed sub-content with no
  // section.* headers in scope for v1 — keys live in the static header today.
  subscribe(EVENTS.LOCALE_CHANGED, () => _retranslate(_root));

  // Re-render on state changes. (EVENTS.OBJECT_ADDED never existed — the
  // import signal is ASSET_INSTANTIATED; review M11.)
  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.OBJECT_REMOVED,
    EVENTS.OBJECT_RESTORED,
    EVENTS.VALIDATION_COMPLETE,   // cache updates from import auto-validate (A6)
  ];
  for (const ev of events) subscribe(ev, _render);
  // A print reset (or reset-all) rewrote print settings — re-render to show them.
  subscribe(EVENTS.SETTINGS_RESET, _render);

  // B5 toast click-through: a clicked validation toast surfaces this panel's
  // Validation tab.
  subscribe(EVENTS.VALIDATION_FOCUS_REQUESTED, _focusValidation);

  // Register validation modals
  Modal.register('validationErrors', _renderValidationErrorsModal);
  Modal.register('exportWarningsConfirm', _renderExportWarningsModal);

  _render();
}

/**
 * Bring the Validation tab on screen: switch to the Print workspace (the
 * only one whose right column shows this panel), clear a manual right-panel
 * collapse, expand the section if the user folded it, then activate the tab.
 */
function _focusValidation() {
  Workspace.setWorkspace('print');
  if (getState().ui.panelCollapsed?.right === true) Workspace.togglePanel('right');
  const sec = document.getElementById('rp-print');
  if (sec?.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    sec.querySelector('.rp-section-header')?.setAttribute('aria-expanded', 'true');
  }
  _activeTab = 'validation';
  _render();
}

// ── Tabs ──────────────────────────────────────────────────

function _renderTabs() {
  // Preview controls (wireframe edges, matte/flat) moved to the viewport
  // toggles under the NavCube (ui/ViewportToggles.js) so they're reachable
  // from every workspace — no Preview tab.
  const tabs = ['scale', 'validation', 'bed', 'export'];
  const labelKeys = {
    scale: 'print.tab.scale',
    validation: 'print.tab.validation',
    bed: 'print.tab.bed',
    export: 'print.tab.export',
  };
  const tabIcons = {
    scale: 'Percent',
    validation: 'CheckCircle',
    bed: 'Maximize',
    export: 'FileDown',
  };

  let html = `<div class="pp-tabs" role="tablist" aria-label="${escapeAttr(t('print.settingsAria'))}">`;
  for (const tab of tabs) {
    const active = tab === _activeTab ? ' active' : '';
    const selected = tab === _activeTab ? 'true' : 'false';
    html += `<button class="pp-tab${active}" data-tab="${escapeAttr(tab)}" role="tab" aria-selected="${selected}">${sectionIcon(tabIcons[tab])}${escapeHtml(t(labelKeys[tab]))}</button>`;
  }
  // ↺ resets the whole print settings slice (scale / bed / export) — they
  // share one state slice, so one button covers all three settings tabs.
  html += `<button class="pp-tab-reset" data-act="reset-print" title="${escapeAttr(t('print.resetTitle'))}" aria-label="${escapeAttr(t('print.resetTitle'))}">${sectionIcon('RotateCcw')}</button>`;
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('.pp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _render();
    });
  });
  el.querySelector('[data-act="reset-print"]')?.addEventListener('click',
    () => SettingsStore.resetSection('print'));

  return el;
}

// ── Scale Tab ─────────────────────────────────────────────

function _renderScaleTab() {
  const state = getState();
  const { workingRatio, targetRatio } = state.print;

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';

  html += `<label>${escapeHtml(t('print.sceneScale'))}</label>`;
  html += '<div class="pp-ratio-select">';
  html += '<select data-field="workingRatio" class="pp-preset-select">';
  html += `<option value="">${escapeHtml(t('print.custom'))}</option>`;
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      const selected = workingRatio === preset.ratio ? ' selected' : '';
      html += `<option value="${escapeAttr(preset.ratio)}"${selected}>${escapeHtml(preset.label)}</option>`;
    }
  }
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-field="workingRatio" value="${escapeAttr(formatScaleRatio(workingRatio))}" placeholder="1:1">`;
  html += '</div>';
  html += `<p class="pp-help">${escapeHtml(t('print.sceneScaleHelp'))}</p>`;

  html += `<label>${escapeHtml(t('print.printScale'))}</label>`;
  html += '<div class="pp-ratio-select">';
  html += '<select data-field="targetRatio" class="pp-preset-select">';
  html += `<option value="">${escapeHtml(t('print.custom'))}</option>`;
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      const selected = targetRatio === preset.ratio ? ' selected' : '';
      html += `<option value="${escapeAttr(preset.ratio)}"${selected}>${escapeHtml(preset.label)}</option>`;
    }
  }
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-field="targetRatio" value="${escapeAttr(formatScaleRatio(targetRatio))}" placeholder="1:35">`;
  html += '</div>';
  html += `<p class="pp-help">${escapeHtml(t('print.printScaleHelp'))}</p>`;

  html += '</div>';

  // Export factor display — single source of truth in PrintScale (review L28).
  const factor = exportFactor();
  html += `<div class="pp-info"><strong>${escapeHtml(t('print.exportScaleLabel'))}</strong> ${factor.toFixed(2)} ${escapeHtml(t('print.exportScaleUnit'))}</div>`;

  // Example dimensions
  const selected = getState().selection.selectedIds;
  if (selected.length > 0) {
    const firstMesh = getState().scene.objects[selected[0]];
    if (firstMesh) {
      const dims = PrintManager.getExportedDimensions(selected[0]);
      if (dims) {
        html += `<div class="pp-info"><strong>${escapeHtml(t('print.exampleActiveLabel'))}</strong> ${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)} mm</div>`;
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
      MeshValidator.invalidateAll();   // exceedsBed depends on targetRatio (A6)
    }
  };

  el.querySelectorAll('.pp-preset-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      if (e.target.value) {
        const val = parseInt(e.target.value, 10);
        applyRatio(field, val);
        el.querySelector(`.pp-ratio-input[data-field="${field}"]`).value = formatScaleRatio(val);
      }
    });
  });

  el.querySelectorAll('.pp-ratio-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      const val = parseScaleRatioText(e.target.value);
      if (!val) { e.target.value = formatScaleRatio(getState().print[field]); return; }
      e.target.value = formatScaleRatio(val);
      applyRatio(field, val);
    });
  });

  return el;
}

// ── Validation Tab ───────────────────────────────────────
// Reads the A6 cache (state.scene.validation) instead of re-running topology
// checks on every render (review M11). "Validate All" refreshes explicitly;
// imports auto-validate already.

function _renderValidationTab() {
  const state = getState();
  const cache = state.scene.validation ?? {};

  // One row per print part; split-group siblings collapse to one display row.
  const rows = [];
  const seenGroups = new Set();
  for (const [meshId, obj] of Object.entries(state.scene.objects)) {
    if (!obj.isPrintPart || obj.isGhost) continue;
    if (obj.sourceGroupId) {
      if (seenGroups.has(obj.sourceGroupId)) continue;
      seenGroups.add(obj.sourceGroupId);
    }
    rows.push({ meshId, obj, entry: cache[meshId] ?? null });
  }

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';
  html += `<button class="pp-export-btn" id="pp-validate-all">${icon('RefreshCw', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.validateAll'))}</button>`;
  html += '</div>';

  if (!rows.length) {
    html += `<p class="pp-empty">${escapeHtml(t('print.noPrintParts'))}</p>`;
  } else {
    for (const { meshId, obj, entry } of rows) {
      const results = entry?.results ?? null;
      const hasErrors = !!results?.some(r => r.severity === 'error');
      const hasWarnings = !hasErrors && !!results?.some(r => r.severity === 'warning');
      const icon_name = !results ? 'Circle' : hasErrors ? 'AlertCircle' : hasWarnings ? 'AlertTriangle' : 'Check';
      const icon_class = !results ? 'pending' : hasErrors ? 'error' : hasWarnings ? 'warning' : 'success';
      const staleBadge = entry?.stale ? ` <span class="pp-stale" title="${escapeAttr(t('print.staleTitle'))}">${escapeHtml(t('print.stale'))}</span>` : '';

      html += `<div class="pp-mesh-validation ${icon_class}">`;
      html += `<div class="pp-mesh-header">`;
      html += `${icon(icon_name, { class: 'inline' })}`;
      html += `<span class="pp-mesh-name">${escapeHtml(obj.name)}</span>${staleBadge}`;
      html += `</div>`;

      if (!results) {
        html += `<p class="pp-hint">${escapeHtml(t('print.notValidated'))}</p>`;
      } else if (results.length > 0) {
        html += '<ul class="pp-result-list">';
        for (const result of results) {
          const canFix = result.autoFixAvailable && !result.fixed;
          html += `<li class="pp-result ${escapeAttr(result.severity)}">`;
          html += `<span>${escapeHtml(result.message)}</span>`;
          if (canFix) {
            html += `<button class="pp-autofix-btn" data-mesh-id="${escapeAttr(meshId)}" data-result-type="${escapeAttr(result.type)}">${escapeHtml(t('print.autoFix'))}</button>`;
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

  el.querySelector('#pp-validate-all')?.addEventListener('click', async () => {
    await MeshValidator.validateAllPrintParts();   // refreshes the cache
    _render();
  });

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
        Toast.show(t('toast.fixed', { name: obj.name }), 'success', 2000);
        _render();
      } catch (err) {
        console.error('Auto-fix failed:', err);
        Toast.show(t('toast.autoFixFailed', { msg: err.message }), 'error', 0);
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
  html += `<label>${escapeHtml(t('print.exportOptions'))}</label>`;

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-selected-only" data-option="selectedOnly">';
  html += `<label for="pp-selected-only">${escapeHtml(t('print.selectedOnly'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-individually" data-option="individually">';
  html += `<label for="pp-individually">${escapeHtml(t('print.eachIndividually'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-bake-solid" ${bakeSolids ? 'checked' : ''}>`;
  html += `<label for="pp-bake-solid">${escapeHtml(t('print.bakeSolids'))}</label>`;
  html += '</div>';

  html += '</div>';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.format'))}</label>`;

  html += `<button class="pp-export-btn pp-export-obj" data-format="obj">`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.exportObj'))}`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-3mf" data-format="3mf">`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.export3mf'))}`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-stl" data-format="stl">`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.exportStl'))}`;
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

  // Wire export buttons. Hard errors are handled INSIDE the export (post
  // auto-fix); cached WARNINGS gate with a confirm first (Blueprint §12
  // export gate, arch B6) — display models are routinely non-watertight, so
  // the default is "export anyway".
  const runExport = async (fn, opts) => {
    if (_printPartsHaveWarnings() && !(await _confirmExportWithWarnings())) return;
    ProgressOverlay.show(t('progress.exporting'));
    try {
      await fn({ ...opts, onProgress: (frac, msg) => ProgressOverlay.update(frac, msg) });
    } catch (err) {
      if (err?.validationErrors?.length) {
        Modal.open('validationErrors', { errors: err.validationErrors });
      } else {
        console.error(err);
        Toast.show(t('toast.error', { msg: err.message }), 'error', 0);
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
  html += `<label>${escapeHtml(t('print.targetPrinter'))}</label>`;
  html += '<select id="pp-printer-select" class="pp-preset-select">';
  for (const [id, p] of Object.entries(PRINTERS)) {
    const sel = id === printerId ? ' selected' : '';
    html += `<option value="${escapeAttr(id)}"${sel}>${escapeHtml(p.displayName)}</option>`;
  }
  html += '</select>';
  const cur = PRINTERS[printerId];
  if (cur) {
    const fmt = cur.format;
    const colorMode = cur.color?.mode;
    html += `<div class="pp-info">${escapeHtml(cur.vendor)} · ${escapeHtml(fmt)} · ${escapeHtml(colorMode)}</div>`;
  }
  html += '</div>';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.buildVolume'))}</label>`;
  html += '<div class="pp-xyz-row">';
  for (const axis of ['x', 'y', 'z']) {
    html += `<label class="pp-xyz">${axis.toUpperCase()}`;
    html += `<input type="number" min="1" step="1" data-bed-axis="${escapeAttr(axis)}" value="${escapeAttr(dims[axis])}"></label>`;
  }
  html += '</div>';
  html += '</div>';

  html += '<div class="pp-field-group">';
  // Viewport visibility = toggle button (checkbox→toggle audit 2026-06-13).
  html += `<button type="button" class="pp-toggle${showVolume ? ' pp-toggle-on' : ''}" id="pp-bed-show" aria-pressed="${showVolume ? 'true' : 'false'}"><span class="pp-toggle-dot" aria-hidden="true"></span>${escapeHtml(t('print.showBedVolume'))}</button>`;
  html += `<div class="pp-info">${escapeHtml(t('print.bedValidationInfo'))}</div>`;
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
    MeshValidator.invalidateAll();   // exceedsBed results depend on bed dims (A6)
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

  el.querySelector('#pp-bed-show').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, bedPreview: on } },
    }), { silent: true });
    SceneManager.setOverlay('bedPreview', on);
    btn.classList.toggle('pp-toggle-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    _bodyEl.appendChild(_renderValidationTab());
  } else if (_activeTab === 'bed') {
    _bodyEl.appendChild(_renderBedTab());
  } else if (_activeTab === 'export') {
    _bodyEl.appendChild(_renderExportTab());
  }
}

// ── Export warning gate (A6 / B6) ────────────────────────

/** True when any print part's cached, non-stale validation carries warnings. */
function _printPartsHaveWarnings() {
  const { objects, validation } = getState().scene;
  for (const [meshId, obj] of Object.entries(objects)) {
    if (!obj.isPrintPart || obj.isGhost) continue;
    const e = validation?.[meshId];
    if (e && !e.stale && e.results.some(r => r.severity === 'warning')) return true;
  }
  return false;
}

function _confirmExportWithWarnings() {
  return new Promise(resolve => {
    Modal.open('exportWarningsConfirm', {
      onClose: (r) => resolve(r === 'export'),
    });
  });
}

function _renderExportWarningsModal({ close }) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="modal-content">
      <h3>${escapeHtml(t('print.validationWarnings'))}</h3>
      <p>${escapeHtml(t('print.validationWarningsBody'))}</p>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">${escapeHtml(t('btn.cancel'))}</button>
        <button class="btn btn-primary" data-action="export">${escapeHtml(t('print.exportAnyway'))}</button>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => close(b.dataset.action)));
  return el;
}

// ── Modals ────────────────────────────────────────────────

function _renderValidationErrorsModal({ data, close }) {
  const errors = data?.errors ?? [];

  let html = '<div class="modal-content">';
  html += `<h3>${escapeHtml(t('print.validationErrors'))}</h3>`;
  html += `<p>${escapeHtml(t('print.validationErrorsBody'))}</p>`;
  html += '<ul>';
  for (const { meshName, message } of errors) {
    html += `<li><strong>${escapeHtml(meshName)}:</strong> ${escapeHtml(message)}</li>`;
  }
  html += '</ul>';
  html += '<div class="modal-actions">';
  html += `<button class="btn btn-primary" data-action="close">${escapeHtml(t('btn.ok'))}</button>`;
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

export const PrintPanel = { init };
