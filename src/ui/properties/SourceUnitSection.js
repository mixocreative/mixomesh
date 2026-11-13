// The Properties panel's "Authored Scale" section: the unit the source file was authored in, and
// the operator's confirmation of it.
//
// One job, and it is the highest-consequence control in the panel: a file carries no reliable unit,
// so the app guesses, and a wrong guess makes a 30 mm crown print at 30 cm. So this section does
// two things on purpose -- it shows the guess with a warning while `unitConfirmed` is false, and it
// lets the operator correct it.
//
// The trap, written where the mistake would be made: changing the unit RE-BAKES vertices. That is
// destructive, so it must go through `SourceUnitCommand` and never through a direct setState --
// the command owns pivot detach, the delta bake and the state update together. `Confirm` is the
// one write here that is NOT a command, because confirming a guess changes no geometry.
//
// SOURCE_UNIT_FACTORS is imported from core/ImportNormalizer.js and never redefined: two tables of
// unit factors is two different answers to "how big is this".
//
// Cut out of PropertiesPanel.js on 2026-11-14, following the refinement/RefinementSection.js
// pattern -- render builds HTML, wire takes the root element and a rerender callback.

import { setState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon, sectionIcon } from '../../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from '../renderSafe.js';
import { Selection } from '../../core/Selection.js';
import { push, SourceUnitCommand } from '../../core/HistoryManager.js';
import { authoredScaleFromAsset, formatScaleRatio } from '../../core/scale/ScaleMath.js';
import { SOURCE_UNIT_FACTORS } from '../../core/ImportNormalizer.js';
import { canFindMoved } from '../../core/persist/AssetResolver.js';
import { runFindMoved } from '../FindMoved.js';

// The order here is the order of the dropdown. Keys are the values ImportNormalizer's
// SOURCE_UNIT_FACTORS is keyed by -- a key that is not in that table silently falls back to
// millimetres, so the two lists have to agree.
const SOURCE_UNIT_LABEL_KEYS = {
  meters:      'unit.meters',
  centimeters: 'unit.centimeters',
  millimeters: 'unit.millimeters',
  inches:      'unit.inches',
  feet:        'unit.feet',
};

export function renderSourceUnitSection(asset) {
  const authoredScale = authoredScaleFromAsset(asset);
  const opts = Object.entries(SOURCE_UNIT_LABEL_KEYS).map(([k, labelKey]) =>
    `<option value="${k}" ${k === asset.sourceUnit ? 'selected' : ''}>${_escape(t(labelKey))}</option>`
  ).join('');
  const warn = asset.unitConfirmed === false
    ? `<span class="pp-warn" title="${escapeAttr(t('properties.sourceUnitUnconfirmed'))}">${icon('AlertTriangle', { width: 12, height: 12 })}</span>`
    : '';
  return `
    <section class="pp-section" data-section="source-unit">
      <header class="pp-section-header">${sectionIcon('Ruler')}${_escape(t('properties.authoredScale'))} ${warn}</header>
      <div class="pp-row">
        <label>${_escape(t('properties.sourceUnit'))}</label>
        <select id="pp-source-unit">${opts}</select>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">${_escape(t('properties.authoredAt', { ratio: formatScaleRatio(authoredScale.authoredRatio) }))}</span>
        <button class="pp-btn" id="pp-confirm-unit" ${asset.unitConfirmed ? 'disabled' : ''}>${_escape(t('properties.confirm'))}</button>
      </div>
      ${canFindMoved(asset.id) ? `<div class="pp-row pp-row-inline">
        <span class="pp-hint">${_escape(t('asset.findMoved.hint'))}</span>
        <button class="pp-btn" id="pp-find-moved">${_escape(t('asset.findMoved.action'))}</button>
      </div>` : ''}
    </section>
  `;
}

/**
 * @param {HTMLElement} root the panel body
 * @param {object} asset
 * @param {() => void} rerender
 */
export function wireSourceUnitSection(root, asset, rerender) {
  const sel = root.querySelector('#pp-source-unit');
  const btn = root.querySelector('#pp-confirm-unit');

  sel?.addEventListener('change', () => {
    const newUnit = sel.value;
    if (newUnit === asset.sourceUnit) return;
    _changeSourceUnit(asset, newUnit, rerender);
  });
  root.querySelector('#pp-find-moved')?.addEventListener('click', async () => {
    if (await runFindMoved(asset.id)) rerender();
  });
  btn?.addEventListener('click', () => {
    setState(s => {
      const a = s.scene.assetLibrary[asset.id];
      if (!a) return s;
      return { ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [asset.id]: { ...a, unitConfirmed: true } } } };
    });
    rerender();
  });
}

function _changeSourceUnit(asset, newUnit, rerender) {
  const oldUnit = asset.sourceUnit;
  const oldF = SOURCE_UNIT_FACTORS[oldUnit] ?? 0.001;
  const newF = SOURCE_UNIT_FACTORS[newUnit] ?? 0.001;
  if (oldF <= 0 || newF <= 0) return;
  if (Math.abs(newF / oldF - 1) < 1e-12) return;

  // Destructive vertex re-bake → must be a command (Blueprint §0.1; review
  // M12). SourceUnitCommand owns pivot detach, delta bake, and state update.
  push(new SourceUnitCommand(asset.id, oldUnit, newUnit));
  Selection.refresh();
  rerender();
}
