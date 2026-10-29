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
}

/** Detector diagnostics: overall confidence and the two shape ratios behind it. */
export interface DentalDiagnostics {
  confidence: number;
  terminalAreaRatio: number;
  axialVarianceRatio: number;
}

/** An orientation proposal with its rim, or why none was found; diagnostics either way. */
export type DentalProposal =
  | { kind: 'proposal'; rim: DentalRim; diagnostics: DentalDiagnostics }
  | { kind: 'inconclusive'; reason: 'invalid-mesh' | 'no-cavity' | 'ambiguous-cavity'; diagnostics: DentalDiagnostics };

/**
 * Finds a candidate cavity opening from a thick shell (Rust `propose_dental_orientation`, Node
 * test package only: the app gets this from `orient_dental`). Returned geometry is unit-local.
 */
export function proposeDentalOrientation(mesh: TriangleMesh, profile: string): DentalProposal {
  const result = dentalInternals().propose_dental_orientation(mesh.positions, mesh.indices, profile);
  try {
    const [confidence, terminalAreaRatio, axialVarianceRatio] = result.diagnostics();
    const diagnostics: DentalDiagnostics = { confidence: confidence ?? 0, terminalAreaRatio: terminalAreaRatio ?? 0, axialVarianceRatio: axialVarianceRatio ?? 0 };
    if (result.status() !== 0) return { kind: 'inconclusive', reason: result.reason() as 'invalid-mesh' | 'no-cavity' | 'ambiguous-cavity', diagnostics };
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
