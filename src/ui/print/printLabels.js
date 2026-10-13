/**
 * Shared Print-panel labels: export format names, format detail lines and
 * the "modified from printer default" dot (task 1.3).
 */

import { t } from '../../i18n/index.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';

const FORMAT_NAMES = { obj: 'OBJ', '3mf': '3MF', stl: 'STL', ply: 'PLY', wrl: 'WRL' };

/** Short, language-neutral writer name: "OBJ", "3MF", … */
export function formatLabel(key) {
  return FORMAT_NAMES[key] ?? String(key ?? '').toUpperCase();
}

/** One-line description of what a writer produces (3MF varies by flavour). */
export function formatDetail(key, flavour = 'core') {
  switch (key) {
    case 'obj': return t('print.fmt.obj');
    case '3mf':
      if (flavour === 'bambu') return t('print.fmt.3mf.bambu');
      if (flavour === 'prusa') return t('print.fmt.3mf.prusa');
      return t('print.fmt.3mf.core');
    case 'stl': return t('print.fmt.stl');
    case 'ply': return t('print.fmt.ply');
    case 'wrl': return t('print.fmt.wrl');
    default: return '';
  }
}

/** Translated OBJ axis / 3MF flavour option labels. */
export function objAxisLabel(axis) {
  return axis === 'z-up' ? t('print.objAxis.zUp') : t('print.objAxis.yUp');
}
export function flavourLabel(flavour) {
  if (flavour === 'bambu') return t('print.threeMFFlavour.bambu');
  if (flavour === 'prusa') return t('print.threeMFFlavour.prusa');
  return t('print.threeMFFlavour.core');
}

/**
 * The small "modified" marker beside a profile-driven field; the tooltip
 * names the printer-default value it differs from.
 * @param {string} field
 * @param {string} profileValueText
 */
export function modifiedDot(field, profileValueText) {
  const title = t('print.modifiedTitle', { value: profileValueText });
  return `<span class="pp-modified" data-field="${escapeAttr(field)}" title="${escapeAttr(title)}">`
    + `<span class="pp-modified-dot" aria-hidden="true"></span><span class="pp-modified-text">${escapeHtml(t('print.modified'))}</span></span>`;
}
