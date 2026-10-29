import type { TriangleMesh } from '../analysis/types';
import type { Vector } from '../vec3';
import type { ShapeOverride } from './settings';

/*
 * Types of the support mesh the build produces and the host consumes. The builder itself is the
 * Rust `generate` (`src/supports/generateSupports.ts`).
 */

export type Point2 = [number, number];

/** A point where a support lands on the model, with the landed-on surface normal (pointing up). */
export interface Landing {
  point: Vector;
  normal: Vector;
  /** Face hit on the exact source mesh, even when the visible landing is voxel-remeshed. */
  faceIndex?: number;
  /** Exact hit on that face; use this point for face-local paint permission. */
  sourcePoint?: Vector;
}

/** A support contact in build-plate space: Y is up and the plate is y = 0 (mm). */
export interface SupportContact {
  id: string;
  /** Manual contacts never merge into Auto Tree branches and ignore zones. Unset means automatic. */
  origin?: 'auto' | 'manual';
  position: Vector;
  /** Model surface normal at the contact, pointing out of the model. */
  normal: Vector;
  /** Exact indexed model face at the primary tip, when placement can certify it. */
  sourceFace?: number;
  /**
   * SLASG point class. With a model, `face` and `edge` contacts take their neck normal from
   * the voxel remesh (nearest face / nearest edge) and `vertical` ones point straight down;
   * without a class the given normal is used as is.
   */
  kind?: 'face' | 'edge' | 'vertical';
  /** The support's own tip, contact, neck and foot values over the object's settings; such a support never joins a tree. */
  shape?: ShapeOverride;
}

export type SupportPart =
  | 'tip' | 'neck' | 'pillar' | 'foot' | 'brace' | 'raft'
  | 'tree-branch' | 'tree-trunk'
  | 'roof' | 'column' | 'roof-brace' | 'cross-bar' | 'cage-ring'
  | 'label';

/** Source-model contacts a built component intentionally approaches; not a collision exemption. */
export type ContactIntent =
  | { kind: 'primary'; contactId: string; point: Vector; normal: Vector; faceIndex?: number }
  | { kind: 'secondary'; point: Vector; normal: Vector; faceIndex?: number };

export interface SupportComponent {
  part: SupportPart;
  /** Marks a neck split from an Auto Tree branch rather than an ordinary pillar. */
  structureKind?: 'tree';
  /** Owning contact for picking; structural parts (raft, braces, roof...) have none. */
  contactId?: string;
  /** First index into `indices`, and the number of indices (a multiple of 3). */
  start: number;
  count: number;
  /**
   * A pillar that lands on the model with its landing tip built into the tube (round tapered tip,
   * no sphere): its last `landingReach` mm, around the tube's end, show in the tips view.
   */
  landingReach?: number;
  /** Requires a separate face-local, depth-bounded collision classifier before use. */
  contactIntent?: ContactIntent[];
}

/** One place where a built support crosses the model (Rust `review_body_clearance`). */
export interface SupportIssue {
  /** Owning contact; absent for a structure (brace, tree trunk, roof...). */
  contactId?: string;
  part: SupportPart;
  /** Source face the support crosses. */
  modelFace: number;
  /** False: a contact end without face identity, which cannot be judged (inconclusive, not blocked). */
  blocked: boolean;
  origin: 'auto' | 'manual' | 'structural';
}

/** One verdict for both policies: a timeout or an unjudgeable crossing is `inconclusive`, never `clear`. */
export interface SupportVerdict {
  status: 'clear' | 'blocked' | 'inconclusive';
  reason?: string;
  issues: SupportIssue[];
}

/** Island verdict from the built-path graph: `resolved` only when verified supports reach the plate. */
export type IslandReport =
  | { status: 'ok'; islands: Array<{ height: number; vertex: number; status: 'resolved' | 'unresolved' | 'manual-only' | 'outside-policy' }> }
  | { status: 'inconclusive'; reason: string };

/** Dental (host/dental): the final built contacts on one rim of a two-contour aligner. */
export interface DentalRimCoverageItem {
  perimeterMm: number;
  retained: number;
  maxGapMm: number;
  /** This is a review trigger, not a clinical acceptance threshold. */
  reviewGapMm: number;
  needsReview: boolean;
}

export interface DentalRimCoverage {
  outer: DentalRimCoverageItem;
  opening: DentalRimCoverageItem;
  needsReview: boolean;
}

export interface GeneratedSupportMesh extends TriangleMesh {
  parts: SupportPart[];
  components: SupportComponent[];
  /** Automatic contacts this build left out (policy, landing rule, no-support zone or repair). */
  dropped: string[];
  /** Subset of dropped contacts rejected specifically by a no-support zone. */
  droppedByZones?: string[];
  /** Exact body-clearance verdict of the final mesh (`generate`); absent on a mesh not built by it. */
  verdict?: SupportVerdict;
  /** Revision of the request this mesh answers (`generate` echoes it); the host drops any other. */
  revision?: number;
  /** Islands of the model against the built supports (`generate`). */
  islands?: IslandReport;
  /** Dental jobs: final built contacts on each dental rim; absent when the detector could not certify a contour. */
  dentalRimCoverage?: DentalRimCoverage;
  /** Dental jobs: requested dental structures omitted because their built geometry crossed the model. */
  dentalStructureFallback?: Array<'tree' | 'brace' | 'brace-pruned'>;
}
