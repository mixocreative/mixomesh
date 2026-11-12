import type { DentalRim } from './dental';
import type { TriangleMesh } from '../core/analysis/types';
import type { PolicyHandle } from '../supports/generateSupports';

/*
 * The Rust dental calls (engine ABI, crates/geometry-wasm/src/dental.rs). The host registers its engine once it is ready
 * (`geometryReady` in each realm; tests and Node scripts register the pkg-node build), like
 * `supports/supportEngine`: detection is synchronous from the caller's side. Every production call
 * works on a mesh loaded once in a `GeometrySession` and names its aligner profile.
 */
/** Result handle of `orient_dental` / `propose_dental_orientation`; read it, then `free()`. */
export interface DentalOrientResultLike {
  free(): void;
  status(): number;
  reason(): string;
  mesh_ok(): boolean;
  opening(): number;
  rotation(): Float64Array;
  diagnostics(): Float64Array;
  rim_scalars(): Float64Array;
  take_rim_points(): Float32Array;
  take_visibility_mask(): Uint8Array;
  matches_profile(): boolean;
  /** 0 open arch (the trim decided), 1 ring (the floor rule decided), 2 not oriented. */
  arch_kind(): number;
  /** Up/down cross-check by the rule that did not decide: 0 agrees, 1 inconclusive, 2 disagrees. */
  cross_check(): number;
}

/**
 * Result handle of `dental_rim_from_points` (engine 61): the rim built from a loop the operator drew
 * on the surface, for an aligner whose rim detection found none. Read it, then `free()`.
 *
 * The three rim getters are the orient result's, with the same layout, so `rimOf` reads either. What
 * it deliberately does NOT carry is `diagnostics`, `opening`, `arch_kind` and `cross_check`: those
 * are measurements of a detection that did not happen, and a drawn rim has no honest value for any
 * of them.
 */
export interface DentalRimResultLike {
  free(): void;
  /** False when the drawn points fit no plane; `reason` says why. */
  ok(): boolean;
  /** `rim-collinear`, or `rim-side-uncertain` on a good rim whose side needs the operator's eye. */
  reason(): string;
  rim_scalars(): Float64Array;
  take_rim_points(): Float32Array;
  take_visibility_mask(): Uint8Array;
  /**
   * The side evidence, in [-1, 1]: the engine's floor-rule offset along the fitted plane normal
   * before any flip. Positive means the axis-facing floor area leans the way that normal points, so
   * the opening was taken to face the other way. Near zero the floor decides nothing, which is what
   * `rim-side-uncertain` reports: show the operator the flip rather than let it pass.
   */
  floor_offset(): number;
  /** Whether `flip` reversed the side the floor rule chose. */
  flipped(): boolean;
}

/** Result handle of the region and footprint calls; read it, then `free()`. */
export interface DentalRegionResultLike {
  free(): void;
  ok(): boolean;
  reason(): string;
  take_allowed_faces(): Uint8Array;
  take_outer_edges(): Uint32Array;
  take_outer_ridge_edges(): Uint32Array;
  take_outer_connector_edges(): Uint32Array;
  take_opening_edges(): Uint32Array;
  region_faces(): Uint32Array;
  connector_lengths(): Float64Array;
  take_contact_faces(): Uint8Array;
  contact_faces_of(): Uint32Array;
  contact_points(): Float64Array;
  contact_distances(): Float64Array;
  contact_rims(): Uint8Array;
}

/** The print-angle search result (Rust `DentalTiltScanResult`; layout in `dentalTilt.ts`). */
export interface DentalTiltScanResultLike {
  free(): void;
  ok(): boolean;
  reason(): string;
  start_deg(): number;
  rows(): Float64Array;
  failing(): string[];
  order(): Uint32Array;
  pick_reason(): number;
  band(): Uint32Array;
  /** Denture scan only (engine 27): per row, lowest points no support can reach; empty when the rule is off. Optional so test doubles may omit them. */
  boxed_counts?(): Uint32Array;
  /** Denture scan with `landingTiltWeight` above 0 (engine 32): 4 numbers per row (lowest points without a path, tips without, fallbacks, tips). */
  path_counts?(): Uint32Array;
  counted_lows?(): Uint32Array;
  tip_counts?(): Uint32Array;
  /** The picked row's boxed-in lowest points, x y z each (mesh frame, mm). */
  boxed_points?(): Float64Array;
  /** Why each of `boxed_points()` is boxed in. */
  boxed_reasons?(): string[];
}

