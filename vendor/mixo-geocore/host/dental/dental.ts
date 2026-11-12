import type { Vector } from '../core/vec3';
import { dentalInternals, rimOf, rimScalars } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';

/** The detected rim of an aligner's cavity opening and its local frame (unit-local mm, unit vectors). */
export interface DentalRim {
  /** Only a paired lower-edge loop may authorize automatic dental supports. */
  boundaryKind: 'lower-edge-loop' | 'projection-fallback';
  /** Unit-local closed loop. The first point is not repeated. */
  points: Float32Array;
  /** Unit-local direction from the tooth cavity through its opening. */
  openingDirection: Vector;
  centroid: Vector;
  tangent: Vector;
  bitangent: Vector;
  /** Orthographic visibility of the cavity opening in the local rim frame. */
  visibilityMask: Uint8Array;
  visibilityResolution: number;
  visibilityMin: [number, number];
  visibilityMax: [number, number];
  /**
   * Unit-local arch front in the rim plane when the trim's U ends decided it (engine 13, Rust
   * `dental::trim`); absent on a ring (whose front the pose code estimates) and on rims saved by
   * older engines.
   */
  front?: Vector;
}

/** Up/down agreement between the trim plane and the floor rule (whichever did not decide). */
export type DentalCrossCheck = 'agrees' | 'inconclusive' | 'disagrees';

/** Detector diagnostics: the floor rule's confidence, the two shape ratios behind it, and the up/down cross-check. */
export interface DentalDiagnostics {
  /** `floorOffsetRatio * (1 - axialVarianceRatio)`: decides a ring; grades the cross-check on an open arch. */
  confidence: number;
  floorOffsetRatio: number;
  axialVarianceRatio: number;
  /** Absent only on diagnostics made before engine 13. A disagreement is for the user to look at, never resolved silently. */
  crossCheck?: DentalCrossCheck;
}

/** Why Step 1 found no orientation (Rust `orient::Reason::code`). */
export type DentalInconclusiveReason =
  | 'invalid-mesh' | 'non-manifold-or-degenerate-mesh' | 'no-trim' | 'trim-plane-degenerate' | 'trim-ends-unclear'
  | 'no-cavity' | 'ambiguous-cavity';

/** An orientation proposal with its rim, or why none was found; diagnostics either way. */
export type DentalProposal =
  | { kind: 'proposal'; rim: DentalRim; diagnostics: DentalDiagnostics }
  | { kind: 'inconclusive'; reason: DentalInconclusiveReason; diagnostics: DentalDiagnostics };

const CROSS_CHECK: readonly DentalCrossCheck[] = ['agrees', 'inconclusive', 'disagrees'];

/** The cross-check an orient result reports (`cross_check()`), `inconclusive` for an engine without one. */
export function crossCheckOf(result: { cross_check?(): number }): DentalCrossCheck {
  return CROSS_CHECK[result.cross_check?.() ?? 1] ?? 'inconclusive';
}

/**
 * Finds a candidate cavity opening from a thick shell (Rust `propose_dental_orientation`, Node
 * test package only: the app gets this from `orient_dental`). Returned geometry is unit-local.
 */
export function proposeDentalOrientation(mesh: TriangleMesh, profile: string): DentalProposal {
  const result = dentalInternals().propose_dental_orientation(mesh.positions, mesh.indices, profile);
  try {
    const [confidence, floorOffsetRatio, axialVarianceRatio] = result.diagnostics();
    const diagnostics: DentalDiagnostics = { confidence: confidence ?? 0, floorOffsetRatio: floorOffsetRatio ?? 0, axialVarianceRatio: axialVarianceRatio ?? 0, crossCheck: crossCheckOf(result) };
    if (result.status() !== 0) return { kind: 'inconclusive', reason: result.reason() as DentalInconclusiveReason, diagnostics };
    return { kind: 'proposal', rim: rimOf(result), diagnostics };
  } finally {
    result.free();
  }
}

/**
 * The rotation to the profile's target pose (its `pose` block: tilt, heading, roll) (Rust
 * `dental_pose`, Node test package only: the app uses the rotation `orient_dental` returns).
 * Returns undefined for ambiguous arches.
 */
export function rotationToDentalPose(mesh: TriangleMesh, rim: DentalRim, profile: string): Vector | undefined {
  const pose = dentalInternals().dental_pose(mesh.positions, mesh.indices, rimScalars(rim), profile);
  return pose.length === 3 ? [pose[0]!, pose[1]!, pose[2]!] : undefined;
}
