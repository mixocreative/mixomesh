// Triangle budget at import time (heavy-mesh spec §1/§3, watertight-repair-
// and-cost task 7): the pre-parse estimate that refuses before anything is
// parsed, and the warnings that tell the user before the tab starts feeling
// it. The import always proceeds past a warning.

import { assertTriangleCapacity, assertPreParseCapacity, needsExactCount } from '../import/ImportLimits.js';
import { estimateFileTriangles, countFileTriangles } from '../import/TriangleEstimate.js';
import { extOf } from './AssetTypes.js';
import { caps, isDesktop, desktopAppOffered } from '../storage/capabilities.js';
import { t } from '../../i18n/index.js';
import { Toast } from '../../ui/Toast.js';
import { countSceneTriangles, countContainerTriangles, formatTriCount } from '../scene/TriangleCount.js';

/**
 * Pre-parse budget decision: estimate the file's triangles from a few small
 * slices and refuse above 4× the budget (throws the user-readable message)
 * before anything is parsed, hashed or copied. The caller that owns the
 * moment shows the over-budget warning for 'warn'.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<{ verdict: 'ok'|'warn'|'unknown', projected: number }>}
 *   `projected` = scene triangles plus this file's estimate
 */
export async function preParseCheck(blob, filename) {
  const ext = extOf(filename);
  const sceneTriangles = countSceneTriangles();
  let estimate = await estimateFileTriangles(blob, ext);
  if (needsExactCount(estimate, { sceneTriangles, limit: caps.triangleLimit })) {
    estimate = (await countFileTriangles(blob, ext)) ?? estimate;
  }
  const verdict = assertPreParseCapacity(estimate, {
    sceneTriangles, budget: caps.triangleBudget, limit: caps.triangleLimit, filename, desktop: isDesktop(), desktopApp: desktopAppOffered(),
  });
  return { verdict, projected: sceneTriangles + (estimate?.triangles ?? 0) };
}

export function showBudgetWarning(projected) {
  Toast.show(t('toast.triangleBudget', {
    current: formatTriCount(projected),
    budget: formatTriCount(caps.triangleBudget),
  }), 'warning');
}

/**
 * Refuse a container that would push the scene past the hard limit, disposing
 * it. Checked against the container's own meshes since nothing in it has a
 * meshId yet (that lands later, in registerInstantiatedMeshes, after
 * `addAllToScene()`).
 * @param {BABYLON.AssetContainer} container
 */
export function assertContainerCapacity(container) {
  try {
    assertTriangleCapacity(countSceneTriangles() + countContainerTriangles(container), caps.triangleLimit, 'Scene after import');
  } catch (err) {
    try { container.dispose?.(); } catch { /* retain the capacity error */ }
    throw err;
  }
}

/** Non-blocking: warn when the scene plus this container exceeds the soft budget. */
export function warnIfOverBudget(container) {
  const budget = caps.triangleBudget;
  if (!(budget > 0)) return;
  const projectedTris = countSceneTriangles() + countContainerTriangles(container);
  if (projectedTris <= budget) return;
  showBudgetWarning(projectedTris);
}
