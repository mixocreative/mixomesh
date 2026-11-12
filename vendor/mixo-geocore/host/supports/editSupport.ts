import { packRules, type GenerateRules } from './generateRules';
import type { LiveSupportSettings } from '../core/supports/settings';
import type { ZoneStamp } from '../core/supports/zones';
import { packSettings, packZones } from './supportBuildWasm';

/*
 * Live edit of one support. The user drags a pillar on the plate; the tip of the support stays
 * where it is and the support re-routes to the new pillar spot (`rerouteSupport`). While dragging,
 * the plate is shaded where a pillar may stand (`pillarReach`).
 */

export type PieceKind = 'tip' | 'neck' | 'rod' | 'transition' | 'trunk' | 'joint' | 'brace' | 'foot' | 'unknown';
const KINDS: readonly PieceKind[] = ['tip', 'neck', 'rod', 'transition', 'trunk', 'joint', 'brace', 'foot'];
const PIECE_STRIDE = 9;
const LANDING_TIERS = [undefined, 'allowed', 'other', 'no-support'] as const;

/** One part of a support's skeleton: a cone or rod from point `a` (radius `ra`) to point `b` (radius `rb`), in the plate frame. */
export interface SkeletonPiece {
  kind: PieceKind;
  a: [number, number, number];
  b: [number, number, number];
  ra: number;
  rb: number;
}

/** Where a model-landed support (dental option `allowModelLanding`) ends: the tier (allowed area, other surface, no-support zone) and the landing point. */
export interface ModelLanding {
  tier: 'allowed' | 'other' | 'no-support';
  position: [number, number, number];
}

/** The re-routed support as pieces (`landing` set when it ends on the model instead of the plate), or the reason the engine refused the spot. */
export type RerouteResult = { pieces: SkeletonPiece[]; landing?: ModelLanding } | { refusal: string };

/** Where a pillar may stand: a grid on the plate starting at (x0, z0), `cell` mm apart, `nx` by `nz` cells. */
export interface ReachMask {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** 1 where a pillar may stand, row-major (rows of x, one row per z). */
  cells: Uint8Array;
  /** True when the plate point (x, z) lies on an allowed cell; false outside the grid. */
  at(x: number, z: number): boolean;
}

interface EditAnswer { take_pieces(): Float64Array; refusal(): string; landing_tier(): number; landing_point(): Float64Array; free(): void }

/** A `PolicyHandle` of the wasm module, opaque here (made by `denture_policy`, or `empty_policy()` when the call does not use it). */
export type PolicyHandleLike = object;

/** The two `GeometrySession` calls used here. */
export interface EditSession {
  reroute_support(model: number, settings: Float64Array, rules: Float64Array, tip: Float64Array, normal: Float64Array, x: number, z: number, plateY: number,
      allowModelLanding: boolean, policy: PolicyHandleLike, zones: Float64Array): EditAnswer;
  empty_policy(): PolicyHandleLike;
  pillar_reach(model: number, settings: Float64Array, rules: Float64Array, tip: Float64Array, normal: Float64Array, plateY: number, radiusMm: number, gridMm: number, judged: boolean): EditAnswer;
}

/** The dental option "support from the model's own surface" for one tip (`RerouteOptions.allowModelLanding`). */
export interface AllowModelLanding {
  /** The unit's denture policy (it carries the allowed-area and no-support faces the landing order reads). */
  policy: PolicyHandleLike;
  /** The painted no-support zones of the unit (the last landing tier). */
  zones?: readonly ZoneStamp[];
}

export interface EditOptions {
  rules?: GenerateRules;
  /** Height of the plate surface (default 0). */
  plateY?: number;
}

export interface RerouteOptions extends EditOptions {
  /**
   * Turn a tip the plate cannot support into a model-landed support, in milliseconds: when the pillar spot is refused (or `pillarXZ` is
   * null), the column ends on the model's own surface (allowed area, then other surface, then the no-support zone). Dentures only.
   */
  allowModelLanding?: AllowModelLanding;
}

