// Startup notice for an unreadable desktop KV file (cia B-13). Main quarantines
// the file and starts empty; without this the user would silently lose recent
// projects, autosave and preferences.

import { dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { t } from '../../i18n/index.js';

/**
 * Warn once when the storage adapter reports its KV file was quarantined.
 * @param {{ kvDamaged?: () => Promise<boolean> }} adapter
 * @returns {Promise<boolean>} whether the warning was shown
 */
export async function reportKvDamage(adapter) {
  let damaged = false;
  try { damaged = !!(await adapter.kvDamaged?.()); } catch { return false; }
  if (damaged) dispatch(EVENTS.TOAST, { message: t('toast.appDataDamaged'), type: 'warning', duration: 8000 });
  return damaged;
}
