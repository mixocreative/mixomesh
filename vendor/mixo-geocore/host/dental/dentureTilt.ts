import { dentalEngine, withDentalMesh, type DentureTiltPathsLike } from './dentalEngine';
import type { Vector } from '../core/vec3';
import { decodeTiltScan, type TiltScan, type TiltScanSettings } from './dentalTilt';
import type { TriangleMesh } from '../core/analysis/types';

/*
 * The denture print-angle search (Rust `dental::denture::tilt`): tilts from upright (0) to the
 * profile's range, leaning the teeth side up by the tilt, judged by the crossing and slenderness
 * rules and scored by the overhang area. The result is the aligner scan's shape (`TiltScan`), so
 * the decoder is shared; `fittingSideTips` and `largestGapMm` are always 0 for a denture, the
 * rules `resin-trap` and `rim-gap` never fail, and `startDeg` is 0 (upright). Among tilts that pass
 * the rules the pick prefers the fewest lowest points no support can reach (rule `boxedInTiltWeight`,
 * on by default; `settings.rules` overrides it); `boxed` on the result holds the counts per tilt and
 * the picked tilt's boxed-in points.
 */

/** Scans `mesh` (unit-local) for the denture type `profile`; `onTilt(done, total)` after each tilt. */
export function scanDentureTilts(mesh: TriangleMesh, profile: string, settings: TiltScanSettings,
  onTilt?: (done: number, total: number) => void): TiltScan {
  return withDentalMesh(mesh, (session, model) => decodeTiltScan(session.denture_tilt_scan_ruled(model, profile,
    settings.neckLengthMm, settings.pillarDiameterMm, settings.liftMm, settings.braced, settings.rules ?? new Float64Array(), onTilt)));
}

/** How a tip fares in the landing-circle check: a rod to the plate at the normal clearance, only at the last-resort clearance, or none. */
export type TipPathState = 'path' | 'fallback' | 'none' | 'unknown';
const PATH_STATES: readonly TipPathState[] = ['path', 'fallback', 'none'];

/** One tilt for the live view: where its tips stand, how each fares, and the tilt's rotation. */
export type TiltPaths =
  | { kind: 'paths'; tiltDeg: number; rotation: Vector; tips: Array<{ position: Vector; normal: Vector; stream: number; state: TipPathState }>;
    counts: { lowsWithout: number; without: number; fallbacks: number; tips: number }; overhangMm2: number }
  | { kind: 'failed'; reason: string };

/**
 * The live tilt view (Rust `dental::denture::tilt_paths`): the tips of the print tilt `tiltDeg` (degrees from upright) with a path state each,
 * no supports built. The engine caches the per-model work (rim, holes, masks, ray index), so after the first call a tilt takes tens of
 * milliseconds. Tips are in the unit-local mesh frame; `rotation` turns the mesh into that pose. `settings.rules` as for the scan.
 */
export function denturePaths(mesh: TriangleMesh, profile: string, tiltDeg: number, settings: TiltScanSettings): TiltPaths {
  return withDentalMesh(mesh, (session, model) => decodeTiltPaths(tiltDeg,
    session.denture_tilt_paths(model, profile, tiltDeg, settings.neckLengthMm, settings.pillarDiameterMm, settings.liftMm, settings.braced, settings.rules ?? new Float64Array())));
}

/** Reads one tilt's result and frees it. */
function decodeTiltPaths(tiltDeg: number, r: DentureTiltPathsLike): TiltPaths {
  try {
    if (!r.ok()) return { kind: 'failed', reason: r.reason() };
    const flat = r.tips();
    const states = r.states();
    const c = r.counts();
    const rotation = r.rotation();
    const tips = Array.from({ length: states.length }, (_, k) => ({
      position: [flat[k * 7]!, flat[k * 7 + 1]!, flat[k * 7 + 2]!] as Vector, normal: [flat[k * 7 + 3]!, flat[k * 7 + 4]!, flat[k * 7 + 5]!] as Vector,
      stream: flat[k * 7 + 6]!, state: PATH_STATES[states[k]!] ?? 'unknown',
    }));
    return { kind: 'paths', tiltDeg, rotation: [rotation[0]!, rotation[1]!, rotation[2]!], tips, counts: { lowsWithout: c[0]!, without: c[1]!, fallbacks: c[2]!, tips: c[3]! }, overhangMm2: r.overhang_mm2() };
  } finally {
    r.free();
  }
}

/** The live angle step's handle (`openLiveTilt`): `at` per tilt while the operator drags, `free` when the step closes. */
export interface LiveTilt {
  /** False when the mesh cannot be oriented; `at` then answers `failed` with this reason. */
  readonly ok: boolean;
  readonly reason: string;
  /** The tips of the tilt with a path state each (as `denturePaths`), no supports built: tens of milliseconds. */
  at(tiltDeg: number): TiltPaths;
  /** Gives the engine's copy of the mesh back; `at` throws afterwards. */
  free(): void;
}

/**
 * The live tilt split (Rust `dental::denture::live_tilt`, engine 52): the per-model work (parts, upright frame, ray index, rim, holes,
 * masks) is done once here, so each `at(tiltDeg)` is only the tips and their path states (path at full clearance, fallback, none). The
 * full support build runs only when a tilt is accepted (policy + `generate`, as before). Same answers as `denturePaths`.
 */
export function openLiveTilt(mesh: TriangleMesh, profile: string, settings: TiltScanSettings): LiveTilt {
  const handle = new (dentalEngine().DentureLiveTilt)(mesh.positions, mesh.indices, profile, settings.neckLengthMm, settings.pillarDiameterMm,
    settings.liftMm, settings.braced, settings.rules ?? new Float64Array());
  let open = true;
  return {
    ok: handle.ok(),
    reason: handle.reason(),
    at: (tiltDeg) => {
      if (!open) throw new Error('LiveTilt used after free()');
      return decodeTiltPaths(tiltDeg, handle.paths(tiltDeg));
    },
    free: () => {
      if (open) handle.free();
      open = false;
    },
  };
}
