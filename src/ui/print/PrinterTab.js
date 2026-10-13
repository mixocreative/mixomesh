/**
 * Print ▸ Printer tab (task 1.2, Decision 32).
 *
 * Grouped printer select (by vendor, printers.json v2 order), build volume
 * (a readout for a named printer; editable for Custom), the colour
 * capability sentence, the recommended format, "Profile defaults applied ·
 * Printer default ↺", the viewport bed-volume toggle and a quiet "Continue to
 * Export". Selecting a printer runs ApplyPrinterProfileCommand (one undo
 * step) — it is an apply-defaults action, not a passive label.
 */

import { getState, setState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon, sectionIcon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { SceneManager } from '../../core/SceneManager.js';
import { push, ApplyPrinterProfileCommand, SetPrintSettingsCommand } from '../../core/HistoryManager.js';
import { getPrinterProfile, listPrinterProfiles } from '../../core/print/PrinterProfiles.js';
import { profileDefaults, modifiedFields, isFiniteBed, formatKeyOf } from '../../core/print/PrintProfileSettings.js';
import { wireNumbers, wireToggles, reflectToggle } from '../lib/fields.js';
import { formatLabel, formatDetail, modifiedDot } from './printLabels.js';

/** Translated process name ("UV inkjet", "FDM multi-material", …). */
function _processLabel(process) {
  switch (process) {
    case 'uv-inkjet': return t('print.printer.process.uv-inkjet');
    case 'polyjet': return t('print.printer.process.polyjet');
    case 'mjf': return t('print.printer.process.mjf');
    case 'fdm-multi': return t('print.printer.process.fdm-multi');
    case 'resin': return t('print.printer.process.resin');
    case 'sls': return t('print.printer.process.sls');
    default: return t('print.printer.process.fdm');
  }
}

/** The colour capability sentence for a profile's `colour.mode`. */
function _colourSentence(mode) {
  switch (mode) {
    case 'texture': return t('print.printer.colourMode.texture');
    case 'vertex': return t('print.printer.colourMode.vertex');
    case 'per-part': return t('print.printer.colourMode.per-part');
    case 'paint': return t('print.printer.colourMode.paint');
    default: return t('print.printer.colourMode.none');
  }
}

function _axisText(v) {
  return Number.isFinite(v) && v > 0 ? `${v}` : t('print.printer.unlimited');
}

/** Printer select grouped by vendor (first-appearance order of printers.json). */
function _printerSelectHtml(currentId) {
  const groups = new Map();
  for (const p of listPrinterProfiles()) {
    if (!groups.has(p.vendor)) groups.set(p.vendor, []);
    groups.get(p.vendor).push(p);
  }
  let html = `<select id="pp-printer-select" class="pp-preset-select" aria-label="${escapeAttr(t('print.printer.label'))}">`;
  for (const [vendor, list] of groups) {
    html += `<optgroup label="${escapeAttr(vendor === '—' ? t('print.printer.otherVendor') : vendor)}">`;
    for (const p of list) {
      html += `<option value="${escapeAttr(p.id)}"${p.id === currentId ? ' selected' : ''}>${escapeHtml(p.displayName)}</option>`;
    }
    html += '</optgroup>';
  }
  return `${html}</select>`;
}

/**
 * "Profile defaults applied" / "Modified (n)" + Printer default ↺ — shared by
 * the Printer and Export tabs so the revert is reachable wherever an
 * override is visible.
 */
export function profileStatusHtml(print, profile) {
  const mods = modifiedFields(print, profile);
  const n = Object.keys(mods).length;
  let html = `<div class="pp-profile-status${n ? ' is-modified' : ''}">`;
  html += `<span class="pp-profile-state"><span class="pp-state-dot" aria-hidden="true"></span>${escapeHtml(n ? t('print.printer.modifiedN', { n }) : t('print.printer.defaultsApplied'))}</span>`;
  if (n) {
    html += `<button type="button" class="pp-link-btn" data-act="printer-default" title="${escapeAttr(t('print.printer.defaultTitle', { printer: profile.displayName }))}">`
      + `${escapeHtml(t('print.printer.default'))}${sectionIcon('RotateCcw')}</button>`;
  }
  return `${html}</div>`;
}

/** Wire every Printer default ↺ under `root` (re-applies the CURRENT printer's profile). */
export function wirePrinterDefault(root) {
  root.querySelectorAll('[data-act="printer-default"]').forEach(btn => btn.addEventListener('click', () => {
    push(new ApplyPrinterProfileCommand(getState().print.targetPrinterId));
  }));
}

/**
 * @param {{ goExport: () => void }} hooks
 * @returns {HTMLElement}
 */
export function renderPrinterTab(hooks) {
  const state = getState();
  const print = state.print;
  const profile = getPrinterProfile(print.targetPrinterId);
  const defaults = profileDefaults(profile);
  const mods = modifiedFields(print, profile);
  const dims = print.bedDimensions ?? {};
  const showVolume = state.scene.overlays.bedPreview ?? false;
  const custom = !isFiniteBed(profile.bed);

  let html = '<div class="pp-tab-content pp-printer-tab">';

  html += '<div class="pp-field-group">';
  html += `<div class="pp-label-row"><label for="pp-printer-select">${escapeHtml(t('print.printer.label'))}</label>`
    + `<span class="pp-label-aside">${escapeHtml(_processLabel(profile.process))}</span></div>`;
  html += _printerSelectHtml(profile.id);
  html += '</div>';

  html += '<dl class="pp-spec">';
  html += `<dt>${escapeHtml(t('print.printer.buildVolume'))}${mods.bedDimensions ? modifiedDot('bedDimensions', ['x', 'y', 'z'].map(a => mods.bedDimensions[a]).join(' × ') + ' mm') : ''}</dt>`;
  if (custom) {
    html += '<dd><div class="pp-xyz-row">';
    for (const axis of ['x', 'y', 'z']) {
      html += `<label class="pp-xyz">${axis.toUpperCase()}<input type="number" min="1" step="1" data-bed-axis="${escapeAttr(axis)}" value="${escapeAttr(dims[axis] ?? '')}" placeholder="${escapeAttr(t('print.printer.unlimited'))}"></label>`;
    }
    html += '</div></dd>';
  } else {
    html += `<dd><span class="pp-num" data-readout="bed">${escapeHtml(['x', 'y', 'z'].map(a => _axisText(dims[a])).join(' × '))} mm</span></dd>`;
  }
  html += `<dt>${escapeHtml(t('print.printer.colour'))}</dt><dd>${escapeHtml(_colourSentence(profile.colour?.mode))}</dd>`;
  const rec = formatKeyOf(profile.export?.recommended) ?? defaults.exportFormat;
  html += `<dt>${escapeHtml(t('print.printer.format'))}</dt><dd><span class="pp-format-name">${escapeHtml(formatLabel(rec))}</span>`
    + `<span class="pp-spec-sub">${escapeHtml(formatDetail(rec, defaults.threeMFFlavour))}</span></dd>`;
  html += '</dl>';

  html += profileStatusHtml(print, profile);

  html += '<div class="pp-field-group">';
  // Viewport visibility = toggle button (checkbox→toggle audit 2026-06-13).
  html += `<button type="button" class="pp-toggle${showVolume ? ' pp-toggle-on' : ''}" id="pp-bed-show" aria-pressed="${showVolume ? 'true' : 'false'}"><span class="pp-toggle-dot" aria-hidden="true"></span>${escapeHtml(t('print.showBedVolume'))}</button>`;
  html += '</div>';

  html += `<button type="button" class="pp-quiet-btn" data-act="go-export">${escapeHtml(t('print.printer.continue'))}${icon('ChevronRight', { class: 'inline', width: 14, height: 14 })}</button>`;
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Selecting a printer APPLIES its profile (one undo step; Ctrl+Z restores
  // the previous printer + settings). HISTORY_PUSHED re-renders the panel.
  el.querySelector('#pp-printer-select')?.addEventListener('change', (e) => {
    const id = /** @type {HTMLSelectElement} */ (e.target).value;
    if (id) push(new ApplyPrinterProfileCommand(id));
  });

  // Custom bed: invalid / non-positive restores the stored value in place
  // (the user keeps focus to retype).
  const restoreBedAxis = (inp) => { inp.value = getState().print.bedDimensions?.[inp.dataset.bedAxis] ?? ''; };
  wireNumbers(el, '[data-bed-axis]', (inp, v) => {
    if (!(v > 0)) { restoreBedAxis(inp); return; }
    const bed = { ...getState().print.bedDimensions, [inp.dataset.bedAxis]: v };
    push(new SetPrintSettingsCommand({ bedDimensions: bed }, 'Change build volume'));
  }, { onInvalid: restoreBedAxis });

  wireToggles(el, '#pp-bed-show', (btn, on) => {
    setState(s => ({ ...s, scene: { ...s.scene, overlays: { ...s.scene.overlays, bedPreview: on } } }), { silent: true });
    SceneManager.setOverlay('bedPreview', on);
    reflectToggle(btn, on);
  });

  wirePrinterDefault(el);
  el.querySelector('[data-act="go-export"]')?.addEventListener('click', () => hooks.goExport());
  return el;
}
