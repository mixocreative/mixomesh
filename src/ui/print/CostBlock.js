/**
 * Export tab ▸ Cost block (watertight-repair-and-cost task 6).
 *
 * Per-user material-cost quote: volume (summed per object, never Boolean-
 * unioned) × density × price + a support-material premium. Recomputes
 * synchronously on every field change and on the same panel-refresh events
 * as the readiness block (PrintPanel.init's event list). `cost.*` settings
 * of 0 mean "use the material default" (config/printers.json `materials[]`).
 *
 * Kept out of PrintPanel.js to keep that file's growth contained — this
 * module owns both the render and the wiring for the block.
 */

import { getState, setState } from '../../core/StateManager.js';
import { SettingsStore } from '../../core/SettingsStore.js';
import { PrintManager } from '../../core/PrintManager.js';
import { quote, unitVolumesMM3, overlappingPairs, totalTriangles, costTriangleCap } from '../../core/print/PrintCost.js';
import { t } from '../../i18n/index.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { wireNumbers, wireSelects } from '../lib/fields.js';
import printersData from '../../config/printers.json' with { type: 'json' };

function _printer(state) {
  const id = state.print?.targetPrinterId;
  return printersData[id] ?? printersData.custom ?? null;
}

function _materials(state) {
  return _printer(state)?.materials ?? [];
}

function _material(state) {
  const materials = _materials(state);
  const wanted = state.cost?.materialId;
  const found = materials.find(m => m.id === wanted);
  if (found) return found;
  // CIA F13: falling back to materials[0] without recording it meant the
  // quote silently used a different material than `cost.materialId` names
  // (e.g. after a printer switch dropped the selected material). Commit the
  // fallback so the select, the quote and the persisted setting agree.
  const fallback = materials[0] ?? null;
  if (fallback && wanted !== fallback.id) {
    setState(st => ({ ...st, cost: { ...st.cost, materialId: fallback.id } }), { silent: true });
  }
  return fallback;
}

/** Map a PrintCost.js reason code → a translated string for the badge title. */
function _reasonText(reason) {
  const nw = /^notWatertight:(\d+)$/.exec(reason);
  if (nw) return t('print.cost.reasonNotWatertight', { n: Number(nw[1]) });
  const nv = /^notValidated:(\d+)$/.exec(reason);
  if (nv) return t('print.cost.reasonNotValidated', { n: Number(nv[1]) });
  const ov = /^overlap:(\d+)$/.exec(reason);
  if (ov) return t('print.cost.reasonOverlap', { n: Number(ov[1]) });
  if (reason === 'noPrice') return t('print.cost.reasonNoPrice');
  if (reason === 'noDensity') return t('print.cost.reasonNoDensity');
  if (reason === 'tooBig') return t('print.cost.reasonTooBig');
  return reason;
}

function _numberField(id, labelKey, value) {
  return `<label class="pp-xyz" for="${id}">${escapeHtml(t(labelKey))}` +
    `<input type="number" min="0" step="0.01" id="${id}" value="${escapeAttr(value || 0)}"></label>`;
}

/**
 * Render + wire the Cost block into `container` (an existing empty element
 * the Export tab appends into). `state` is the current app-state snapshot —
 * the caller already has one from its own render pass.
 *
 * @param {HTMLElement} container
 * @param {object} state
 */
export function renderCostBlock(container, state) {
  const materials = _materials(state);
  const material = _material(state);
  const cost = state.cost ?? {};

  let html = '<div class="pp-field-group pp-cost">';
  html += `<label>${escapeHtml(t('print.cost.title'))}</label>`;

  html += `<label class="pp-cost-sublabel" for="pp-cost-material">${escapeHtml(t('print.cost.material'))}</label>`;
  html += '<select id="pp-cost-material" class="pp-preset-select">';
  for (const m of materials) {
    const sel = m.id === material?.id ? ' selected' : '';
    html += `<option value="${escapeAttr(m.id)}"${sel}>${escapeHtml(m.name)}</option>`;
  }
  html += '</select>';

  html += '<div class="pp-xyz-row">';
  html += _numberField('pp-cost-price', 'print.cost.pricePerGram', cost.pricePerGram);
  html += _numberField('pp-cost-support-price', 'print.cost.supportPrice', cost.supportPricePerGram);
  html += _numberField('pp-cost-support-pct', 'print.cost.supportPercent', cost.supportPercent);
  html += '</div>';

  html += `<label class="pp-cost-sublabel" for="pp-cost-currency">${escapeHtml(t('print.cost.currency'))}</label>`;
  html += `<input type="text" id="pp-cost-currency" class="pp-ratio-input pp-cost-currency" maxlength="4" value="${escapeAttr(cost.currency || 'USD')}">`;

  html += '<div class="pp-info" id="pp-cost-total"></div>';
  html += '</div>';

  container.innerHTML = html;

  const commit = (patch) => {
    setState(s => ({ ...s, cost: { ...s.cost, ...patch } }), { silent: true });
    SettingsStore.save();
    _renderResult(container, getState());
  };

  // Invalid (non-finite) typed value restores the stored number in place —
  // same convention as the Bed tab's XYZ inputs (PrintPanel._renderBedTab).
  const restoreNumber = (key) => (inp) => { inp.value = getState().cost?.[key] ?? 0; };

  wireSelects(container, '#pp-cost-material', (_sel, id) => commit({ materialId: id }));
  wireNumbers(container, '#pp-cost-price', (_inp, v) => commit({ pricePerGram: Math.max(0, v) }),
    { onInvalid: restoreNumber('pricePerGram') });
  wireNumbers(container, '#pp-cost-support-price', (_inp, v) => commit({ supportPricePerGram: Math.max(0, v) }),
    { onInvalid: restoreNumber('supportPricePerGram') });
  wireNumbers(container, '#pp-cost-support-pct', (_inp, v) => commit({ supportPercent: Math.max(0, v) }),
    { onInvalid: restoreNumber('supportPercent') });

  const currencyInput = container.querySelector('#pp-cost-currency');
  currencyInput?.addEventListener('change', () => {
    const v = (currencyInput.value || 'USD').trim().slice(0, 4).toUpperCase() || 'USD';
    currencyInput.value = v;
    commit({ currency: v });
  });

  // Instant recompute while typing: an `input` listener updates ONLY the
  // result line from the live (uncommitted) field values — no settings
  // write, no full block re-render. The `change` handlers above still own
  // committing the value (setState + SettingsStore.save) once the user
  // finishes editing (blur/Enter), which re-renders from the committed state.
  // I10: money-only. The geometry pass (per-vertex volume + AABB overlap) is
  // memoised per ExportContext, so a keystroke never re-walks the scene.
  const livePreview = () => _renderResult(container, getState(), _liveCostOverride(container, getState()));
  for (const sel of ['#pp-cost-price', '#pp-cost-support-price', '#pp-cost-support-pct', '#pp-cost-currency']) {
    container.querySelector(sel)?.addEventListener('input', livePreview);
  }

  _renderResult(container, state);
}

