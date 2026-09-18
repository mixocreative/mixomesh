/**
 * RepairFeedback — the ONE place that turns a `MeshValidator.repairObject` /
 * `repairObjects` result into user-visible feedback.
 *
 * Review I7b/I7c: every call site used to fire a `'success'` toast
 * unconditionally, so a repair that changed nothing ("nothing to repair", a
 * multi-part object the old code could not fix at all, a missing engine) read
 * as "✓ Repaired", and a batch with failures showed the success toast AND an
 * error modal. The three honest outcomes are:
 *
 *   • nothing applied           → info, "nothing to repair"
 *   • applied, issues remain    → warning, "still not watertight" (M3)
 *   • applied, clean            → success with the ENGINE's own counters (M2)
 *
 * A batch with failures reports the failures INSTEAD of a success toast.
 */

import { Toast } from './Toast.js';
import { reportError } from './Status.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { t } from '../i18n/index.js';

const OPEN_TYPES = new Set(['holes', 'nonManifold']);

/** True when the post-repair validation still reports open geometry. */
function _stillOpen(remaining) {
  return (remaining ?? []).some(r => OPEN_TYPES.has(r.type));
}

/**
 * Feedback for a single-object repair.
 * @param {string} name object name for the message
 * @param {{holesFilled:number, nmFixed:number, applied:string[], remaining:object[]}} result
 * @param {number} [ms] toast duration for the success case
 */
export function reportRepairResult(name, result, ms = 3000) {
  if (!result?.applied?.length) {
    Toast.show(t('toast.nothingToRepair', { name }), 'info', ms);
    return;
  }
  if (_stillOpen(result.remaining)) {
    Toast.show(t('toast.stillNotWatertight', { name }), 'warning', Math.max(ms, 5000));
    return;
  }
  Toast.show(t('toast.repaired', { name, holes: result.holesFilled, nm: result.nmFixed }), 'success', ms);
}

/**
 * Feedback for a batch repair. Failures are reported INSTEAD of success.
 * @param {number} count objects the batch was asked to repair
 * @param {{holesFilled:number, nmFixed:number, repaired:number, failed:Array<{name:string}>}} result
 */
export function reportBatchRepairResult(count, result) {
  if (result?.failed?.length) {
    reportError(new Error(result.failed.map(f => f.name).join(', ')), { title: t('toast.autoFixFailed') });
    return;
  }
  if (!result?.repaired) {
    Toast.show(t('toast.nothingToRepairBatch', { n: count }), 'info', 3000);
    return;
  }
  Toast.show(
    t('toast.repairedBatch', { n: result.repaired, holes: result.holesFilled, nm: result.nmFixed }),
    'success', 3000,
  );
}

/**
 * Repair `meshIds` under the BLOCKING progress overlay (title, percentage,
 * current object) — the one runner every non-Print-panel surface uses
 * (status-bar badge, Outliner badge, context menu). Owner ask 2026-09-18:
 * while a repair runs the screen is blocked and shows status + percentage;
 * afterwards the outcome is reported (reportBatchRepairResult). Resolves to
 * the RepairSession result; never throws — a failure is reported and
 * `{ failed: [...] }`-shaped result comes back so callers can re-render.
 * @param {string[]} meshIds
 * @param {{ title?: string, onProgress?: (frac:number, name:string) => void }} [opts]
 */
export async function repairWithOverlay(meshIds, opts = {}) {
  const title = opts.title ?? t('print.repairing');
  ProgressOverlay.show(title);
  try {
    const result = await MeshValidator.repairObjects(meshIds, {
      onProgress: (frac, name) => {
        ProgressOverlay.update(frac, name ?? '');
        opts.onProgress?.(frac, name);
      },
    });
    ProgressOverlay.update(1, t('progress.done'));
    reportBatchRepairResult(meshIds.length, result);
    return result;
  } catch (err) {
    reportError(err, { title: t('toast.autoFixFailed') });
    return { holesFilled: 0, nmFixed: 0, repaired: 0, failed: [{ meshId: null, name: '', error: err }] };
  } finally {
    ProgressOverlay.hide();
  }
}
