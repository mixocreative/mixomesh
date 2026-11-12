import type { PlacementResult, SupportPoint, TriangleMesh } from '../core/analysis/types';
import type { JobTransform } from '../core/jobs';
import { orientationOnly } from '../core/jobs';
import { positionIds } from '../supports/contactEdits';
import { packRules, type GenerateRules } from '../supports/generateRules';
import { frameArray, type MakePolicy, type PolicyHandle } from '../supports/generateSupports';
import { withDentalMesh, type DentalSession } from './dentalEngine';
import { decodeIslands, type DentureIsland } from './dentureIslands';
import { partsOf, type DenturePart } from './dentureParts';

/*
 * Host side of the denture policy (Rust `dental::denture::policy` through `denture_policy`): the
 * unit's pose and switches are packed as numbers and Rust returns the `PolicyResult` handle
 * `generate` takes (every face permitted, the pose's tips as candidates, pillars may land on the
 * model). Nothing about the policy is decided here.
 */

/** What a denture unit saves about its supports: the profile and the lattice switch. */
export interface DenturePolicy {
  kind: 'denture';
  profileId: string;
  /** Lattice bracing between pillars (the profile default unless the operator switched it). */
  lattice: boolean;
  /**
   * Tips the operator chose to support from the model's own surface, one by one (the bubble "support from model surface"; engine 33,
   * Round C engine 51): their ids, as the build's unresolved report names them (`UnresolvedPoint.id`, a lowest point with no tip included, and
   * since engine 54 an island with no tip, `island-<vertex>`: its lowest point gets a tip when it faces within `islandOverhangAngleDeg` of down).
   * The build tries the plate first, then the model surface (allowed area, other surface, no-support zone). Absent or empty: none.
   */
  modelLandingAllow?: readonly string[];
}

/** A unit's policy from its profile, lattice on as the profile says. */
export function defaultDenturePolicy(profileId: string, lattice = true): DenturePolicy {
  return { kind: 'denture', profileId, lattice };
}

/**
 * The unit's denture policy made in Rust, expressed in `frame` (its +Y is the plate normal the
 * tips are placed for). `manual` are the unit's manual tips (unit-local): no automatic tip within
 * the pitch of one. `rules` (absent: the engine's defaults) are the planner rules the denture policy reads: `islandTips`,
 * `islandMinAreaMm2`, `lowOutsideAllowed`, `islandReuseMm`, `islandSlabMm` (see `GenerateRules`). The handle reports the
 * pose's islands (`policyIslands`).
 */
export function makeDenturePolicy(session: Pick<DentalSession, 'denture_policy_ruled'>, model: number, policy: DenturePolicy, frame: JobTransform,
  manual: readonly Pick<SupportPoint, 'position'>[] = [], rules?: GenerateRules): PolicyHandle {
  const handle = session.denture_policy_ruled(model, policy.profileId, frameArray(frame), policy.lattice, Float64Array.from(manual.flatMap((point) => point.position)), packRules(rules));
  if (policy.modelLandingAllow?.length) handle.set_model_landing_allow?.([...policy.modelLandingAllow]);
  return handle;
}

/** The islands a denture policy handle reports (before the build); `settleIslands` adds the build's left-out tips. */
export const policyIslands = (handle: Pick<PolicyHandle, 'island_facts'>): DentureIsland[] => decodeIslands(handle.island_facts());

/** The file's parts a denture policy handle reports (engine 50): the part list with the tips placed on each, and the part id of every face. */
export const policyParts = (handle: Pick<PolicyHandle, 'part_list' | 'face_parts'>): { parts: DenturePart[]; faceParts: Uint32Array } => partsOf(handle);

/** `makeDenturePolicy` for `generateSupports`. */
export const denturePolicy = (policy: DenturePolicy, frame: JobTransform, manual: readonly Pick<SupportPoint, 'position'>[] = [], rules?: GenerateRules): MakePolicy =>
  (session, model) => makeDenturePolicy(session as unknown as Pick<DentalSession, 'denture_policy_ruled'>, model, policy, frame, manual, rules);

/** Points (xyz then normal xyz each) with position ids. */
function pointsOf(flat: Float64Array): SupportPoint[] {
  const count = flat.length / 6;
  const at = (k: number, offset: number): [number, number, number] => [flat[k * 6 + offset]!, flat[k * 6 + offset + 1]!, flat[k * 6 + offset + 2]!];
  const ids = positionIds(Array.from({ length: count }, (_, k) => at(k, 0)));
  return Array.from({ length: count }, (_, k) => ({ id: ids[k]!, regionId: -1, position: at(k, 0), normal: at(k, 3), source: 'interior' as const }));
}

/** A placement result from a policy handle's `candidate_points()` (xyz then normal xyz per tip): the accept flow builds the policy once and reads the placement from it. */
export function placementOfCandidates(flat: Float64Array): PlacementResult {
  const points = pointsOf(flat);
  return { points, regions: [],
    contactPositions: new Float32Array(points.flatMap((point) => point.position)),
    contactNormals: new Float32Array(points.flatMap((point) => point.normal)) };
}

/**
 * Automatic contacts of a denture unit in the frame of the turned model (`orientation`'s rotation,
 * no translation), as a placement result: the policy's own candidates (lowest points, bottom band,
 * bar undersides, light fill). The batch and the app call this where the aligner flow calls
 * `filterDentalPlacement`.
 */
export function denturePlacement(mesh: TriangleMesh, policy: DenturePolicy, orientation: JobTransform, manual: readonly SupportPoint[] = [], rules?: GenerateRules): PlacementResult {
  const candidates = withDentalMesh(mesh, (session, model) => {
    const handle = makeDenturePolicy(session, model, policy, orientationOnly(orientation), manual, rules);
    try {
      return handle.candidate_points();
    } finally {
      handle.free();
    }
  });
  return placementOfCandidates(candidates);
}