/** Result handle of `denture_tilt_paths` (Rust `DentureTiltPaths`); read it, then `free()`. */
export interface DentureTiltPathsLike {
  free(): void;
  ok(): boolean;
  reason(): string;
  rotation(): Float64Array;
  /** x y z nx ny nz stream per tip (mesh frame). */
  tips(): Float64Array;
  /** Per tip: 0 path, 1 fallback, 2 none. */
  states(): Uint8Array;
  /** Lowest points without a path, tips without a path, tips with only a fallback path, tips. */
  counts(): Uint32Array;
  overhang_mm2(): number;
}

/** The live tilt handle (Rust `DentureLiveTilt`, engine 52): one mesh's per-model work, then one `paths(tiltDeg)` per tilt; `free()` when done. */
export interface DentureLiveTiltLike {
  free(): void;
  /** False when the per-model work failed (the mesh cannot be oriented); `reason()` says why. */
  ok(): boolean;
  reason(): string;
  /** The tips and path states at `tiltDeg` (degrees from upright), as `denture_tilt_paths` gives them. */
  paths(tiltDeg: number): DentureTiltPathsLike;
}

/** Result handle of `denture_compare_areas`; read it, then `free()`. */
export interface DentureAreaResultLike {
  mask(): Uint8Array;
  areas(): Float64Array;
  free(): void;
}

/** Result handle of `denture_review` (Rust `DentureReviewResult`); read it, then `free()`. */
export interface DentureReviewResultLike {
  no_support_mask(): Uint8Array;
  no_support_steep_mask(): Uint8Array;
  no_support_steep_deg(): number;
  allowed_mask(): Uint8Array;
  hard_edges(): Float64Array;
  down_edges(): Float64Array;
  chain_points(): Float64Array;
  chain_sizes(): Uint32Array;
  chain_lengths(): Float64Array;
  box_(): Float64Array;
  oral_cavity_ray(): Float64Array;
  no_support_dir(): Float64Array;
  lows_outside(): Float64Array;
  lows_outside_faces(): Uint32Array;
  low_tip_points(): Float64Array;
  low_tip_reasons(): Uint8Array;
  lows_unreached(): Float64Array;
  lows_unreached_faces(): Uint32Array;
  down_mask(): Uint8Array;
  unsupportable(): Float64Array;
  released(): number;
  /** Local lows of the dental rim whose face points up: no tip (rule `rimLowNeedsOverhang`); not left out. */
  rim_lows_facing_up(): number;
  /** Faces of the self-supporting overhang regions (rule overhangSelfSupport, engine 38); empty with the rule off. */
  self_support_faces(): Uint32Array;
  /** Tips the final guard refused (overhangAngleDeg, engine 39): [rim, hole, area, other]. */
  tips_dropped_facing_up(): Uint32Array;
  /** Tips skipped for a knife-sharp fold or a neck behind a nearby face (engine 39): [rim, hole, area, other]. */
  tips_skipped_fold(): Uint32Array;
  /** Island and lowest-point tips on a face that is not down-facing (engine 39): xyz triples. */
  lows_not_down_facing(): Float64Array;
  /** [overhang regions, self-supporting regions, open-area tips saved]. */
  self_support_info(): Float64Array;
  /** Engine 45 (rule areaDensity): per open-area region [projected mm2, steepness, height mm, pitch mm, faces, tips]; empty with the rule off. */
  area_regions(): Float64Array;
  rim_loops(): Float64Array;
  rim_sizes(): Uint32Array;
  rim_closed(): Uint8Array;
  rim_edges(): Uint32Array;
  rim_info(): Float64Array;
  hole_outlines(): Float64Array;
  hole_sizes(): Uint32Array;
  hole_info(): Float64Array;
  hole_band_mask(): Uint8Array;
  socket_mask(): Uint8Array;
  sockets_cancelled_by_r2(): number;
  fitting_mask(): Uint8Array;
  fitting_check(): Uint32Array;
  tips_dropped_socket(): Uint32Array;
  lows_in_sockets(): Float64Array;
  suction_cups(): Float64Array;
  suction_mask(): Uint8Array;
  drain_pockets(): Float64Array;
  drain_sockets(): Float64Array;
  drain_mask(): Uint8Array;
  rim_band_mask(): Uint8Array;
  up_decision(): Float64Array;
  rim_plane(): Float64Array;
  symmetry_plane(): Float64Array;
  up(): Float64Array;
  tips(): Float64Array;
  /** The islands of the reviewed pose, `ISLAND_STRIDE` numbers each (`dentureIslands.ts`); empty with the rule `islandTips` off. */
  islands(): Float64Array;
  /** Why the islands could not be told; empty when they could. */
  islands_note(): string;
  /** The file's parts (engine 50), `PART_STRIDE` numbers each (`dentureParts.ts`); the review runs on the target part. */
  part_list?(): Float64Array;
  /** The part id of every face of the file (the layer "Parts"). */
  face_parts?(): Uint32Array;
  tip_faces(): Uint32Array;
  pillar(): Float64Array;
  free(): void;
}

