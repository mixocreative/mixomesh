import { PROGRESS_STAGE } from '../core/progress';
import type { SupportProblem } from '../core/analysis/supportCheck';
import type { PlacementResult, ProgressCallback } from '../core/analysis/types';
import { orientationOnly, type CheckJob, type PlacementJob, type SupportJob } from '../core/jobs';
import { dentalPolicy } from '../dental/placement';
import type { GeneratedSupportMesh } from '../core/supports/mesh';
import { genericPolicy, jobContacts } from './genericPolicy';
import { placeGeneric } from './genericPlacement';
import { checkSupportProblems } from './checkSupports';
import { generateSupports, type BuildSite } from './generateSupports';
import { supportMeshToUnitLocal } from './supportFrame';
import { applyTransform, transformDirection, transformPoint } from '../state/transform';

/*
 * Runs support core jobs (host/core/jobs.ts) on whatever thread calls it: the workers, and the main
 * thread for tests and goldens. Outside host/core only because it takes its transform math from the
 * app module state/transform (three-free since Task 7); it could move into the core by switching to
 * core/transform.ts.
 *
 * The support build is one Rust `generate` call (U7): Rust makes the unit's policy from its saved
 * data in the same session (`generic_policy`, or `dental_policy` for a dental job), the host puts the contacts in plate
 * space and reads the mesh and verdicts back. No policy, collision test, landing rule or retry runs here.
 */

/** A `generate` call ends its repair and checks early after this long; the verdict is then inconclusive, never clear. */
export const GENERATE_TIMEOUT_MS = 120_000;

const EMPTY_MESH: GeneratedSupportMesh = { positions: new Float32Array(), indices: new Uint32Array(), parts: [], components: [], dropped: [], droppedByZones: [] };

/**
 * Support mesh of one unit in its local space, ready to render under the unit's parent group, with
 * the automatic contacts it left out (`dropped`: policy, landing rule, zones, safety repair), the
 * body-clearance `verdict` and the `islands` verdict.
 */
export function runSupportJob(job: SupportJob, onProgress?: ProgressCallback, revision = 0, site?: BuildSite): GeneratedSupportMesh {
  const { frame } = job;
  if (frame === null) return { ...EMPTY_MESH, revision };
  const contacts = jobContacts(job.contacts).map((contact) => ({
    ...contact,
    position: transformPoint(frame, contact.position),
    normal: transformDirection(frame, contact.normal),
  }));
  const zones = job.contacts.zones.map((stamp) => ({ ...stamp, center: transformPoint(frame, stamp.center), normal: transformDirection(frame, stamp.normal) }));
  const dental = job.dental;
  // Dental: the aligner's Step 3 switches decide Tree and Brace and Roof/Cage stay off, in Rust.
  const policy = dental ? dentalPolicy(dental, frame, job.contacts.manual) : genericPolicy(job.contacts, job.settings, job.repairBudget ?? 0);
  const out = generateSupports(contacts, job.settings, policy, {
    mode: job.mode, model: job.mesh, frame, plateY: job.plate ?? 0, labelText: job.labelText, zones, timeoutMs: GENERATE_TIMEOUT_MS, revision, ...(site ? { site } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  const mesh = out.mesh;
  if (dental && out.fallback.length > 0) mesh.dentalStructureFallback = out.fallback;
  if (!dental && out.fallback.length > 0) mesh.fallbacks = out.fallback;
  if (dental?.kind === 'two-contour' && out.rings.length === 2) {
    const [outer, opening] = out.rings as [typeof out.rings[number], typeof out.rings[number]];
    mesh.dentalRimCoverage = { outer, opening, needsReview: outer.needsReview || opening.needsReview };
  }
  onProgress?.(1, PROGRESS_STAGE.done);
  return supportMeshToUnitLocal(mesh, frame);
}

export { orientationOnly };

/** Automatic contacts, in the frame of the turned model (the caller maps them back to the unit). */
export function runPlacementJob(job: PlacementJob, onProgress?: ProgressCallback): PlacementResult {
  onProgress?.(0, PROGRESS_STAGE.findingOverhangs);
  const result = placeGeneric(applyTransform(job.mesh, orientationOnly(job.orientation)), job.settings);
  onProgress?.(1, PROGRESS_STAGE.done);
  return result;
}

/** Unsupported spots, in the frame of the turned model. */
export function runCheckJob(job: CheckJob, onProgress?: ProgressCallback): SupportProblem[] {
  const orientation = orientationOnly(job.orientation);
  const problems = checkSupportProblems(applyTransform(job.mesh, orientation), job.contacts.map((contact) => transformPoint(orientation, contact)), job.settings);
  onProgress?.(1, PROGRESS_STAGE.done);
  return problems;
}

