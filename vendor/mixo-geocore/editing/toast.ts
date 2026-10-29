import type { EditMode, StatusMessage } from './types';

/** How long an Undo toast stays (the host pauses it while hovered or focused). */
export const UNDO_TOAST_MS = 6000;

/**
 * A destructive action that runs at once (no confirm dialog) and offers Undo for a while:
 * clearing zones or manual edits (one history step), or clearing a selection (view state, so the
 * toast carries the ids to put back).
 */
export type UndoAction =
  /** `hidden`: supports the zones were hiding, which come back. */
  | { kind: 'clearZones'; hidden: number }
  /** Counts of what it took away: supports added, removals, supports with their own settings. */
  | { kind: 'clearManual'; added: number; removed: number; customised: number }
  /** Selected supports follow the defaults again (one history step). */
  | { kind: 'resetCustomised'; count: number }
  /** Supports of `count` objects removed (one history step); the models and hand edits stay. */
  | { kind: 'removeSupports'; count: number }
  /** `count` objects deleted (one history step). */
  | { kind: 'deleteObjects'; count: number }
  /** A project opened over objects (one history step): `name` is the file. */
  | { kind: 'openProject'; name: string }
  | { kind: 'clearSelection'; ids: readonly string[]; unitId: string }
  /** A regeneration landed on an object (one history step): `message` is its report. */
  | { kind: 'regenerate'; message: StatusMessage };

export interface UndoToast {
  id: number;
  action: UndoAction;
  message: StatusMessage;
  /** History actions: the scene right after the action, set on the first render after it. */
  scene?: unknown;
}

export function undoToast(id: number, action: UndoAction): UndoToast {
  const message: StatusMessage = action.kind === 'regenerate'
    ? action.message
    : action.kind === 'openProject'
    ? { key: 'Opened {name}.', vars: { name: action.name } }
    : action.kind === 'clearZones'
    ? (action.hidden === 0 ? { key: 'No-support zones cleared.' } : { key: 'No-support zones cleared; 1 hidden support comes back.', other: 'No-support zones cleared; {n} hidden supports come back.', vars: { n: action.hidden } })
    : action.kind === 'clearManual'
      ? { key: 'Cleared {a} added, {r} removed, {c} customised.', vars: { a: action.added, r: action.removed, c: action.customised } }
      : action.kind === 'resetCustomised'
      ? { key: 'Reset 1 support to the defaults.', other: 'Reset {n} supports to the defaults.', vars: { n: action.count } }
      : action.kind === 'removeSupports'
      ? { key: 'Removed the supports of 1 object; the model and manual edits are kept.', other: 'Removed the supports of {n} objects; the models and manual edits are kept.', vars: { n: action.count } }
      : action.kind === 'deleteObjects'
      ? { key: 'Deleted 1 object.', other: 'Deleted {n} objects.', vars: { n: action.count } }
      : { key: 'Selection of 1 support cleared.', other: 'Selection of {n} supports cleared.', vars: { n: action.ids.length } };
  return { id, action, message };
}

/**
 * Whether the toast's Undo still undoes its action: a history clear while the scene is still the
 * one it produced (any later step would make Undo undo something else); a selection clear while
 * the same object is still in Support Edit Mode with nothing selected since (Undo would otherwise
 * replace the newer selection). A toast that is not alive closes.
 */
export function toastAlive(toast: UndoToast, now: { scene: unknown; mode: EditMode; activeUnitId: string | undefined; selectionSize: number }): boolean {
  if (toast.action.kind === 'clearSelection') return now.mode === 'edit' && now.activeUnitId === toast.action.unitId && now.selectionSize === 0;
  return toast.scene === undefined || toast.scene === now.scene;
}