/** Result handle of `orient_denture` (Rust `DentureOrientResult`; decoded by `dentureOrient.ts`); read it, then `free()`. */
export interface DentureOrientResultLike {
  free(): void;
  /** 0 oriented, 1 failed (see `reason`). */
  status(): number;
  reason(): string;
  /** Euler XYZ radians turning the unit upright; empty when failed. */
  rotation(): Float64Array;
  /** 12 values: centroid, up, teeth, across (xyz each), mesh frame; empty when failed. */
  frame(): Float64Array;
  /** flatness, legs gap ratio, teeth offset mm. */
  diagnostics(): Float64Array;
  teeth_decided(): boolean;
}

/** Result handle of `dental_legacy_fill`: kept indices into the initial points, plus the added contacts. */
export interface LegacyFillLike {
  free(): void; take_kept(): Uint32Array; take_positions(): Float64Array; take_normals(): Float64Array; take_ids(): string[];
}

/** The dental calls of a `GeometrySession` (meshes by handle). */
export interface DentalSession {
  load_mesh(positions: Float32Array, indices: Uint32Array): number;
  free(): void;
  orient_dental(model: number, profile: string): DentalOrientResultLike;
  propose_dental_region(model: number, tuning: Float64Array, profile: string): DentalRegionResultLike;
  retune_dental_region(model: number, allowed: Uint8Array, outer: Uint32Array, opening: Uint32Array,
    tuning: Float64Array, phaseFraction: number, profile: string): DentalRegionResultLike;
  /** `kind` 0 older saved policy, 1 painted from scratch, 2 two-contour (see the Rust doc). */
  dental_policy(model: number, profile: string, kind: number, tuning: Float64Array, stamps: Float64Array,
    savedAllowed: Uint8Array, savedContact: Uint8Array, savedOuter: Uint32Array, savedOpening: Uint32Array,
    structure: Uint8Array, frame: Float64Array, manualPositions: Float64Array): PolicyHandle;
  /** Print-angle search with the host's current support settings; `onTilt(done, total)` after each tilt. */
  dental_tilt_scan(model: number, profile: string, neckLengthMm: number, pillarDiameterMm: number, liftMm: number, braced: boolean,
    onTilt?: (done: number, total: number) => void): DentalTiltScanResultLike;
  /**
   * The rim for a closed loop the operator drew on the surface (engine 61): `points` flat f32 xyz in
   * loop order, the first point not repeated, unit-local mm. `flip` reverses the side the engine
   * chose for the opening, which it takes from the floor rule, never from the loop's winding.
   */
  dental_rim_from_points(model: number, points: Float32Array, flip: boolean, profile: string): DentalRimResultLike;
  dental_legacy_fill(model: number, profile: string, rim: Float64Array, visibilityMask: Uint8Array, manualArea: boolean,
    stamps: Float64Array, rotation: Float64Array, spacing: number, overhangAngleDegrees: number,
    initialPositions: Float64Array, initialNormals: Float64Array): LegacyFillLike;
  // Denture calls (`crates/geometry-wasm/src/denture.rs`); `profile` is a denture profile id.
  /** Step 1 for a denture: the upright frame and its rotation. */
  orient_denture(model: number, profile: string): DentureOrientResultLike;
  /** Denture print-angle search from upright; rows as `dental_tilt_scan`. Default support rules. */
  denture_tilt_scan(model: number, profile: string, neckLengthMm: number, pillarDiameterMm: number, liftMm: number, braced: boolean,
    onTilt?: (done: number, total: number) => void): DentalTiltScanResultLike;
  /** `denture_tilt_scan` with the support-rule overrides (engine 27; `rules` in `rule_names()` order, NaN keeps the default). */
  denture_tilt_scan_ruled(model: number, profile: string, neckLengthMm: number, pillarDiameterMm: number, liftMm: number, braced: boolean,
    rules: Float64Array, onTilt?: (done: number, total: number) => void): DentalTiltScanResultLike;
  /** The live tilt view (engine 32): the tips of one print tilt with a path state each; no supports built. */
  denture_tilt_paths(model: number, profile: string, tiltDeg: number, neckLengthMm: number, pillarDiameterMm: number, liftMm: number, braced: boolean,
    rules: Float64Array): DentureTiltPathsLike;
  /** The denture policy for `generate` in `frame` (+Y the plate normal); `brace` is the lattice switch. */
  denture_policy(model: number, profile: string, frame: Float64Array, brace: boolean, manualPositions: Float64Array): PolicyHandle;
  /** `denture_policy` with the support-rule overrides (engine 28; `rules` in `rule_names()` order, NaN keeps the default): island tips and the low-tip admission. */
  denture_policy_ruled(model: number, profile: string, frame: Float64Array, brace: boolean, manualPositions: Float64Array, rules: Float64Array): PolicyHandle;
  /** The owner-rule review layers of a denture (`dentureReview.ts` decodes them). */
  denture_review(model: number, profile: string, tilt_deg: number): DentureReviewResultLike | undefined;
  /** `denture_review` with the support-rule overrides (engine 28). */
  denture_review_ruled(model: number, profile: string, tilt_deg: number, rules: Float64Array): DentureReviewResultLike | undefined;
  /** Support-area comparison of two xyz point lists (mesh frame) within `radiusMm`. */
  denture_compare_areas(model: number, owner: Float64Array, generated: Float64Array, radiusMm: number): DentureAreaResultLike;
}

