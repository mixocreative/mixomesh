import type { Vector } from '../core/vec3';

/*
 * The island report of a denture pose (Rust `dental::denture::island_tips`). An island is a place where the printed
 * surface starts a new region mid-air: the local lowest point of a separate region, which floats unless a support
 * touches it. The engine plans one "island" tip at each island's lowest vertex (rule `islandTips`) and reports every
 * island, tipped or not, with the reason. The host decodes the flat numbers (`DenturePolicyHandle.island_facts()`
 * and the review's `islands()`), and `settleIslands` adds what only the build knows: a planned tip that was left out.
 * Positions are unit-local, mm.
 */

/** Numbers per island in the flat report (Rust `island_tips::ISLAND_STRIDE`). */
export const ISLAND_STRIDE = 9;

/** How an island stands. `leftOut` is set by `settleIslands`, never by the engine's plan. */
export type IslandState = 'tipped' | 'servedNearby' | 'belowMinSize' | 'noSupportZone' | 'outsideAllowed' | 'noFace' | 'touchesPart' | 'leftOut' | 'unknown';

const STATES: readonly IslandState[] = ['tipped', 'servedNearby', 'belowMinSize', 'noSupportZone', 'outsideAllowed', 'noFace', 'touchesPart'];
const REASONS: Record<IslandState, string> = {
  tipped: 'own tip at the lowest point',
  servedNearby: 'served by a tip nearby',
  belowMinSize: 'below min size',
  noSupportZone: 'in no-support zone',
  outsideAllowed: 'outside allowed area',
  noFace: 'no usable face',
  touchesPart: 'touches another part',
  leftOut: 'left out',
  // GEO-005: the sentence says what happened - the engine reported a state this version does not
  // know - rather than guessing which of the eight it meant.
  unknown: 'the engine reported a state this version does not recognise',
};

/** One island, for the review to draw. */
export interface DentureIsland {
  /** The island's lowest point. */
  position: Vector;
  /** Height of that point above the pose's lowest vertex, mm. */
  heightMm: number;
  /** Footprint of the island's lowest slab (rule `islandSlabMm`, 0.2 mm by default) seen from above, mm2: its size. */
  areaMm2: number;
  /** Distance from the lowest point to the nearest planned tip, mm; absent when the pose has no tip. */
  nearestTipMm?: number;
  state: IslandState;
  /** A planned tip serves it (own or nearby) and, after `settleIslands`, was not left out. */
  resolved: boolean;
  /** In words: `own tip at the lowest point`, `served by a tip nearby`, `below min size`, `in no-support zone`, `outside allowed area`, or `left out: <why>`. */
  reason: string;
  /** Index of the serving tip: into the policy's candidates / the review's `tips`. Absent when none serves it. */
  tipIndex?: number;
  /** The mesh face of the island's lowest vertex, absent when it has none usable. */
  face?: number;
}

/** Decodes the engine's flat island report (`ISLAND_STRIDE` numbers per island). */
export function decodeIslands(flat: ArrayLike<number>): DentureIsland[] {
  return Array.from({ length: Math.floor(flat.length / ISLAND_STRIDE) }, (_, k) => {
    const at = k * ISLAND_STRIDE;
    // GEO-005: not `noFace`, which would show the operator a reason the engine never gave.
    const state = STATES[flat[at + 6]!] ?? 'unknown';
    const tip = flat[at + 7]!;
    const face = flat[at + 8]!;
    const nearest = flat[at + 5]!;
    return {
      position: [flat[at]!, flat[at + 1]!, flat[at + 2]!] as Vector,
      heightMm: flat[at + 3]!,
      areaMm2: flat[at + 4]!,
      ...(nearest >= 0 ? { nearestTipMm: nearest } : {}),
      state,
      resolved: state === 'tipped' || state === 'servedNearby',
      reason: REASONS[state],
      ...(tip >= 0 ? { tipIndex: tip } : {}),
      ...(face >= 0 ? { face } : {}),
    };
  });
}

/**
 * Joins the plan to the build: an island whose serving tip the build left out is no longer resolved and says why.
 * `candidateIds` are the policy's candidate ids in order (`PolicyHandle.candidate_ids()`); `leftOut` is the build's
 * list (`GeneratedSupportMesh.leftOut`). The generate island verdict (`mesh.islands`) stays the authority on what
 * the built supports reach; this only explains the tips the plan lost.
 */
export function settleIslands(islands: readonly DentureIsland[], candidateIds: readonly string[], leftOut: readonly { id: string; reason: string }[] = []): DentureIsland[] {
  const lost = new Map(leftOut.map((l) => [l.id, l.reason]));
  return islands.map((island) => {
    const id = island.tipIndex === undefined ? undefined : candidateIds[island.tipIndex];
    const why = id === undefined ? undefined : lost.get(id);
    return why === undefined ? island : { ...island, state: 'leftOut' as const, resolved: false, reason: why ? `left out: ${why}` : 'left out' };
  });
}
