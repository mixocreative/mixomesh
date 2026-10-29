import type { SupportContact } from '../host/core/supports/mesh';
import type { BrushMode } from './types';

/** What Drag over draws over the selection while the circle hovers. */
export interface BrushPreview {
  /** Supports drawn selected (solid red). */
  solid: ReadonlySet<string>;
  /** Supports drawn see-through: the ones the circle would change. */
  ghost: readonly string[];
  /** Red for the ones Select would add, grey for the ones Unselect would take out. */
  ghostTone: 'remove' | 'ring';
}

/**
 * The hover preview for the supports under the circle (`brushed`). Select shows only the ones it
 * would add: a selected one keeps its solid red. Unselect shows the selected ones under the
 * circle in grey, taken off the solid red. The filters matter for the render after a commit,
 * while `brushed` still holds what the hover found against the older selection.
 */
export function brushPreview(selection: ReadonlySet<string>, brushed: readonly string[], mode: BrushMode | undefined): BrushPreview {
  if (mode !== 'unselect') return { solid: selection, ghost: brushed.filter((id) => !selection.has(id)), ghostTone: 'remove' };
  const ghost = brushed.filter((id) => selection.has(id));
  if (ghost.length === 0) return { solid: selection, ghost, ghostTone: 'ring' };
  const solid = new Set(selection);
  for (const id of ghost) solid.delete(id);
  return { solid, ghost, ghostTone: 'ring' };
}

/**
 * What a Drag over stroke does now: the switch's choice (`brushMode`), flipped while Shift is
 * held. The switch keeps its own choice, so releasing Shift brings it back.
 */
export function effectiveBrushMode(brushMode: BrushMode, shiftHeld: boolean): BrushMode {
  if (!shiftHeld) return brushMode;
  return brushMode === 'select' ? 'unselect' : 'select';
}

export function paintSelection(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  mode: BrushMode,
): ReadonlySet<string> {
  const adding = mode === 'select';
  if (!ids.some((id) => selected.has(id) !== adding)) return selected;
  const next = new Set(selected);
  for (const id of ids) {
    if (adding) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function pruneSelection(
  selected: ReadonlySet<string>,
  contacts: readonly SupportContact[],
): ReadonlySet<string> {
  const alive = new Set(contacts.map((contact) => contact.id));
  const kept = [...selected].filter((id) => alive.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}