/** The dental calls of the engine module the browser build has (sessions, the overlay mask, the denture profile ids). */
export interface DentalEngine {
  GeometrySession: new (maxBytes: number) => unknown;
  /** The live tilt handle (engine 52): owns a copy of the mesh; `rules` in `rule_names()` order, NaN keeps the default. */
  DentureLiveTilt: new (positions: Float32Array, indices: Uint32Array, profile: string, neckLengthMm: number, pillarDiameterMm: number, liftMm: number,
    braced: boolean, rules: Float64Array) => DentureLiveTiltLike;
  /** Ids of the embedded denture profiles (production ABI; the aligner ids are a test-abi call). */
  denture_profile_ids(): string[];
  dental_allowed_vertices(positions: Float32Array, indices: Uint32Array, normals: Float32Array, rim: Float64Array, visibilityMask: Uint8Array,
    manualArea: boolean, stamps: Float64Array, profile: string): Uint8Array;
}

/**
 * The dental internals of the Node test package (`--features test-abi`): tests and the review
 * scripts only. The browser build does not have them.
 */
export interface DentalInternals {
  propose_dental_orientation(positions: Float32Array, indices: Uint32Array, profile: string): DentalOrientResultLike;
  dental_pose(positions: Float32Array, indices: Uint32Array, rim: Float64Array, profile: string): Float64Array;
  inspect_dental_opening(positions: Float32Array, indices: Uint32Array, rim: Float64Array, profile: string): {
    free(): void; kind(): number; reason(): string; take_edges(): Uint32Array };
  dental_footprint(positions: Float32Array, indices: Uint32Array, allowed: Uint8Array, outer: Uint32Array, opening: Uint32Array,
    settings: Float64Array): DentalRegionResultLike;
  dental_side_bands(positions: Float32Array, indices: Uint32Array, allowed: Uint8Array, outer: Uint32Array, opening: Uint32Array,
    setback: number, width: number): { free(): void; ok(): boolean; reason(): string; take_band(index: number): Uint8Array };
  dental_sample_contacts(positions: Float32Array, indices: Uint32Array, contour: Uint32Array, sideBand: Uint8Array,
    spacing: number, maxSearch: number, phaseFraction: number, minSeparation: number): { free(): void; ok(): boolean; reason(): string; skipped_samples(): number;
    perimeter(): number; faces(): Uint32Array; points(): Float64Array; distances(): Float64Array };
  manual_dental_area(faceCount: number, painted: Uint32Array, detected: boolean, profile: string): Uint8Array;
  manual_dental_area_from_stamps(positions: Float32Array, indices: Uint32Array, stamps: Float64Array, detected: boolean, profile: string): Uint8Array;
  dental_profile_ids(): string[];
  dental_area_band(tuning: Float64Array, profile: string): Float64Array;
}

