/**
 * Print ▸ Export tab (tasks 1.3 + 5.3, plan §4.3).
 *
 * Top to bottom: Print at (+ Other sizes… editor) · Reference [change] (+
 * mixed-scale note) · Format (segmented, EVERY writer; "modified" dot +
 * Printer default ↺ when it differs from the printer profile; OBJ axis / 3MF
 * flavour sub-row) · readiness issues · Cost (per-size lines, settings in a
 * ⚙ popover) · Advanced disclosure · the one primary "Export for <printer>
 * (<FORMAT>)" button, which runs the export gate (errors block; warnings open
 * the three-way modal whose default is Repair & export).
 *
 * Per-project settings (format, axis, flavour, split, individually, bake)
 * change through SetPrintSettingsCommand (undoable, persisted in the .mixo);
 * per-user preferences (strict, repair-on-import) write state + the
 * SettingsStore (Decision 15).
 */

import { getState, setState, markDirty } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon, sectionIcon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { push, SetPrintSettingsCommand } from '../../core/HistoryManager.js';
import { getPrinterProfile, PRINTER_OBJ_AXES, PRINTER_3MF_FLAVOURS } from '../../core/print/PrinterProfiles.js';
import { effectivePrintSettings, modifiedFields, FORMAT_KEYS } from '../../core/print/PrintProfileSettings.js';
import { wireToggles } from '../lib/fields.js';
import { renderCostBlock } from './CostBlock.js';
import { renderIssueList } from './ReadinessStrip.js';
import { printSizesHtml, wirePrintSizes } from './PrintSizes.js';
import { wirePrinterDefault } from './PrinterTab.js';
import { formatLabel, formatDetail, objAxisLabel, flavourLabel, modifiedDot } from './printLabels.js';

// Disclosure state survives the panel's full re-render.
let _advancedOpen = false;

function _checkbox(id, checked, label, extra = '') {
  return `<div class="pp-checkbox"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}>`
    + `<label for="${id}">${escapeHtml(label)}</label>${extra}</div>`;
}

function _formatHtml(eff, mods, profile) {
  let html = '<div class="pp-field-group pp-format">';
  html += '<div class="pp-label-row">';
  html += `<span class="pp-group-label">${escapeHtml(t('print.format'))}${mods.exportFormat ? modifiedDot('exportFormat', formatLabel(mods.exportFormat)) : ''}</span>`;
  if (Object.keys(mods).length) {
    html += `<button type="button" class="pp-link-btn" data-act="printer-default" title="${escapeAttr(t('print.printer.defaultTitle', { printer: profile.displayName }))}">`
      + `${escapeHtml(t('print.printer.default'))}${sectionIcon('RotateCcw')}</button>`;
  }
  html += '</div>';
  html += `<div class="pp-seg pp-format-seg" role="radiogroup" aria-label="${escapeAttr(t('print.formatAria'))}">`;
  for (const key of FORMAT_KEYS) {
    const on = key === eff.exportFormat;
    html += `<button type="button" class="pp-seg-btn${on ? ' active' : ''}" role="radio" aria-checked="${on}" data-fmt="${key}">${escapeHtml(formatLabel(key))}</button>`;
  }
  html += '</div>';
  html += `<p class="pp-help pp-format-detail">${escapeHtml(formatDetail(eff.exportFormat, eff.threeMFFlavour))}</p>`;

  if (eff.exportFormat === 'obj') {
    html += `<div class="pp-row"><label for="pp-obj-axis">${escapeHtml(t('print.objAxis'))}${mods.objAxis ? modifiedDot('objAxis', objAxisLabel(mods.objAxis)) : ''}</label>`;
    html += '<select id="pp-obj-axis" class="pp-preset-select" data-setting="objAxis">';
    for (const axis of PRINTER_OBJ_AXES) html += `<option value="${axis}"${axis === eff.objAxis ? ' selected' : ''}>${escapeHtml(objAxisLabel(axis))}</option>`;
    html += '</select></div>';
  } else if (eff.exportFormat === '3mf') {
    html += `<div class="pp-row"><label for="pp-3mf-flavour">${escapeHtml(t('print.threeMFFlavour'))}${mods.threeMFFlavour ? modifiedDot('threeMFFlavour', flavourLabel(mods.threeMFFlavour)) : ''}</label>`;
    html += '<select id="pp-3mf-flavour" class="pp-preset-select" data-setting="threeMFFlavour">';
    for (const fl of PRINTER_3MF_FLAVOURS) html += `<option value="${fl}"${fl === eff.threeMFFlavour ? ' selected' : ''}>${escapeHtml(flavourLabel(fl))}</option>`;
    html += '</select></div>';
  }
  return `${html}</div>`;
}