/** Read the cost fields' LIVE (possibly uncommitted) DOM values, falling back to `state.cost`. */
function _liveCostOverride(container, state) {
  const cost = state.cost ?? {};
  const num = (id, fallback) => {
    const v = parseFloat(container.querySelector(id)?.value);
    return Number.isFinite(v) ? Math.max(0, v) : fallback;
  };
  const currencyRaw = container.querySelector('#pp-cost-currency')?.value ?? cost.currency ?? 'USD';
  return {
    pricePerGram: num('#pp-cost-price', cost.pricePerGram || 0),
    supportPricePerGram: num('#pp-cost-support-price', cost.supportPricePerGram || 0),
    supportPercent: num('#pp-cost-support-pct', cost.supportPercent || 0),
    currency: (currencyRaw || 'USD').trim().slice(0, 4).toUpperCase() || 'USD',
  };
}

/**
 * @param {HTMLElement} container
 * @param {object} state
 * @param {object} [override] live (uncommitted) cost field values, for the
 *   `input`-driven preview; omit to use the committed `state.cost`.
 */
// I10: the geometry half of a quote (per-vertex volumes + AABB overlap) is
// the expensive half and depends ONLY on the ExportContext. Memoise it by ctx
// identity so the live `input` preview recomputes money alone. `previewExport
// Context()` builds a fresh frozen ctx per call, so a scene/selection change
// produces a new identity and the cache misses exactly when it should.
let _geomCacheCtx = null;
let _geomCache = null;

function _geometryFor(ctx) {
  if (_geomCacheCtx === ctx && _geomCache) return _geomCache;
  _geomCacheCtx = ctx;
  _geomCache = { vols: unitVolumesMM3(ctx), pairs: overlappingPairs(ctx) };
  return _geomCache;
}

function _renderResult(container, state, override = null) {
  const el = container.querySelector('#pp-cost-total');
  if (!el) return;

  const material = _material(state);
  const cost = { ...(state.cost ?? {}), ...(override ?? {}) };
  const currency = cost.currency || 'USD';

  const ctx = PrintManager.previewExportContext();
  if (!ctx) {
    el.textContent = '—';
    return;
  }

  // The triangle gate inside quote() must run BEFORE any per-vertex work, so
  // the geometry cache is only consulted for a scene the quote will actually
  // measure (quote() itself re-checks and short-circuits).
  const geometry = totalTriangles(ctx) > costTriangleCap() ? null : _geometryFor(ctx);

  const q = quote(ctx, {
    pricePerGram: cost.pricePerGram || 0,
    supportPricePerGram: cost.supportPricePerGram || 0,
    supportPercent: cost.supportPercent || 0,
    currency,
  }, material, geometry);

  if (q.volumeCM3 === null) {
    // Above costTriangleCap() — quote() bailed out before computing
    // anything (PrintCost.js `totalTriangles` gate).
    el.innerHTML = `— <span class="pp-approx" title="${escapeAttr(t('print.cost.reasonTooBig'))}">` +
      `${escapeHtml(t('print.cost.approximate'))}</span>`;
    return;
  }

  const fmt = (v, digits) => (v == null ? '—' : v.toFixed(digits));
  const resultText = t('print.cost.result', {
    volume: fmt(q.volumeCM3, 2),
    grams: fmt(q.grams, 1),
    materialCost: fmt(q.materialCost, 2),
    supportCost: fmt(q.supportCost, 2),
    total: fmt(q.total, 2),
    currency,
  });

  let html = escapeHtml(resultText);
  if (q.approximate) {
    const title = q.reasons.map(_reasonText).join('; ');
    html += ` <span class="pp-approx" title="${escapeAttr(title)}">${escapeHtml(t('print.cost.approximate'))}</span>`;
  }
  el.innerHTML = html;
}