let current: DentalEngine | undefined;

/** Registers this realm's engine; `workers/geometryClient.geometryReady` calls it. */
export function setDentalEngine(engine: DentalEngine): void {
  current = engine;
}

/** The registered engine; throws when `geometryReady()` has not resolved in this realm. */
export function dentalEngine(): DentalEngine {
  if (!current) throw new Error('Geometry engine is not ready: await geometryReady() before dental detection');
  return current;
}

/** The internals; throws outside the Node test package. */
export function dentalInternals(): DentalInternals {
  const engine = dentalEngine() as unknown as Partial<DentalInternals>;
  if (typeof engine.dental_footprint !== 'function') throw new Error('Dental internals exist only in the test-abi build (pkg-node)');
  return engine as DentalInternals;
}

/** Mesh bytes a one-shot dental session may hold. */
const SESSION_BYTES = 0x30000000;

/** Runs `use` with `mesh` loaded once in a fresh session (freed afterwards, with every handle in it). */
export function withDentalMesh<T>(mesh: TriangleMesh, use: (session: DentalSession, model: number) => T): T {
  const session = new (dentalEngine().GeometrySession)(SESSION_BYTES) as DentalSession;
  try {
    return use(session, session.load_mesh(mesh.positions, mesh.indices));
  } finally {
    session.free();
  }
}

/** The flat frame the pose and opening calls take: the layout of `DentalOrientResult.rim_scalars`. */
export function rimScalars(rim: DentalRim): Float64Array {
  // 22 f64: 0 boundary kind (0 lower-edge loop, 1 projection fallback), 1-3 opening direction,
  // 4-6 centroid, 7-9 tangent, 10-12 bitangent, 13 visibility resolution, 14-15 visibility min,
  // 16-17 visibility max, 18 whether the trim's U decided a front (0/1), 19-21 that front (zeros
  // without one; a rim saved by engine 12 has none). `rimOf` reads the same layout back.
  return Float64Array.of(rim.boundaryKind === 'lower-edge-loop' ? 0 : 1, ...rim.openingDirection, ...rim.centroid,
    ...rim.tangent, ...rim.bitangent, rim.visibilityResolution, ...rim.visibilityMin, ...rim.visibilityMax,
    rim.front ? 1 : 0, ...(rim.front ?? [0, 0, 0]));
}

/** The three rim pieces an orient result and a drawn-rim result both carry, in the one layout. */
export interface RimCarrier {
  rim_scalars(): Float64Array;
  take_rim_points(): Float32Array;
  take_visibility_mask(): Uint8Array;
}

/** The unit-local rim an orientation result or a drawn-rim result carries. */
export function rimOf(result: RimCarrier): DentalRim {
  const s = result.rim_scalars();
  const at = (i: number): [number, number, number] => [s[i]!, s[i + 1]!, s[i + 2]!];
  const rim: DentalRim = {
    boundaryKind: s[0] === 0 ? 'lower-edge-loop' : 'projection-fallback',
    points: result.take_rim_points(),
    openingDirection: at(1), centroid: at(4), tangent: at(7), bitangent: at(10),
    visibilityMask: result.take_visibility_mask(), visibilityResolution: s[13]!,
    visibilityMin: [s[14]!, s[15]!], visibilityMax: [s[16]!, s[17]!],
  };
  if (s.length >= 22 && s[18] === 1) rim.front = at(19);
  return rim;
}
