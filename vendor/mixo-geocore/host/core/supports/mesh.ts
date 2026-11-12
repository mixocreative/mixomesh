import type { TriangleMesh } from '../analysis/types';
import type { Vector } from '../vec3';
import type { ShapeOverride } from './settings';

/*
 * Types of the support mesh the build produces and the host consumes. The builder itself is the
 * Rust `generate` (host adapter `host/supports/generateSupports.ts`).
 */

/** A 2D point `[x, y]` (mm). */
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

/**
 * What a built component is. Order is the Rust part code (`supports/parts/tags`), decoded by
 * index in `supports/supportBuildWasm.decodeComponents`; keep both in step.
 */
export type SupportPart =
  | 'tip' | 'neck' | 'pillar' | 'foot' | 'brace' | 'raft'
  | 'tree-branch' | 'tree-trunk'
  | 'roof' | 'column' | 'roof-brace' | 'cross-bar' | 'cage-ring'
  | 'label'
  /** A part code this host version does not know (GEO-005): never another part's meaning. */
  | 'unknown';

/** Source-model contacts a built component intentionally approaches; not a collision exemption. */
export type ContactIntent =
  | { kind: 'primary'; contactId: string; point: Vector; normal: Vector; faceIndex?: number }
  | { kind: 'secondary'; point: Vector; normal: Vector; faceIndex?: number };

/**
 * One tagged slice of a support mesh's `indices`: the part it is, the contact it belongs to and
 * where its triangles start. Components are sorted by `start` (`contactAtTriangle` relies on it).
 */
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
  | { status: 'ok'; islands: Array<{ height: number; vertex: number; status: 'resolved' | 'unresolved' | 'manual-only' | 'outside-policy' | 'unknown' }> }
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

/** Dental two-contour jobs: built contact coverage of the outer rim and of the opening rim. */
export interface DentalRimCoverage {
  outer: DentalRimCoverageItem;
  opening: DentalRimCoverageItem;
  needsReview: boolean;
}

/**
 * A built support mesh with its component tags and verdicts. Plate space as `generate` returns it;
 * `supports/jobRunner.runSupportJob` hands it back in unit-local space.
 */
/** What an unresolved point is: an island, a lowest point (a lowest-point tip left out, or a lowest point the policy put no tip on), or another tip left out. */
export type UnresolvedKind = 'island' | 'lowest' | 'tip';

/** A tip or island that still has no support (`GeneratedSupportMesh.unresolved`), as the bubble tooltip shows it. */
export interface UnresolvedPoint {
  /** The tip's contact id, a lowest point's id with no tip (`denture-low-unreached-<k>`: put it on the allow list to resolve it), or `island-<vertex>` for an island with no tip of its own. */
  id: string;
  /** Island, lowest point or tip (engine 51). */
  kind: UnresolvedKind;
  /** The tip's stream (`low`, `area`, `bar`, `light`, `rim`, `hole`, `island`); empty for a tip of another policy. */
  stream: string;
  /** Plate frame, mm. */
  position: [number, number, number];
  /**
   * The outward surface normal there (plate frame; an island: straight down): the tip normal for the
   * one-tip edit `rerouteSupport`. `null` when the engine reported no direction for this point -
   * refuse the reroute with that, never aim it somewhere plausible (GEO-008).
   */
  normal: [number, number, number] | null;
  /** Height above the plate, mm (the position's y minus the plate's). */
  heightMm: number;
  /** Why, in words. */
  reason: string;
  /** The largest clearance (mm) at which a route from the plate was found; `null`: none found or not searched. */
  bestGapMm: number | null;
  /** The clearance (mm) the build needs. */
  neededMm: number;
}

export interface GeneratedSupportMesh extends TriangleMesh {
  /** Every part kind present, in first-seen order. */
  parts: SupportPart[];
  components: SupportComponent[];
  /** Automatic contacts this build left out (policy, landing rule, no-support zone or repair). */
  dropped: string[];
  /** Subset of dropped contacts rejected specifically by a no-support zone. */
  droppedByZones?: string[];
  /** Contacts the build could not support, where each tip stands (plate frame, mm) and why: `build-omission`, `leave-out:pillar`, `leave-out:neck`, `all-manual`, ... (`generate`). */
  leftOut?: { id: string; position: [number, number, number]; reason: string }[];
  /** Denture builds: tips the last-resort tier placed (`lastResortPlaced` is the length): tier 1 relaxed the outline lean limit, tier 2 also stepped the pillar clearance down; `clearanceMm` is what each was judged and verified at. Absent on other builds. */
  lastResort?: { id: string; tier: 1 | 2; clearanceMm: number }[];
  /** Rule contactFit (engine 45): the built contact ends by fit state (fitted: measured and within tolerance; seat: an edge or ridge under the contact, analytic end; unconverged: analytic end); all zero with the rule off. */
  contactFits?: { fitted: number; seat: number; unconverged: number };
  /** Denture builds with the dental model landing (`dentalModelLanding` or the allow list): tips supported from the model's own surface, with the landing tier (allowed area, other surface, no-support zone) and the landing point (plate frame, mm). Empty when off. */
  modelLanded?: { id: string; tier: 'allowed' | 'other' | 'no-support' | 'unknown'; position: [number, number, number] }[];
  /** Every tip still left out and every island no support reaches: where, which stream, why, and the best gap found (the largest clearance, mm, at which a route from the plate still exists; `null`: none found or not searched) against the gap the build needs. What the UI bubble's tooltip shows. */
  unresolved?: UnresolvedPoint[];
  /** The case's footprint on the plate (engine 53): the space-map raft outline (model shadow joined with the foot discs, grown by the raft expand), closed loops in plan (x, z) mm relative to the unit's plate position at build time. What plate auto-arrange packs (`editing/arrange.ts arrangeOnPlate`). */
  footprint?: Array<Array<[number, number]>>;
  /** Exact body-clearance verdict of the final mesh (`generate`); absent on a mesh not built by it. */
  verdict?: SupportVerdict;
  /** Revision of the request this mesh answers (`generate` echoes it); the host drops any other. */
  revision?: number;
  /** Islands of the model against the built supports (`generate`). */
  islands?: IslandReport;
  /** Dental jobs: final built contacts on each dental rim; absent when the detector could not certify a contour. */
  dentalRimCoverage?: DentalRimCoverage;
  /**
   * Generic jobs: the structure fallbacks the repair applied (`brace-pruned`: only crossing brace
   * segments were left out); absent when none. Dental jobs report theirs in `dentalStructureFallback`.
   */
  fallbacks?: Array<'tree' | 'brace' | 'brace-pruned'>;
  /** Dental jobs: requested dental structures omitted because their built geometry crossed the model. */
  dentalStructureFallback?: Array<'tree' | 'brace' | 'brace-pruned'>;
}
