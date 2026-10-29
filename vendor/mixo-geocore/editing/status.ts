import { meshTier, TRIANGLE_BUDGET, type Runtime } from '../host/core/budget';
import { gesture, type Gesture } from './gesture';
import { gestureOwner, modeExtension } from './modes';
import { selectsTips, type EditSession, type SessionEvent } from './session';
import type { EditMode, StatusMessage } from './types';

// Status lines are i18n keys (data); the host translates them where they are shown.

/** What a click or drag does now, per gesture: the current tool in Support Edit Mode, the brush in zones mode. */
const GESTURE_STATUS = {
  zones: 'Paint where supports must not grow; drag on the model.',
  add: 'Support Edit Mode: click the model to add, right-click a support to remove.',
  remove: 'Support Edit Mode: click a support, or the model next to one, to remove it.',
  pick: 'Support Edit Mode: click supports to select them, right-click a support to remove.',
  drag: 'Support Edit Mode: drag the circle over supports to select them. Supports hidden behind the model are skipped.',
  dragUnselect: 'Support Edit Mode: drag the circle over supports to unselect them. Supports hidden behind the model are skipped.',
} as const;
const gestureStatus = (press: Gesture): string | undefined => (press.kind === 'none' ? undefined : press.kind === 'add' && press.remove ? GESTURE_STATUS.remove : press.kind === 'drag' && press.brush.mode === 'unselect' ? GESTURE_STATUS.dragUnselect
  : (GESTURE_STATUS as Partial<Record<string, string>>)[press.kind] ?? gestureOwner(press.kind)?.gestureStatus?.[press.kind]);

/**
 * A Support Edit Mode click that hit neither the model nor a support: what to click instead.
 * Nothing in Drag over: a press on empty space turns the view, and a tap on the object already selected what the circle covered.
 */
const MISS_STATUS = {
  add: 'Nothing under the cursor: click the model to add, right-click a support to remove.',
  remove: 'Nothing under the cursor: click a support, or the model next to one, to remove it.',
  pick: 'No support here: click a support to select it.',
} as const;
const missKey = (press: Gesture): string | undefined => (press.kind === 'add' ? MISS_STATUS[press.remove ? 'remove' : 'add'] : press.kind === 'pick' ? MISS_STATUS.pick : undefined);

/** A Drag over press while the object's first supports are still being built (nothing to select yet). */
export const BUILDING_STATUS: StatusMessage = { key: 'Supports are still building.' };

/** What Esc does while supports are selected: the first press clears them, the next one leaves the mode. */
const ESC_AGAIN = 'Esc again to exit';

const keyed = (key: string | undefined): StatusMessage | undefined => (key ? { key } : undefined);

export function editStatus(session: EditSession): StatusMessage | undefined {
  return keyed(gestureStatus(gesture(session)));
}

/** What the status line rests on in a mode: how Esc leaves while supports (or tips) are selected, else the tool line. */
function standingStatus(session: EditSession): StatusMessage | undefined {
  return selectsTips(session) && session.selection.size > 0 ? keyed(ESC_AGAIN) : editStatus(session);
}

/**
 * The status line for one session step (`next` = reduceSession(previous, event)), or undefined to
 * leave it as it is. Entering a mode or switching tool says what a click or drag now does, and
 * while supports are selected it says how Esc leaves; a forced exit (`leave`, the object gone) is
 * left to the host, which says why.
 */
export function sessionStatus(previous: EditSession, next: EditSession, event: SessionEvent): StatusMessage | undefined {
  const entering = (event.type === 'enterEdit' || event.type === 'enterZones') && previous.mode === 'off';
  if (entering && previous.activeUnitId === undefined) return { key: event.type === 'enterEdit' ? 'Select an object to edit its supports.' : 'Select an object first.' };
  if (entering && previous.heavy !== undefined) return heavyStatus(previous);
  if (event.type === 'exit' && next.mode === 'off') {
    if (previous.mode === 'edit') return { key: 'Support edits kept.' };
    if (previous.mode === 'zones') return { key: 'No-support zones kept.' };
    const left = modeExtension(previous.mode)?.exitStatus;
    if (left) return left;
  }
  if (next.mode === 'off' || next === previous) return undefined;
  if (next.mode === previous.mode && modeExtension(next.mode)?.restatesStatus?.(previous, next)) return standingStatus(next);
  const now = standingStatus(next);
  return next.mode !== previous.mode || now?.key !== standingStatus(previous)?.key ? now : undefined;
}

export function missStatus(session: EditSession): StatusMessage | undefined {
  return keyed(missKey(gesture(session)));
}

/** Why a heavy active object takes no hand edits, and what still works; undefined when it is not heavy. */
export function heavyStatus(session: EditSession): StatusMessage | undefined {
  if (session.heavy === undefined) return undefined;
  return { key: 'Too detailed to edit by hand ({n} triangles). Generate and export still use the full model.', vars: { n: session.heavy.toLocaleString() } };
}

/** Another object was picked while a mode is on: finish the mode first. */
export function busyStatus(mode: Exclude<EditMode, 'off'>): StatusMessage {
  const own = modeExtension(mode)?.busy;
  if (own) return own;
  return { key: mode === 'zones' ? 'Finish painting zones first: press Esc or Done.' : 'Finish editing supports first: press Esc or Done.' };
}

/** A file dropped or chosen while a mode is on: refused with the busy line, the mode stays; undefined outside the modes. */
export function importRefusal(mode: EditMode): StatusMessage | undefined {
  return mode === 'off' ? undefined : busyStatus(mode);
}

/**
 * The status line after an import added `added` objects: a heavy or large model, or a plate over the
 * triangle budget, says once what the editor does differently; else how many came in.
 */
export function importStatus(heaviest: { name: string; triangles: number }, plateTriangles: number, added: number, runtime: Runtime): StatusMessage {
  const budget = TRIANGLE_BUDGET[runtime];
  const tier = meshTier(heaviest.triangles, runtime);
  const vars = { name: heaviest.name, n: heaviest.triangles.toLocaleString(), budget: budget.toLocaleString() };
  if (tier === 'heavy') return { key: '{name} is a heavy model ({n} triangles, over {budget}): the view shows a simplified copy and hand editing is off. Generate and export use the full model.', vars };
  // The plate warning wins over the large-model note.
  if (plateTriangles > budget) return { key: 'The plate now holds {n} triangles, more than the {budget} this app is tuned for; it may slow down.', vars: { n: plateTriangles.toLocaleString(), budget: budget.toLocaleString() } };
  if (tier === 'large') return { key: '{name} is a large model ({n} triangles). If the view gets slow, turn on Tips only.', vars };
  return { key: 'Imported 1 object. Generate to place supports.', vars: { n: added }, other: 'Imported {n} objects. Generate to place supports.' };
}
