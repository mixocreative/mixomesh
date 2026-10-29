// Selection integration of the numeric Transform sheet: one TransformCommand for the current
// selection, pivot-aware, groups rigid, locked items skipped like the gizmo.
import { SceneManager } from '../../core/SceneManager.js';
import { Selection } from '../../core/Selection.js';
import { getState } from '../../core/StateManager.js';
import { TransformCommand } from '../../core/HistoryManager.js';
import { planSheetTransform, isNoopValues, type NodeSnap, type SheetValues } from './sheetPlan.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshotNode(node: any): NodeSnap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (window as any).BABYLON;
  node.computeWorldMatrix(true);
  const aq = node.absoluteRotationQuaternion ?? B.Quaternion.Identity();
  const ap = node.getAbsolutePosition();
  const as = node.absoluteScaling ?? node.scaling;
  return {
    position: { x: ap.x, y: ap.y, z: ap.z },
    rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
    scaling: { x: as.x, y: as.y, z: as.z },
  };
}

export type SheetBuild =
  | { status: 'applied'; command: TransformCommand }
  | { status: 'noop' | 'nothing' | 'locked' };

/**
 * Build ONE TransformCommand for the current selection (groups move rigidly,
 * locked items are skipped exactly like the gizmo). The caller pushes it.
 */
export function buildSheetCommand(values: SheetValues): SheetBuild {
  const { targets, activeNode, activeGeometry, lockedSkipped } =
    Selection.getTransformTargets() as ReturnType<typeof Selection.getTransformTargets> & { lockedSkipped?: number };
  if (!targets.length) return { status: lockedSkipped ? 'locked' : 'nothing' };
  if (isNoopValues(values)) return { status: 'noop' };
  // Canonical parents first, then drop nodes covered by a selected ancestor.
  SceneManager.attachToSelection([], 'median', null);
  const top = SceneManager.topmostTransformTargets(targets, (e: { node: unknown }) => e.node);
  const pivotMode = getState().selection?.pivotMode ?? 'median';
  const pivot = SceneManager.computePivotPosition(
    top.map((e: { node: unknown }) => e.node), pivotMode, activeNode, activeGeometry);
  const entries = top.map(({ id, node }: { id: string; node: unknown }) => ({ id, snap: snapshotNode(node) }));
  const { prev, next } = planSheetTransform(entries, pivot, values);
  return { status: 'applied', command: new TransformCommand(prev, next) };   // applyTransforms re-attaches the pivot
}
