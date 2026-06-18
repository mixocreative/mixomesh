import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { PrintManager, SCALE_PRESETS } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { Toast } from './Toast.js';
import { icon, sectionIcon } from '../core/Icons.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { Workspace } from './Workspace.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import printersData from '../config/printers.json' with { type: 'json' };
import { formatScaleRatio, parseScaleRatioText, exportRatiosFromState } from '../core/scale/ScaleMath.js';
import { shouldDisplayObject } from '../core/LogicalObjects.js';

// Printer profiles maintained in `config/printers.json`; they seed build-area
// reference dimensions only. Export format is chosen by the buttons below.
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
  // Locale changes must rebuild tab/body markup generated from t(), then
  // refresh the static header/body data-i18n attributes in one root walk.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _render(); _retranslate(_root); });

  // Re-render on state changes. (EVENTS.OBJECT_ADDED never existed — the
  // import signal is ASSET_INSTANTIATED; review M11.)
  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.OBJECT_UPDATED,
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
  // Per-object ratio redesign (2026-06-16): scene scale is now PER OBJECT
  // (Properties ▸ Transform ▸ Ratio). This tab manages the export TARGET ratios.
  // An EMPTY list = "as shown" → print at the active printable reference ratio
  // (the size in the viewport). Adding absolute ratios rescales relative to
  // that reference (e.g. 1:144 on a 1:72 object = half). One output per entry.
  //
  // Everything export-shaped (reference, factor, dims) comes from ONE
  // previewExportContext() call so the panel, the export pipeline, and the
  // dimension helper cannot drift.
  const exportRatios = exportRatiosFromState(state);
  const preview = PrintManager.previewExportContext();
  const referenceR = preview?.referenceRatio ?? 1;
  const referenceId = preview?.referenceUnit?.logicalId ?? null;

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';

  html += `<label>${escapeHtml(t('print.printScale'))}</label>`;
  html += '<div class="pp-ratio-list" data-export-ratios>';
  if (exportRatios.length === 0) {
    html += `<span class="pp-ratio-pill is-asshown" title="${escapeAttr(t('print.printScaleHelp'))}">${escapeHtml(t('print.asShown'))} · ${escapeHtml(formatScaleRatio(referenceR))}</span>`;
  } else {
    for (const r of exportRatios) {
      html += `<span class="pp-ratio-pill"><span class="pp-ratio-pill-label">${escapeHtml(formatScaleRatio(r))}</span><button class="pp-ratio-remove" data-remove-ratio="${escapeAttr(r)}" title="${escapeAttr(t('print.removeRatio'))}" aria-label="${escapeAttr(t('print.removeRatio'))}">×</button></span>`;
    }
  }
  html += '</div>';

  html += '<div class="pp-ratio-select">';
  html += '<select data-add-ratio class="pp-preset-select">';
  html += `<option value="">${escapeHtml(t('print.addRatio'))}</option>`;
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      html += `<option value="${escapeAttr(preset.ratio)}">${escapeHtml(preset.label)}</option>`;
    }
  }
  html += `<option value="custom">${escapeHtml(t('print.custom'))}</option>`;
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-add-ratio-input placeholder="${escapeAttr(t('print.customRatioPlaceholder'))}" hidden>`;
  html += '</div>';
  html += `<p class="pp-help">${escapeHtml(t('print.printScaleHelp'))}</p>`;

  html += '</div>';

  // Factor + dims come from the SAME preview context — single source of truth.
  const factor = preview?.factor ?? 0;
  html += `<div class="pp-info"><strong>${escapeHtml(t('print.exportScaleLabel'))}</strong> ${factor.toFixed(2)} ${escapeHtml(t('print.exportScaleUnit'))}</div>`;

  // Example dimensions — show the export reference object so the queried mesh
  // and export factor agree even when the active selection is not printable.
  const exampleId = referenceId ?? state.selection.activeId ?? state.selection.selectedIds?.[0] ?? null;
  if (preview && exampleId && state.scene.objects[exampleId]) {
    const dims = PrintManager.getExportedDimensions(exampleId, preview);
    if (dims) {
      html += `<div class="pp-info"><strong>${escapeHtml(t('print.exampleActiveLabel'))}</strong> ${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)} mm</div>`;
    }
  }

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  const addRatio = (val) => {
    if (!(Number.isFinite(val) && val > 0)) return;
    setState(s => {
      const cur = exportRatiosFromState(s);
      if (cur.includes(val)) return s;
      return { ...s, print: { ...s.print, exportRatios: [...cur, val] } };
    });
    _render();
  };

  const addSel = el.querySelector('[data-add-ratio]');
  const customInput = el.querySelector('[data-add-ratio-input]');
  addSel?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      // Reveal the inline input; reset the select so re-picking Custom re-fires.
      e.target.value = '';
      if (customInput) { customInput.hidden = false; customInput.focus(); }
    } else if (v) {
      addRatio(parseFloat(v));          // preset → add directly (_render rebuilds)
    }
  });
  const commitCustom = () => {
    const val = parseScaleRatioText(customInput.value);
    if (val) addRatio(val);             // valid → add (_render rebuilds, input hides)
    else { customInput.hidden = true; customInput.value = ''; }
  };
  customInput?.addEventListener('change', commitCustom);
  customInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitCustom(); }
    if (e.key === 'Escape') { customInput.hidden = true; customInput.value = ''; }
  });
  el.querySelectorAll('[data-remove-ratio]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseFloat(btn.dataset.removeRatio);
      setState(s => {
        const cur = exportRatiosFromState(s).filter(r => r !== val);
        // Empty ⇒ back to "as shown" (print at the export reference ratio).
        return { ...s, print: { ...s.print, exportRatios: cur } };
      });
      _render();
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
    if (!shouldDisplayObject(obj)) continue;
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
        // Record applied fixes so they survive .mixo reload (M1): the file
        // keeps raw source bytes + ratio, so without this the restored mesh
        // comes back with its original defects. Persistence replays them.
        const applied = results.filter(r => r.fixed).map(r => r.type);
        if (applied.length) {
          setState(s => {
            const o = s.scene.objects[meshId];
            if (!o) return s;
            const fixes = [...new Set([...(o.geometryFixes ?? []), ...applied])];
            return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: { ...o, geometryFixes: fixes } } } };
          }, { silent: true });
        }
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
  const bakeSolids = getState().print?.objBakeSolidTextures ?? false;

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
    html += `<div class="pp-info">${escapeHtml(cur.vendor)} · ${escapeHtml(t('print.buildAreaReference'))}</div>`;
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
    if (e && !e.stale && e.results?.some(r => r.severity === 'warning')) return true;
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