function _advancedHtml(print, eff, mods) {
  const flags = [!!print.individually, eff.splitByMaterial, !!print.objBakeSolidTextures, !!print.strictExport];
  const on = flags.filter(Boolean).length;
  let html = '<div class="pp-advanced">';
  html += `<button type="button" class="pp-disclosure" data-act="advanced" aria-expanded="${_advancedOpen}" aria-controls="pp-advanced-body">`
    + `<span class="pp-disclosure-tri" aria-hidden="true"></span>${escapeHtml(t('print.advanced'))}`
    + (on ? `<span class="pp-disclosure-aside">${escapeHtml(t('print.advancedOn', { n: on }))}</span>` : '')
    + '</button>';
  html += `<div class="pp-advanced-body" id="pp-advanced-body"${_advancedOpen ? '' : ' hidden'}>`;
  html += _checkbox('pp-individually', !!print.individually, t('print.eachIndividually'));
  html += _checkbox('pp-split-material', eff.splitByMaterial, t('print.splitByMaterial'),
    mods.splitByMaterial !== undefined ? modifiedDot('splitByMaterial', mods.splitByMaterial ? t('print.on') : t('print.off')) : '');
  html += _checkbox('pp-bake-solid', !!print.objBakeSolidTextures, t('print.bakeSolids'));
  html += _checkbox('pp-strict-export', !!print.strictExport, t('print.strictExport'));
  // Stays here until 5.5 moves it to ? ▸ Preferences.
  html += _checkbox('pp-repair-on-import', !!print.repairOnImport, t('print.repairOnImport'));
  html += '</div></div>';
  return html;
}

/**
 * @param {Object} args
 * @param {Object} args.readiness    PrintManager.getPrintReadiness()
 * @param {Object|null} args.preview previewExportContext({ target: null })
 * @param {(writerKey:string, opts:Object) => void} args.runExport
 * @param {() => void} args.rerender
 * @returns {HTMLElement}
 */
export function renderExportTab({ readiness, preview, runExport, rerender }) {
  const state = getState();
  const print = state.print ?? {};
  const profile = getPrinterProfile(print.targetPrinterId);
  const eff = effectivePrintSettings(print, profile);
  const mods = modifiedFields(print, profile);

  let html = '<div class="pp-tab-content pp-export-tab">';
  html += printSizesHtml({ preview, readiness });
  html += _formatHtml(eff, mods, profile);
  if (readiness.issues.length) html += renderIssueList(readiness);
  html += '<div id="pp-cost-block"></div>';
  html += _advancedHtml(print, eff, mods);

  const label = t('print.exportFor', { printer: profile.displayName, format: formatLabel(eff.exportFormat) });
  const disabled = readiness.canExport ? '' : ` disabled aria-disabled="true" title="${escapeAttr(t('print.exportDisabledTitle'))}"`;
  html += '<div class="pp-export-footer">';
  html += `<button type="button" class="pp-primary-btn" data-act="export-primary" data-export-format="${escapeAttr(eff.exportFormat)}"${disabled}>`
    + `${icon('Download', { class: 'inline', width: 14, height: 14 })}<span class="pp-primary-label">${escapeHtml(label)}</span></button>`;
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  const costMount = el.querySelector('#pp-cost-block');
  if (costMount) renderCostBlock(/** @type {HTMLElement} */ (costMount), state);

  wirePrintSizes(el, rerender);
  wirePrinterDefault(el);

  const setProject = (patch, lbl) => push(new SetPrintSettingsCommand(patch, lbl));

  el.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('click', () => {
    const fmt = /** @type {HTMLElement} */ (btn).dataset.fmt;
    if (fmt && fmt !== effectivePrintSettings(getState().print).exportFormat) setProject({ exportFormat: fmt }, `Export format ${formatLabel(fmt)}`);
  }));
  el.querySelectorAll('select[data-setting]').forEach(sel => sel.addEventListener('change', () => {
    const key = /** @type {HTMLSelectElement} */ (sel).dataset.setting;
    if (key) setProject({ [key]: /** @type {HTMLSelectElement} */ (sel).value }, 'Change export setting');
  }));

  el.querySelector('[data-act="advanced"]')?.addEventListener('click', () => {
    _advancedOpen = !_advancedOpen;
    rerender();
  });
  wireToggles(el, '#pp-individually', (_cb, on) => setProject({ individually: on }, 'Each object as its own file'));
  wireToggles(el, '#pp-split-material', (_cb, on) => setProject({ splitByMaterial: on }, 'Split by material'));
  wireToggles(el, '#pp-bake-solid', (_cb, on) => setProject({ objBakeSolidTextures: on }, 'Bake solid colours'));
  // Per-user preferences (Decision 15): state + SettingsStore (its capture
  // listener on #rp-print-body schedules the save), not project history.
  // markDirty because the current .mixo writer still carries the print slice.
  wireToggles(el, '#pp-strict-export', (_cb, on) => {
    setState(s => ({ ...s, print: { ...s.print, strictExport: on } }), { silent: true });
    markDirty();
    rerender();
  });
  wireToggles(el, '#pp-repair-on-import', (_cb, on) => {
    // Never written into the .mixo (I8) — no dirty mark.
    setState(s => ({ ...s, print: { ...s.print, repairOnImport: on } }), { silent: true });
  });

  el.querySelector('[data-act="export-primary"]')?.addEventListener('click', () => {
    const p = getState().print ?? {};
    runExport(effectivePrintSettings(p).exportFormat, { individually: !!p.individually });
  });
  return el;
}