export interface ReachOptions extends EditOptions {
  /** How far around the tip's own spot to look (default 20 mm). */
  radiusMm?: number;
  /** Grid spacing (default 1 mm). */
  gridMm?: number;
  /** True to judge each cell with the full check (slower, exact); false for the quick test (default). */
  judged?: boolean;
}

/** Turns the engine's flat piece array (9 numbers per piece) into pieces. */
export function decodePieces(flat: Float64Array): SkeletonPiece[] {
  const out: SkeletonPiece[] = [];
  for (let i = 0; i + PIECE_STRIDE <= flat.length; i += PIECE_STRIDE) {
    out.push({
      kind: KINDS[flat[i]!] ?? 'unknown',
      a: [flat[i + 1]!, flat[i + 2]!, flat[i + 3]!],
      b: [flat[i + 4]!, flat[i + 5]!, flat[i + 6]!],
      ra: flat[i + 7]!, rb: flat[i + 8]!,
    });
  }
  return out;
}

/** Turns the engine's flat mask array [x0, z0, cell, nx, nz, cells...] into a `ReachMask`. */
export function decodeMask(flat: Float64Array): ReachMask {
  const [x0 = 0, z0 = 0, cell = 1, nx = 0, nz = 0] = flat;
  const cells = new Uint8Array(nx * nz);
  for (let i = 0; i < cells.length; i += 1) cells[i] = flat[5 + i] ? 1 : 0;
  return {
    x0, z0, cell, nx, nz, cells,
    at(x, z) {
      const ix = Math.floor((x - x0) / cell), iz = Math.floor((z - z0) / cell);
      return ix >= 0 && iz >= 0 && ix < nx && iz < nz && cells[iz * nx + ix] === 1;
    },
  };
}

/** Moves the pillar of the support whose tip is at `tip` (normal `normal`) to plate spot `pillarXZ` (null: none) and returns the new skeleton, or why not. With `options.allowModelLanding` a refused spot falls to a column on the model's surface. */
export function rerouteSupport(session: EditSession, model: number, settings: Readonly<LiveSupportSettings>, tip: readonly [number, number, number],
  normal: readonly [number, number, number], pillarXZ: readonly [number, number] | null, options: RerouteOptions = {}): RerouteResult {
  const landing = options.allowModelLanding;
  const answer = session.reroute_support(model, packSettings(settings), packRules(options.rules), Float64Array.from(tip), Float64Array.from(normal),
    pillarXZ ? pillarXZ[0] : NaN, pillarXZ ? pillarXZ[1] : NaN, options.plateY ?? 0,
    landing !== undefined, landing?.policy ?? session.empty_policy(), packZones(landing?.zones ?? []));
  try {
    const refusal = answer.refusal();
    const pieces = decodePieces(answer.take_pieces());
    if (refusal !== '' || pieces.length === 0) return { refusal: refusal || 'no route' };
    const tier = LANDING_TIERS[answer.landing_tier()];
    const at = answer.landing_point();
    return tier && at.length === 3 ? { pieces, landing: { tier, position: [at[0]!, at[1]!, at[2]!] } } : { pieces };
  } finally {
    answer.free();
  }
}

/** The plate shading for one support: where its pillar may stand. */
export function pillarReach(session: EditSession, model: number, settings: Readonly<LiveSupportSettings>, tip: readonly [number, number, number],
  normal: readonly [number, number, number], options: ReachOptions = {}): ReachMask {
  const answer = session.pillar_reach(model, packSettings(settings), packRules(options.rules), Float64Array.from(tip), Float64Array.from(normal),
    options.plateY ?? 0, options.radiusMm ?? 20, options.gridMm ?? 1, options.judged ?? false);
  try {
    return decodeMask(answer.take_pieces());
  } finally {
    answer.free();
  }
}
