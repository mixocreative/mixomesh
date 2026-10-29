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
  dental_legacy_fill(model: number, profile: string, rim: Float64Array, visibilityMask: Uint8Array, manualArea: boolean,
    stamps: Float64Array, rotation: Float64Array, spacing: number, overhangAngleDegrees: number,
    initialPositions: Float64Array, initialNormals: Float64Array): LegacyFillLike;
}

/** The dental calls of the engine module the browser build has (sessions and the overlay mask). */
export interface DentalEngine {
  GeometrySession: new (maxBytes: number) => unknown;
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
  // 18 f64: 0 boundary kind (0 lower-edge loop, 1 projection fallback), 1-3 opening direction,
  // 4-6 centroid, 7-9 tangent, 10-12 bitangent, 13 visibility resolution, 14-15 visibility min,
  // 16-17 visibility max. `rimOf` reads the same layout back.
  return Float64Array.of(rim.boundaryKind === 'lower-edge-loop' ? 0 : 1, ...rim.openingDirection, ...rim.centroid,
    ...rim.tangent, ...rim.bitangent, rim.visibilityResolution, ...rim.visibilityMin, ...rim.visibilityMax);
}

/** The unit-local rim an orientation result carries. */
export function rimOf(result: DentalOrientResultLike): DentalRim {
  const s = result.rim_scalars();
  const at = (i: number): [number, number, number] => [s[i]!, s[i + 1]!, s[i + 2]!];
  return {
    boundaryKind: s[0] === 0 ? 'lower-edge-loop' : 'projection-fallback',
    points: result.take_rim_points(),
    openingDirection: at(1), centroid: at(4), tangent: at(7), bitangent: at(10),
    visibilityMask: result.take_visibility_mask(), visibilityResolution: s[13]!,
    visibilityMin: [s[14]!, s[15]!], visibilityMax: [s[16]!, s[17]!],
  };
}
