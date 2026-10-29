import type { SupportPoint } from '../host/core/analysis/types';
import type { Vector } from '../host/core/vec3';

/*
 * Add-tip snapping (the Add tool of Support Edit Mode, from mixodental App.tsx `addTip`): a click
 * lands a manual tip at the hit, or on the nearest suggested or shown tip within Click reach. A snap
 * takes that tip's point and normal, and that tip is deleted in the same step so the two never stand
 * together. A spot that faces up gets a warning. Pure data in, plan out: the app turns the plan into
 * its own commands and maps the status code to a translated line.
 */

/** One click of the Add tool, with everything the snap needs. Positions in mm. */
export interface AddTipInput {
  /** The click, already in the unit's local frame. */
  point: Vector;
  /** The surface normal at the click, in the unit's local frame. */
  normal: Vector;
  /** The surface normal at the click in world space (the plate's up is +y); the facing-up test reads it. */
  worldNormal: Vector;
  /** Click reach: the largest distance (mm) a click snaps over. */
  reach: number;
  /** Automatic contacts and suggested tips on show (`candidate_points` and `suggested_points`), unit-local. */
  candidates: readonly SupportPoint[];
  /** Ids of contacts the user already removed; they never attract a click. */
  removed: ReadonlySet<string>;
  /** Smallest angle (degrees) a tip's surface may make with the plate's up; a smaller one warns. 0 never warns. */
  minFromUpDeg: number;
  /** Id for the new manual tip. */
  createId: () => string;
}

/** Status codes the app maps to translated text. */
export type AddTipStatus = 'added' | 'faces-up';

/** What a click does: add `contact`, delete `removeId` in the same step if set, and say `status`. */
export interface AddTipPlan {
  /** The new manual tip: the click, or a copy of the snapped tip's point and normal, with a fresh id. */
  contact: SupportPoint;
  /** The snapped-to tip to delete in the same step. */
  removeId?: string;
  status: AddTipStatus;
}

/**
 * Plans one Add click (pure). Snaps to the nearest candidate within `reach` mm (distance measured
 * in the unit's local frame, inclusive at `reach`; ties keep the first candidate), skipping removed
 * ids. The facing-up warning always reads the clicked surface's `worldNormal`, also after a snap.
 */
export function planAddTip(input: AddTipInput): AddTipPlan {
  let snapped: SupportPoint | undefined;
  let nearest = Infinity;
  for (const candidate of input.candidates) {
    if (input.removed.has(candidate.id)) continue;
    const apart = Math.hypot(candidate.position[0] - input.point[0], candidate.position[1] - input.point[1], candidate.position[2] - input.point[2]);
    if (apart <= input.reach && apart < nearest) { snapped = candidate; nearest = apart; }
  }
  // regionId -1 and source 'interior' are what every hand-placed contact carries: it belongs to no
  // placement region.
  const contact: SupportPoint = {
    id: input.createId(),
    regionId: -1,
    position: snapped ? [...snapped.position] : [...input.point],
    normal: snapped ? [...snapped.normal] : [...input.normal],
    source: 'interior',
  };
  // Angle from +y (world up), degrees. Assumes a unit normal; the clamp guards acos against
  // rounding just outside [-1, 1].
  const fromUp = Math.acos(Math.max(-1, Math.min(1, input.worldNormal[1]))) * 180 / Math.PI;
  return {
    contact,
    ...(snapped ? { removeId: snapped.id } : {}),
    status: fromUp < input.minFromUpDeg ? 'faces-up' : 'added',
  };
}
