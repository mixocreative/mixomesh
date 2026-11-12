import { crossCheckOf, type DentalProposal } from './dental';
import { rimOf, withDentalMesh, type DentalOrientResultLike } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';
import type { Vector } from '../core/vec3';

/** How Step 1 decided: an open arch by its trim (plane and U ends), a ring (a U bridged by a plate) by the floor rule. */
export type DentalArchKind = 'open' | 'ring' | 'unknown';

/**
 * What Step 1 of the dental flow learns about a dropped aligner (Rust `orient_dental`): the
 * opening proposal (its diagnostics carry the up/down cross-check), the pose that restores it
 * (undefined when ambiguous), the central opening (`present`, `absent`, `ambiguous`; ambiguous
 * never becomes absent; always `absent` on an open arch, whose trim alone bounds it), the arch kind
 * and whether the mesh was usable (closed, non-degenerate).
 */
export type DentalOrientation =
  | { kind: 'oriented'; proposal: Extract<DentalProposal, { kind: 'proposal' }>; rotation: Vector | undefined;
    opening: 'present' | 'absent' | 'ambiguous'; meshOk: boolean;
    /** False when the opening found contradicts the chosen aligner type (decided in Rust from the profile). */
    matchesProfile: boolean;
    arch: DentalArchKind }
  | { kind: 'failed'; reason: string; meshOk: boolean };

const OPENING = ['present', 'absent', 'ambiguous'] as const;
const ARCH: readonly DentalArchKind[] = ['open', 'ring'];
// GEO-005: an arch code this version does not know is `unknown`, not an open U. The choice drives
// the orientation and the rim, so calling a palatal ring an aligner arch is a geometric mistake.


/** Step 1 of the dental flow on `mesh` (unit-local) for the aligner type `profile`, in a one-shot session. */
export function orientDentalAligner(mesh: TriangleMesh, profile: string): DentalOrientation {
  return withDentalMesh(mesh, (session, model) => decode(session.orient_dental(model, profile)));
}

function decode(result: DentalOrientResultLike): DentalOrientation {
  try {
    const meshOk = result.mesh_ok();
    if (result.status() !== 0) return { kind: 'failed', reason: result.reason(), meshOk };
    const [confidence, floorOffsetRatio, axialVarianceRatio] = result.diagnostics();
    const rotation = result.rotation();
    return {
      kind: 'oriented',
      proposal: { kind: 'proposal', rim: rimOf(result), diagnostics: { confidence: confidence!, floorOffsetRatio: floorOffsetRatio!, axialVarianceRatio: axialVarianceRatio!, crossCheck: crossCheckOf(result) } },
      rotation: rotation.length === 3 ? [rotation[0]!, rotation[1]!, rotation[2]!] : undefined,
      opening: OPENING[result.opening()] ?? 'ambiguous',
      meshOk,
      matchesProfile: result.matches_profile(),
      arch: ARCH[result.arch_kind()] ?? 'unknown',
    };
  } finally {
    result.free();
  }
}
