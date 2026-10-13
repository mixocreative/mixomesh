// t() with an English fallback — for strings whose locale keys are merged
// separately (a missing key makes t() echo the key; show the fallback instead).
import { t } from '../../i18n/index.js';

/**
 * @param {string} key
 * @param {string} fallback
 * @param {Record<string, any>} [params]
 */
export function tr(key, fallback, params) {
  const v = t(key, params);
  return v === key ? fallback : v;
}
