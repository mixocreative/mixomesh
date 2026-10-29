import type { DentalProposal } from './dental';
import { rimOf, withDentalMesh, type DentalOrientResultLike } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';
import type { Vector } from '../core/vec3';

/**
 * What Step 1 of the dental flow learns about a dropped aligner (Rust `orient_dental`): the
 * opening proposal, the pose that restores it (undefined when ambiguous), the central opening
 * (`present`, `absent`, `ambiguous`; ambiguous never becomes absent) and whether the mesh was
 * usable (closed, non-degenerate).
 */
export type DentalOrientation =
  | { kind: 'oriented'; proposal: Extract<DentalProposal, { kind: 'proposal' }>; rotation: Vector | undefined;
    opening: 'present' | 'absent' | 'ambiguous'; meshOk: boolean;
    /** False when the opening found contradicts the chosen aligner type (decided in Rust from the profile). */
    matchesProfile: boolean }
  | { kind: 'failed'; reason: string; meshOk: boolean };

const OPENING = ['present', 'absent', 'ambiguous'] as const;

export function orientDentalAligner(mesh: TriangleMesh, profile: string): DentalOrientation {
  return withDentalMesh(mesh, (session, model) => decode(session.orient_dental(model, profile)));
}

function decode(result: DentalOrientResultLike): DentalOrientation {
  try {
    const meshOk = result.mesh_ok();
    if (result.status() !== 0) return { kind: 'failed', reason: result.reason(), meshOk };
    const [confidence, terminalAreaRatio, axialVarianceRatio] = result.diagnostics();
    const rotation = result.rotation();
    return {
      kind: 'oriented',
      proposal: { kind: 'proposal', rim: rimOf(result), diagnostics: { confidence: confidence!, terminalAreaRatio: terminalAreaRatio!, axialVarianceRatio: axialVarianceRatio! } },
      rotation: rotation.length === 3 ? [rotation[0]!, rotation[1]!, rotation[2]!] : undefined,
      opening: OPENING[result.opening()] ?? 'ambiguous',
      meshOk,
      matchesProfile: result.matches_profile(),
    };
  } finally {
    result.free();
  }
}
