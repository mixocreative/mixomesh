import { withDentalMesh, type DentalTiltScanResultLike } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';
import type { Vector } from '../core/vec3';

/*
 * The print-angle search (Rust `dental/tilt.rs`, docs/ROADMAP.md F): every tilt of the aligner
 * type's range, judged by four hard rules, the pick and the stable band. The host only decodes it.
 */

/** The hard rules, in the order of the Rust flag bits. */
export const TILT_RULES = ['resin-trap', 'rim-gap', 'crossing', 'too-thin'] as const;
/** One of the `TILT_RULES`. */
export type TiltRule = (typeof TILT_RULES)[number];

/** One tilt of the scan with what the rules measured there (lengths mm, area mm2). */
export interface TiltRow {
  tiltDeg: number;
  /** Steps from the start tilt. */
  step: number;
  /** The rules this tilt fails, with the first failing vertex (resin trap) or tip id. */
  failed: { rule: TiltRule; at: string }[];
  fittingSideTips: number;
  largestGapMm: number;
  largestSlenderness: number;
  largestLayerMm2: number;
  heightMm: number;
  robust: boolean;
  /** Euler XYZ radians turning the aligner into this pose (as the orient result). */
  rotation: Vector;
}

/** Why the pick was made: a robust tilt exists, only a passing one, or no tilt passes. */
export type TiltPickReason = 'robust' | 'passing' | 'failing' | 'unknown';

/** A lowest point no support can reach at the picked tilt (denture scan): where it is (mesh frame, mm) and why. */
export interface BoxedPoint {
  point: Vector;
  reason: string;
}

/**
 * What the denture scan's boxed-in check found (Rust `dental::denture::tilt_reach`): per row, the number of lowest points no
 * support can reach at that tilt, and the picked row's points so the review can mark them. Both empty for the aligner scan
 * and when the rule `boxedInTiltWeight` is 0.
 */
export interface BoxedReport {
  counts: number[];
  picked: BoxedPoint[];
  /** Per row, only when the rule `landingTiltWeight` is above 0 (engine 32): lowest points without a path, tips without a path, tips with only a fallback path, tips. */
  /** Per row, how many lowest points the tilt pick counted (engine 35; empty when no lowest-point score is on). */
  lows: number[];
  /** Per row [tips needed, tips in unwanted areas], flat; only with the rule tiltPickOrder 1 (engine 35). */
  tips: number[];
  paths: Array<{ lowsWithout: number; without: number; fallbacks: number; tips: number }>;
}

/**
 * The decoded scan: rows, `order` (row indices in pick order, the pick first), the pick reason and
 * `band` (first and last row index of the robust run containing the pick), or why it failed.
 */
export type TiltScan =
  | { kind: 'scan'; startDeg: number; rows: TiltRow[]; order: number[]; reason: TiltPickReason; band: [number, number] | undefined; boxed: BoxedReport }
  | { kind: 'failed'; reason: string };

/** The host's current support settings the rules read. */
export interface TiltScanSettings {
  neckLengthMm: number;
  pillarDiameterMm: number;
  liftMm: number;
  braced: boolean;
  /** The support-rule overrides (`packRules`, `RULE_NAMES` order) for the denture scan; absent keeps the engine's defaults. */
  rules?: Float64Array;
}

// Row layout (f64 x ROW): 0 tilt deg, 1 step, 2 failed-rule bits (TILT_RULES order), 3 fitting-side
// tips, 4 largest gap mm, 5 largest slenderness, 6 largest layer mm2, 7 height mm, 8 robust 0/1,
// 9-11 rotation (Euler XYZ radians). `failing()` holds 4 strings per row, one per rule bit.
const ROW = 12;
const REASONS: readonly TiltPickReason[] = ['robust', 'passing', 'failing'];

function decodeBoxed(result: DentalTiltScanResultLike): BoxedReport {
  const counts = result.boxed_counts ? [...result.boxed_counts()] : [];
  const flat = result.boxed_points ? result.boxed_points() : new Float64Array();
  const reasons = result.boxed_reasons ? result.boxed_reasons() : [];
  const picked: BoxedPoint[] = [];
  for (let at = 0; at * 3 < flat.length; at++) picked.push({ point: [flat[at * 3]!, flat[at * 3 + 1]!, flat[at * 3 + 2]!], reason: reasons[at] ?? '' });
  const flatPaths = result.path_counts ? result.path_counts() : new Uint32Array();
  const paths: BoxedReport['paths'] = [];
  for (let at = 0; at * 4 < flatPaths.length; at++) paths.push({ lowsWithout: flatPaths[at * 4]!, without: flatPaths[at * 4 + 1]!, fallbacks: flatPaths[at * 4 + 2]!, tips: flatPaths[at * 4 + 3]! });
  const lows = result.counted_lows ? Array.from(result.counted_lows()) : [];
  const tips = result.tip_counts ? Array.from(result.tip_counts()) : [];
  return { counts, picked, paths, lows, tips };
}

/** Decodes and frees a `dental_tilt_scan` result. */
export function decodeTiltScan(result: DentalTiltScanResultLike): TiltScan {
  try {
    if (!result.ok()) return { kind: 'failed', reason: result.reason() };
    const values = result.rows();
    const failing = result.failing();
    const rows: TiltRow[] = [];
    for (let at = 0; at * ROW < values.length; at++) {
      const v = (k: number) => values[at * ROW + k]!;
      rows.push({
        tiltDeg: v(0), step: v(1),
        failed: TILT_RULES.flatMap((rule, bit) => ((v(2) >> bit) & 1 ? [{ rule, at: failing[at * 4 + bit] ?? '' }] : [])),
        fittingSideTips: v(3), largestGapMm: v(4), largestSlenderness: v(5), largestLayerMm2: v(6), heightMm: v(7),
        robust: v(8) === 1, rotation: [v(9), v(10), v(11)],
      });
    }
    const band = result.band();
    return { kind: 'scan', startDeg: result.start_deg(), rows, order: [...result.order()], reason: REASONS[result.pick_reason()] ?? 'unknown',
      band: band.length === 2 ? [band[0]!, band[1]!] : undefined, boxed: decodeBoxed(result) };
  } finally {
    result.free();
  }
}

/** Scans `mesh` (unit-local) for the aligner type `profile`. */
export function scanDentalTilts(mesh: TriangleMesh, profile: string, settings: TiltScanSettings,
  onTilt?: (done: number, total: number) => void): TiltScan {
  return withDentalMesh(mesh, (session, model) => decodeTiltScan(session.dental_tilt_scan(model, profile,
    settings.neckLengthMm, settings.pillarDiameterMm, settings.liftMm, settings.braced, onTilt)));
}

/** The tilt shown to one decimal (the profile's start tilt is not a whole number). */
export const tiltLabel = (deg: number): string => (Math.round(deg * 10) / 10).toString();
