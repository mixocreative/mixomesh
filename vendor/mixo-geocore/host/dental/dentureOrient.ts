import { withDentalMesh, type DentureOrientResultLike } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';
import type { Vector } from '../core/vec3';

/*
 * Step 1 of the denture flow (Rust `dental::denture::upright` through `orient_denture`): the
 * arch frame (arch plane vertical, legs down, teeth side) and the rotation that stands the scan
 * upright. The print angle is the tilt scan's (`dentureTilt.ts`). The host only decodes.
 */

/** The denture's own frame in the unit-local mesh frame, unit vectors. */
export interface DentureFrame {
  centroid: Vector;
  /** Plate normal of the upright pose: from the legs end toward the apex. */
  up: Vector;
  /** Arch plane normal toward the saddles (teeth); the scan leans this side up by the tilt. */
  teeth: Vector;
  /** Left-right axis. */
  across: Vector;
}

/** What Step 1 learns about a dropped denture, or why it could not be oriented. */
export type DentureOrientation =
  | { kind: 'oriented'; frame: DentureFrame;
    /** Euler XYZ radians turning the unit upright (tilt 0). */
    rotation: Vector;
    /** Smallest / largest spread of the vertices (0 flat, 1 round), the legs' across gap over the across extent, the saddles' lean from the arch plane (mm). */
    diagnostics: { flatness: number; legsGapRatio: number; teethOffsetMm: number };
    /** False when the saddles' lean was below the profile's minimum: a side was taken, but it needs a look. */
    teethDecided: boolean }
  | { kind: 'failed'; reason: string };

/** Step 1 of the denture flow on `mesh` (unit-local) for the denture type `profile`, in a one-shot session. */
export function orientDenture(mesh: TriangleMesh, profile: string): DentureOrientation {
  return withDentalMesh(mesh, (session, model) => decodeDentureOrientation(session.orient_denture(model, profile)));
}

/** Decodes and frees an `orient_denture` result. */
export function decodeDentureOrientation(result: DentureOrientResultLike): DentureOrientation {
  try {
    if (result.status() !== 0) return { kind: 'failed', reason: result.reason() };
    const f = result.frame();
    const at = (i: number): Vector => [f[i]!, f[i + 1]!, f[i + 2]!];
    const [flatness, legsGapRatio, teethOffsetMm] = result.diagnostics();
    const rotation = result.rotation();
    return {
      kind: 'oriented',
      frame: { centroid: at(0), up: at(3), teeth: at(6), across: at(9) },
      rotation: [rotation[0]!, rotation[1]!, rotation[2]!],
      diagnostics: { flatness: flatness!, legsGapRatio: legsGapRatio!, teethOffsetMm: teethOffsetMm! },
      teethDecided: result.teeth_decided(),
    };
  } finally {
    result.free();
  }
}
