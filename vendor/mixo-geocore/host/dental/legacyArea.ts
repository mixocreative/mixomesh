import { dentalEngine, rimScalars, withDentalMesh, type LegacyFillLike } from './dentalEngine';
import { isManualArea, type DentalPolicy } from './dentalPolicy';
import type { PlacementResult, SupportPoint, TriangleMesh } from '../core/analysis/types';
import type { DentalPlacementJob } from '../core/jobs';

/*
 * Host adapter of the Rust legacy dental placement (`crates/geometry-core/src/dental/legacy.rs`):
 * a policy without a recomputed contour strip, i.e. an area painted from scratch (`manual-area`)
 * or an older saved project. The area (rim footprint, ordered stamps) crosses as data; Rust keeps
 * the generic contacts the area permits, fills the allowed downward faces and gives the overlay
 * mask. Arrays in once, arrays out once.
 */

type Legacy = Exclude<DentalPolicy, { kind: 'two-contour' }>;

/** The policy's area edits as the Rust calls take them (8 numbers each, in stroke order). */
export function stampRows(policy: DentalPolicy): Float64Array {
  const rows = new Float64Array(policy.stamps.length * 8);
  policy.stamps.forEach((stamp, at) => rows.set([...stamp.center, stamp.radius, ...stamp.normal, stamp.kind === 'allow' ? 1 : 0], at * 8));
  return rows;
}

/** Contacts of a legacy dental policy, in the turned frame, with the generic contacts it kept. */
export function legacyDentalPlacement(job: DentalPlacementJob & { dental: Legacy }, placement: PlacementResult): PlacementResult {
  const { mesh, orientation, dental: policy, settings } = job;
  const initial = placement.points;
  return withDentalMesh(mesh, (session, model) => {
    const result = session.dental_legacy_fill(model, policy.profileId,
      rimScalars(policy.rim), policy.rim.visibilityMask, isManualArea(policy), stampRows(policy),
      Float64Array.from(orientation.rotation), settings.spacing, settings.overhangAngleDegrees,
      Float64Array.from(initial.flatMap((point) => point.position)), Float64Array.from(initial.flatMap((point) => point.normal)),
    );
    return fillOf(result, initial, placement);
  });
}

function fillOf(result: LegacyFillLike, initial: readonly SupportPoint[], placement: PlacementResult): PlacementResult {
  try {
    const kept = Array.from(result.take_kept(), (k) => initial[k]!);
    const positions = result.take_positions();
    const normals = result.take_normals();
    const added = result.take_ids().map((id, k): SupportPoint => ({
      id, regionId: -1, source: 'interior',
      position: [positions[k * 3]!, positions[k * 3 + 1]!, positions[k * 3 + 2]!],
      normal: [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!],
    }));
    const points = [...kept, ...added];
    return {
      points,
      regions: placement.regions,
      contactPositions: new Float32Array(points.flatMap((point) => point.position)),
      contactNormals: new Float32Array(points.flatMap((point) => point.normal)),
    };
  } finally {
    result.free();
  }
}

/**
 * One byte per model vertex of the baseline area (the footprint, no brush stamps; the overlay
 * layer composes the stamps on top): where the opening sees the surface and a contact may stand.
 */
export function legacyBaselineVertices(mesh: TriangleMesh, policy: DentalPolicy): Uint8Array {
  return dentalEngine().dental_allowed_vertices(
    mesh.positions, mesh.indices, new Float32Array(), rimScalars(policy.rim), policy.rim.visibilityMask, isManualArea(policy), new Float64Array(), policy.profileId);
}
