import { Toast } from '../../ui/Toast.js';
import { t } from '../../i18n/index.js';
import { storage } from '../storage/StorageAdapter.js';

/**
 * Hand a blob to the user through the active StorageAdapter (task 4.4):
 * browser = File System Access save picker, anchor download when there is no
 * picker; desktop = native save dialog written by the main process.
 * @returns {Promise<boolean>} true when written / handed to the browser,
 *   false when the user cancelled the picker. Callers must not report
 *   success on false (audit 2026-09-17 H6: cancel used to toast "✓ Exported").
 */
export async function triggerDownload(blob, suggestedName, hint = {}) {
  try {
    return await storage.saveExport(blob, suggestedName, hint);
  } catch (err) {
    console.error('Save dialog failed, falling back to a download:', err);
    Toast.show(`${t('toast.operationFailed')}: ${err?.message ?? err}`, 'warning', 4000);
    return storage.saveExport(blob, suggestedName, { ...hint, forceDownload: true });
  }
}
