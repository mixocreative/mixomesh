/* tslint:disable */
/* eslint-disable */

export class AsciiStlSession {
    free(): void;
    [Symbol.dispose](): void;
    finish(): WeldResult;
    constructor(file_size: number);
    push(chunk: Uint8Array): void;
}

export class BinaryStlSession {
    free(): void;
    [Symbol.dispose](): void;
    finish(): WeldResult;
    constructor(triangles: number);
    push(chunk: Uint8Array): void;
}

export class BodySegmentsResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_first(): Uint32Array;
    take_keys(): Uint32Array;
    take_points(): Float32Array;
}

/**
 * Step 1 result. Failed: `status() == 1` with `reason()`. Oriented: `status() == 0`.
 */
export class DentalOrientResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * confidence, terminal area ratio, axial variance ratio.
     */
    diagnostics(): Float64Array;
    /**
     * False when the opening found contradicts the profile's expectation (Step 1 mismatch notice).
     */
    matches_profile(): boolean;
    mesh_ok(): boolean;
    /**
     * 0 present, 1 absent, 2 ambiguous.
     */
    opening(): number;
    /**
     * Failure reason, or why the central opening is ambiguous (empty otherwise).
     */
    reason(): string;
    /**
     * kind (0 lower-edge loop, 1 projection fallback), opening direction, centroid, tangent,
     * bitangent (3 each), visibility resolution, visibility min (2), visibility max (2).
     */
    rim_scalars(): Float64Array;
    /**
     * Euler XYZ radians, or empty when the arch front is ambiguous.
     */
    rotation(): Float64Array;
    status(): number;
    take_rim_points(): Float32Array;
    take_visibility_mask(): Uint8Array;
}

/**
 * A detected region: contours, face cut, contact strip and contacts (Step 2 display and review;
 * the policy itself is `dental_policy`).
 */
export class DentalRegionResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    connector_lengths(): Float64Array;
    /**
     * Distance along the contour then distance from it, per contact.
     */
    contact_distances(): Float64Array;
    /**
     * Source face per contact: outer-rim contacts first, then opening-rim contacts.
     */
    contact_faces_of(): Uint32Array;
    /**
     * Position XYZ then normal XYZ per contact.
     */
    contact_points(): Float64Array;
    /**
     * 0 outer rim, 1 opening rim, per contact.
     */
    contact_rims(): Uint8Array;
    ok(): boolean;
    reason(): string;
    /**
     * Faces on the opening-facing side, then on the other side.
     */
    region_faces(): Uint32Array;
    take_allowed_faces(): Uint8Array;
    /**
     * The contact strip (1 byte per face).
     */
    take_contact_faces(): Uint8Array;
    take_opening_edges(): Uint32Array;
    take_outer_connector_edges(): Uint32Array;
    take_outer_edges(): Uint32Array;
    take_outer_ridge_edges(): Uint32Array;
}

/**
 * The print-angle search (`dental_tilt_scan`): one row per scanned tilt in step order, the pick
 * order (the pick first), the pick's reason and the stable band. Failed: `ok() == false` with `reason()`.
 */
export class DentalTiltScanResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * First and last row index of the stable band, or empty.
     */
    band(): Uint32Array;
    /**
     * Per row and rule (4 per row): the first failing vertex id (resin trap) or tip id, or "".
     */
    failing(): string[];
    ok(): boolean;
    /**
     * Row indices in pick order: the pick, then the tilts the confirm tries next.
     */
    order(): Uint32Array;
    /**
     * 0 robust, 1 passing (no tilt is robust), 2 failing (no tilt passes).
     */
    pick_reason(): number;
    reason(): string;
    /**
     * Per row, 12 numbers: tilt (degrees), steps from the start, rule flags (bit 0 resin trap, 1 rim
     * gap, 2 crossing, 3 too thin), fitting-side tips, largest gap mm, largest slenderness, largest
     * layer mm², height mm, robust (0/1), rotation Euler XYZ radians (3, as the orient result).
     */
    rows(): Float64Array;
    /**
     * The start tilt (degrees).
     */
    start_deg(): number;
}

/**
 * The review GLB data of `diagnose`: coloured layers, one per role (docs/SHIP-PLAN.md ABI).
 */
export class Diagnosis {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 0xRRGGBB.
     */
    layer_color(layer: number): number;
    layer_count(): number;
    layer_name(layer: number): string;
    /**
     * The request revision, echoed.
     */
    revision(): number;
    /**
     * Empty: the positions are a triangle soup.
     */
    take_layer_indices(layer: number): Uint32Array;
    take_layer_positions(layer: number): Float32Array;
}

/**
 * Per-corner positions and flat normals of the approved faces (`allowed[face] == 1`).
 */
export class FaceOverlay {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_normals(): Float32Array;
    take_positions(): Float32Array;
}

/**
 * The result of `generate`: the support mesh arrays and tag tables (layout in `supports::flat`, the
 * tags index into `take_contact_ids`), what was left out, and the verdicts.
 */
export class Generation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Non-empty when the islands could not be judged (no island is then called resolved).
     */
    island_reason(): string;
    reason(): string;
    /**
     * The request revision, echoed so the host can drop a result that is not the newest.
     */
    revision(): number;
    /**
     * 0 clear, 1 blocked, 2 inconclusive.
     */
    status(): number;
    take_contact_ids(): string[];
    take_dropped(): string[];
    take_dropped_by_zones(): string[];
    /**
     * Structures the repair switched off: 1 tree, 2 brace, 3 only the crossing brace segments.
     */
    take_fallback(): Uint8Array;
    take_indices(): Uint32Array;
    take_intents(): Float64Array;
    take_island_heights(): Float64Array;
    /**
     * Per island: 0 resolved, 1 unresolved, 2 resolved only through manual support, 3 unresolved but outside the policy's permitted area.
     */
    take_island_status(): Uint8Array;
    take_island_vertices(): Uint32Array;
    /**
     * `ISSUE_STRIDE` u32 per crossing of the final mesh.
     */
    take_issues(): Uint32Array;
    take_positions(): Float32Array;
    take_reach(): Float64Array;
    /**
     * Per ring: perimeter, retained contacts, largest gap, review gap, needs review (0/1).
     */
    take_rings(): Float64Array;
    take_tags(): Uint32Array;
    trials(): number;
}

/**
 * Automatic contacts: positions and normals (xyz f64), source codes (0 interior, 1 physical boundary,
 * 2 sharp ridge, 3 island), IDs, and the faces of each downward region.
 */
export class GenericPlacement {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_ids(): string[];
    take_normals(): Float64Array;
    take_positions(): Float64Array;
    take_region_faces(): Uint32Array;
    /**
     * Start of each region in `region_faces`, plus the total as the last entry.
     */
    take_region_starts(): Uint32Array;
    take_sources(): Uint8Array;
}

/**
 * The composed contacts of a unit as a `PolicyResult`: IDs, positions, normals (xyz f64), origin
 * (1 manual), point class (0 none, 1 face, 2 edge, 3 vertical) and the allowed structures
 * (pillar, tree, brace, roof, cage, raft as 0/1).
 */
export class GenericPolicyResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    permitted_faces(): number;
    take_ids(): string[];
    take_kinds(): Uint8Array;
    take_normals(): Float64Array;
    take_origins(): Uint8Array;
    take_positions(): Float64Array;
    take_structures(): Uint8Array;
}

export class GeometrySession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The legacy dental placement (a painted-from-scratch area or an older saved policy), see
     * `dental::legacy`: the generic contacts the area permits plus the downward faces filled at
     * `spacing`. Positions and normals are in the turned frame (`rotation`, Euler XYZ radians).
     */
    dental_legacy_fill(model: number, profile: string, rim: Float64Array, visibility_mask: Uint8Array, manual_area: boolean, stamps: Float64Array, rotation: Float64Array, spacing: number, overhang_angle_degrees: number, initial_positions: Float64Array, initial_normals: Float64Array): LegacyFill;
    /**
     * The unit's dental policy as a `PolicyResult` for `generate`, made from its saved area and
     * recomputed on use. `kind` 0 older saved policy, 1 area painted from scratch, 2 two-contour
     * (then `tuning` `[setback, width, density]` and the saved region arrays are required; a region
     * that detection does not reproduce permits nothing automatic). `stamps` are the unit-local area
     * edits (`STAMP_STRIDE` each), `structure` `[tree, brace]` as 0/1, `frame` the unit's placement
     * `[position xyz, rotation xyz]` the result is expressed in, `manual_positions` the unit's manual
     * tips (unit-local xyz triples): no suggested tip is offered next to one.
     */
    dental_policy(model: number, profile: string, kind: number, tuning: Float64Array, stamps: Float64Array, saved_allowed_faces: Uint8Array, saved_contact_faces: Uint8Array, saved_outer_edges: Uint32Array, saved_opening_edges: Uint32Array, structure: Uint8Array, frame: Float64Array, manual_positions: Float64Array): PolicyHandle;
    /**
     * Print-angle search over the profile's tilt range (docs/ROADMAP.md F) with the host's current
     * support settings. `on_tilt(done, total)`, when given, is called after each scanned tilt.
     */
    dental_tilt_scan(model: number, profile: string, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, on_tilt?: Function | null): DentalTiltScanResult;
    /**
     * Review layers of a loaded aligner: the contact strip, the contours and, when given, the
     * diagnostic strips (`bands`: four masks of one byte per face, or empty), the sampled
     * contacts (position then normal, 6 numbers each), and a support mesh with a tip flag per
     * triangle. Review only; nothing here is support permission.
     */
    diagnose(model: number, revision: number, profile: string, contact_faces: Uint8Array, outer_ridge_edges: Uint32Array, connector_edges: Uint32Array, opening_edges: Uint32Array, bands: Uint8Array, outer_contacts: Float64Array, inner_contacts: Float64Array, support_positions: Float32Array, support_indices: Uint32Array, tip_flags: Uint8Array): Diagnosis;
    /**
     * The support pipeline for a plate-space model: `contacts` and `shapes` as `build_supports`,
     * `policy` the unit's policy as Rust made it (same frame as the model). `timeout_ms` > 0 ends the repair and checks early with
     * an inconclusive verdict (never a clear one) once that much time has passed. `plate_y` is the
     * plate's height in the model's frame: 0 for a model placed on the plate; a lift change keeps the
     * placed model (and its caches) and moves the plate instead. Island heights are above the plate.
     */
    generate(model: number, ids: string[], contacts: Float64Array, shapes: Float64Array, settings: Float64Array, mode: number, label_text: string, zones: Float64Array, policy: PolicyHandle, timeout_ms: number, revision: number, plate_y: number, frame: Float64Array): Generation;
    /**
     * Automatic contacts of a loaded model (already in the frame they are wanted in).
     */
    generic_place(model: number, settings: Float64Array): GenericPlacement;
    /**
     * The generic policy of a unit as a `PolicyHandle` for `generate`: its contacts (automatic
     * minus deleted and zoned, plus manual; unit-local), every face of `model` permitted, the
     * structures the settings ask for, report-only repair. Arguments as `generic_policy_contacts`.
     */
    generic_policy(model: number, settings: Float64Array, auto_ids: string[], auto_positions: Float64Array, auto_normals: Float64Array, auto_sources: Uint8Array, manual_ids: string[], manual_positions: Float64Array, manual_normals: Float64Array, manual_sources: Uint8Array, deleted: string[], zones: Float64Array): PolicyHandle;
    load_mesh(positions: Float32Array, indices: Uint32Array): number;
    /**
     * `load_mesh` with a pick index built elsewhere (`build_pick_index`, in a worker): used as is,
     * not rebuilt on the first pick. An index that does not fit the mesh is `INVALID_INDEX`.
     */
    load_mesh_indexed(positions: Float32Array, indices: Uint32Array, bounds: Float32Array, links: Uint32Array, order: Uint32Array): number;
    /**
     * A copy of a loaded mesh placed by `frame` (`[position xyz, rotation xyz]`), loaded as a new
     * handle in this session: a unit's plate-space model without sending its positions again.
     */
    load_placed(handle: number, frame: Float64Array): number;
    mesh_bounds(handle: number): Float32Array;
    constructor(max_bytes: number);
    /**
     * Step 1: mesh check, orientation, central opening and whether they fit the profile.
     */
    orient_dental(model: number, profile: string): DentalOrientResult;
    /**
     * First hit of each ray (origin xyz, direction xyz, mesh-local): 5 floats per ray
     * (face or -1, distance, x, y, z). `side` 0 front, 1 back, 2 double.
     */
    pick(handle: number, rays: Float64Array, near: number, far: number, side: number): Float64Array;
    /**
     * The mesh's pick index as flat arrays (built now if it has none), to hand to another session.
     */
    pick_index(handle: number): PickIndex;
    /**
     * `pick` for canvas pixels (x, y pairs, y down); `clip_to_local` inverts projection * view * model.
     */
    pick_pixels(handle: number, clip_to_local: Float64Array, width: number, height: number, pixels: Float64Array, near: number, far: number, side: number): Float64Array;
    /**
     * Slots of the support bodies the brush stroke touches and can see (ascending). Occluders are
     * session meshes with the support-local to model-local matrices (16 f64 each) and sides.
     */
    project_brush(body_points: Float32Array, body_first: Uint32Array, occluder_handles: Uint32Array, occluder_matrices: Float64Array, occluder_sides: Uint32Array, matrix: Float64Array, eye: Float64Array, size: Float64Array, radius: number, stroke: Float64Array, start: number, end: number, want: Uint8Array): Uint32Array;
    /**
     * Detects the contours, the face cut and the contact strip, tuned by `[setback, width, density]`.
     */
    propose_dental_region(model: number, tuning: Float64Array, profile: string): DentalRegionResult;
    release_mesh(handle: number): void;
    /**
     * Recomputes the strip and contacts for accepted contours. `phase_fraction` (of the even step)
     * NaN keeps phase 0, the primaries; 0.5 samples halfway between them.
     */
    retune_dental_region(model: number, allowed_faces: Uint8Array, outer_edges: Uint32Array, opening_edges: Uint32Array, tuning: Float64Array, phase_fraction: number, profile: string): DentalRegionResult;
    /**
     * The mesh's positions through `matrix` (f64[16], column-major); `handedness` 0 keeps the
     * core frame, 1 mirrors Z for a left-handed host.
     */
    transform(handle: number, matrix: Float64Array, handedness: number): Float32Array;
    used_bytes(): number;
}

/**
 * Result of `rekey_hand_work`: the re-keyed removals, the target of each per-support settings ID
 * (empty string = dropped) and four counts (removals kept / reset, settings kept / reset).
 */
export class HandWork {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_counts(): Uint32Array;
    take_deleted(): string[];
    take_targets(): string[];
}

/**
 * The legacy dental placement result: the generic contacts kept and the face-fill contacts added.
 */
export class LegacyFill {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_ids(): string[];
    /**
     * Indices (into the generic contacts passed in) that were kept, in order.
     */
    take_kept(): Uint32Array;
    take_normals(): Float64Array;
    /**
     * Contacts the face fill added.
     */
    take_positions(): Float64Array;
}

/**
 * A mesh's pick index as flat arrays: per node `min xyz, max xyz` (`bounds`) and `start, count`
 * (`links`), then the triangle permutation (`order`). Transferable between realms.
 */
export class PickIndex {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_bounds(): Float32Array;
    take_links(): Uint32Array;
    take_order(): Uint32Array;
}

/**
 * A `PolicyResult` made in Rust (`GeometrySession.dental_policy` / `generic_policy`) and handed
 * straight to `generate`. The host never assembles one; it can only read what it needs to show.
 */
export class PolicyHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Source face per repair alternate (-1 none), in the order of `alternate_owners`.
     */
    alternate_faces(): Float64Array;
    /**
     * Per repair alternate: the candidate id it stands in for, in trial order.
     */
    alternate_owners(): string[];
    /**
     * Point xyz then normal xyz per repair alternate, in the order of `alternate_owners`.
     */
    alternate_points(): Float64Array;
    /**
     * 0 every contact as given, 1 only contacts that reproduce a candidate.
     */
    automatic(): number;
    /**
     * Source face per candidate (-1 none).
     */
    candidate_faces(): Float64Array;
    /**
     * Candidate ids, in order.
     */
    candidate_ids(): string[];
    /**
     * Point xyz then normal xyz per candidate (the frame the policy was made in).
     */
    candidate_points(): Float64Array;
    islands_outside_permitted(): boolean;
    /**
     * 1 when secondary landings are limited to the permitted faces.
     */
    landing_rule(): number;
    /**
     * One 0/1 byte per source face.
     */
    permitted_faces(): Uint8Array;
    /**
     * The aligner profile a dental policy was made with (empty for the generic policy).
     */
    profile_id(): string;
    repair_budget(): number;
    /**
     * False when a saved dental area could not be reproduced from the mesh (no automatic support).
     */
    reproduced(): boolean;
    ring_count(): number;
    /**
     * pillar, tree, brace, roof, cage, raft (1 = allowed).
     */
    structures(): Uint8Array;
    /**
     * Point xyz then normal xyz per suggested tip Add can snap to, painted or not (a dental policy only).
     */
    suggested_points(): Float64Array;
}

/**
 * Overhang spots the contacts leave unsupported: position xyz, area. (Islands are the `generate` verdict.)
 */
export class SupportProblems {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_areas(): Float64Array;
    take_positions(): Float64Array;
}

export class WeldResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_indices(): Uint32Array;
    take_positions(): Float32Array;
}

/**
 * Support bodies as axis segments; component `k` covers `indices[start[k] .. start[k] + count[k]]`
 * and belongs to contact key `contact[k]` (`0xFFFFFFFF` for none).
 */
export function body_segments(positions: Float32Array, indices: Uint32Array, contact: Uint32Array, start: Uint32Array, count: Uint32Array): BodySegmentsResult;

/**
 * The pick index of a mesh outside any session (the import worker builds it once; the main
 * thread loads it with `GeometrySession.load_mesh_indexed`).
 */
export function build_pick_index(positions: Float32Array, indices: Uint32Array): PickIndex;

/**
 * Mutates the caller's vertex buffer and returns center XYZ, then original min/max XYZ.
 */
export function center_positions_in_place(positions: Float32Array): Float64Array;

/**
 * The support check over a mesh in the frame it is checked in (Y up): `contacts` are xyz triples.
 */
export function check_support_problems(positions: Float32Array, indices: Uint32Array, contacts: Float64Array, overhang_angle_degrees: number, spacing: number): SupportProblems;

/**
 * Automatic contacts an old radius removal hid.
 */
export function contacts_hidden_by_marker_ids(auto_ids: string[], auto_positions: Float64Array, markers: string[], erase_radius: number): string[];

/**
 * Returns a simplified display copy; the caller keeps the full mesh for support and export.
 */
export function decimate_display(positions: Float32Array, indices: Uint32Array, max_triangles: number): WeldResult;

/**
 * One byte per mesh vertex: the legacy allowed-area overlay (the footprint or the paint, and
 * seen first from the opening). `normals` is one unit-frame normal per vertex, or empty.
 */
export function dental_allowed_vertices(positions: Float32Array, indices: Uint32Array, normals: Float32Array, rim: Float64Array, visibility_mask: Uint8Array, manual_area: boolean, stamps: Float64Array, profile: string): Uint8Array;

export function engine_version(): number;

export function face_mask_contour_segments(positions: Float32Array, pairs: Uint32Array): Float32Array;

export function face_mask_overlay(positions: Float32Array, indices: Uint32Array, allowed: Uint8Array): FaceOverlay;

/**
 * `generic_policy`: the contacts of a unit (unit-local space): automatic minus deleted and zoned,
 * plus manual. `face_count` is the source mesh's face count.
 */
export function generic_policy_contacts(face_count: number, settings: Float64Array, auto_ids: string[], auto_positions: Float64Array, auto_normals: Float64Array, auto_sources: Uint8Array, manual_ids: string[], manual_positions: Float64Array, manual_normals: Float64Array, manual_sources: Uint8Array, deleted: string[], zones: Float64Array): GenericPolicyResult;

/**
 * Removals that hide an automatic contact right now.
 */
export function hiding_removal_ids(auto_ids: string[], deleted: string[]): string[];

export function invert_matrix(matrix: Float64Array): Float64Array;

export function live_mesh_handles(): number;

/**
 * Placement matrix (f64[16]) of a position (mm) and Euler XYZ rotation (radians).
 */
export function placement_matrix(position: Float64Array, rotation: Float64Array): Float64Array;

/**
 * The ID each position encodes on the 0.01 mm grid (`auto-X_Y_Z`).
 */
export function position_ids(positions: Float64Array): string[];

/**
 * A finer display copy of a mesh for the zone layer (the input when it already fits).
 */
export function refine_for_overlay(positions: Float32Array, indices: Uint32Array, max_edge: number, max_triangles: number): WeldResult;

/**
 * IDs of stored automatic contacts re-derived from their positions (`rekeyPoints`).
 */
export function rekey_contact_ids(ids: string[], positions: Float64Array): string[];

export function rekey_hand_work(deleted: string[], override_ids: string[], manual_ids: string[], point_ids: string[], point_positions: Float64Array, match_radius: number): HandWork;

/**
 * The deleted IDs, re-keyed to a fresh placement (`remap_deleted`).
 */
export function remap_deleted_ids(deleted: string[], point_ids: string[], point_positions: Float64Array, match_radius: number): string[];

/**
 * Positions of any mesh (not necessarily in a session) through a matrix; see `GeometrySession.transform`.
 */
export function transform_positions(positions: Float32Array, matrix: Float64Array, handedness: number): Float32Array;

/**
 * A batch of f64 xyz triples through a matrix as points (with divide) or normalised directions.
 */
export function transform_vectors(values: Float64Array, matrix: Float64Array, direction: boolean): Float64Array;

/**
 * Lowest y of the positions through a matrix (float32 like `transform_positions`), without the copy.
 */
export function transformed_min_y(positions: Float32Array, matrix: Float64Array): number;

export function vertex_normals(positions: Float32Array, indices: Uint32Array): Float32Array;

/**
 * Transforms and welds one raw mesh; empty indices mean sequential corners.
 */
export function weld_positions_in_place(positions: Float32Array, indices: Uint32Array, matrix: Float64Array): WeldResult;

/**
 * Whether `point` is zoned by the no-support `zones` (`ZONE_STRIDE` f64 each): the last stamp that
 * reaches it decides, and an empty `normal` skips the side test. The one place the host asks the
 * stamp rule (`AreaStamp::resolve`), e.g. whether a check finding lies in a zone.
 */
export function zoned_at(zones: Float64Array, point: Float64Array, normal: Float64Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_asciistlsession_free: (a: number, b: number) => void;
    readonly __wbg_binarystlsession_free: (a: number, b: number) => void;
    readonly __wbg_bodysegmentsresult_free: (a: number, b: number) => void;
    readonly __wbg_dentalorientresult_free: (a: number, b: number) => void;
    readonly __wbg_dentalregionresult_free: (a: number, b: number) => void;
    readonly __wbg_dentaltiltscanresult_free: (a: number, b: number) => void;
    readonly __wbg_diagnosis_free: (a: number, b: number) => void;
    readonly __wbg_faceoverlay_free: (a: number, b: number) => void;
    readonly __wbg_generation_free: (a: number, b: number) => void;
    readonly __wbg_genericplacement_free: (a: number, b: number) => void;
    readonly __wbg_genericpolicyresult_free: (a: number, b: number) => void;
    readonly __wbg_geometrysession_free: (a: number, b: number) => void;
    readonly __wbg_handwork_free: (a: number, b: number) => void;
    readonly __wbg_legacyfill_free: (a: number, b: number) => void;
    readonly __wbg_pickindex_free: (a: number, b: number) => void;
    readonly __wbg_policyhandle_free: (a: number, b: number) => void;
    readonly __wbg_supportproblems_free: (a: number, b: number) => void;
    readonly __wbg_weldresult_free: (a: number, b: number) => void;
    readonly asciistlsession_finish: (a: number) => [number, number, number];
    readonly asciistlsession_new: (a: number) => [number, number, number];
    readonly asciistlsession_push: (a: number, b: number, c: number) => [number, number];
    readonly binarystlsession_finish: (a: number) => [number, number, number];
    readonly binarystlsession_new: (a: number) => [number, number, number];
    readonly binarystlsession_push: (a: number, b: number, c: number) => [number, number];
    readonly body_segments: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly bodysegmentsresult_take_first: (a: number) => [number, number];
    readonly bodysegmentsresult_take_keys: (a: number) => [number, number];
    readonly bodysegmentsresult_take_points: (a: number) => [number, number];
    readonly build_pick_index: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly center_positions_in_place: (a: number, b: number, c: any) => [number, number, number, number];
    readonly check_support_problems: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly contacts_hidden_by_marker_ids: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly decimate_display: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly dental_allowed_vertices: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly dentalorientresult_diagnostics: (a: number) => [number, number];
    readonly dentalorientresult_matches_profile: (a: number) => number;
    readonly dentalorientresult_mesh_ok: (a: number) => number;
    readonly dentalorientresult_opening: (a: number) => number;
    readonly dentalorientresult_reason: (a: number) => [number, number];
    readonly dentalorientresult_rim_scalars: (a: number) => [number, number];
    readonly dentalorientresult_rotation: (a: number) => [number, number];
    readonly dentalorientresult_status: (a: number) => number;
    readonly dentalorientresult_take_rim_points: (a: number) => [number, number];
    readonly dentalorientresult_take_visibility_mask: (a: number) => [number, number];
    readonly dentalregionresult_connector_lengths: (a: number) => [number, number];
    readonly dentalregionresult_contact_distances: (a: number) => [number, number];
    readonly dentalregionresult_contact_faces_of: (a: number) => [number, number];
    readonly dentalregionresult_contact_points: (a: number) => [number, number];
    readonly dentalregionresult_contact_rims: (a: number) => [number, number];
    readonly dentalregionresult_ok: (a: number) => number;
    readonly dentalregionresult_reason: (a: number) => [number, number];
    readonly dentalregionresult_region_faces: (a: number) => [number, number];
    readonly dentalregionresult_take_allowed_faces: (a: number) => [number, number];
    readonly dentalregionresult_take_contact_faces: (a: number) => [number, number];
    readonly dentalregionresult_take_opening_edges: (a: number) => [number, number];
    readonly dentalregionresult_take_outer_connector_edges: (a: number) => [number, number];
    readonly dentalregionresult_take_outer_edges: (a: number) => [number, number];
    readonly dentalregionresult_take_outer_ridge_edges: (a: number) => [number, number];
    readonly dentaltiltscanresult_band: (a: number) => [number, number];
    readonly dentaltiltscanresult_failing: (a: number) => [number, number];
    readonly dentaltiltscanresult_ok: (a: number) => number;
    readonly dentaltiltscanresult_order: (a: number) => [number, number];
    readonly dentaltiltscanresult_pick_reason: (a: number) => number;
    readonly dentaltiltscanresult_reason: (a: number) => [number, number];
    readonly dentaltiltscanresult_rows: (a: number) => [number, number];
    readonly dentaltiltscanresult_start_deg: (a: number) => number;
    readonly diagnosis_layer_color: (a: number, b: number) => number;
    readonly diagnosis_layer_count: (a: number) => number;
    readonly diagnosis_layer_name: (a: number, b: number) => [number, number];
    readonly diagnosis_revision: (a: number) => number;
    readonly diagnosis_take_layer_indices: (a: number, b: number) => [number, number];
    readonly diagnosis_take_layer_positions: (a: number, b: number) => [number, number];
    readonly engine_version: () => number;
    readonly face_mask_contour_segments: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly face_mask_overlay: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly faceoverlay_take_normals: (a: number) => [number, number];
    readonly faceoverlay_take_positions: (a: number) => [number, number];
    readonly generation_island_reason: (a: number) => [number, number];
    readonly generation_reason: (a: number) => [number, number];
    readonly generation_revision: (a: number) => number;
    readonly generation_status: (a: number) => number;
    readonly generation_take_contact_ids: (a: number) => [number, number];
    readonly generation_take_dropped: (a: number) => [number, number];
    readonly generation_take_dropped_by_zones: (a: number) => [number, number];
    readonly generation_take_fallback: (a: number) => [number, number];
    readonly generation_take_indices: (a: number) => [number, number];
    readonly generation_take_intents: (a: number) => [number, number];
    readonly generation_take_island_heights: (a: number) => [number, number];
    readonly generation_take_island_status: (a: number) => [number, number];
    readonly generation_take_island_vertices: (a: number) => [number, number];
    readonly generation_take_issues: (a: number) => [number, number];
    readonly generation_take_positions: (a: number) => [number, number];
    readonly generation_take_reach: (a: number) => [number, number];
    readonly generation_take_rings: (a: number) => [number, number];
    readonly generation_take_tags: (a: number) => [number, number];
    readonly generation_trials: (a: number) => number;
    readonly generic_policy_contacts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number) => [number, number, number];
    readonly genericplacement_take_ids: (a: number) => [number, number];
    readonly genericplacement_take_normals: (a: number) => [number, number];
    readonly genericplacement_take_positions: (a: number) => [number, number];
    readonly genericplacement_take_region_faces: (a: number) => [number, number];
    readonly genericplacement_take_region_starts: (a: number) => [number, number];
    readonly genericplacement_take_sources: (a: number) => [number, number];
    readonly genericpolicyresult_permitted_faces: (a: number) => number;
    readonly genericpolicyresult_take_ids: (a: number) => [number, number];
    readonly genericpolicyresult_take_kinds: (a: number) => [number, number];
    readonly genericpolicyresult_take_normals: (a: number) => [number, number];
    readonly genericpolicyresult_take_origins: (a: number) => [number, number];
    readonly genericpolicyresult_take_positions: (a: number) => [number, number];
    readonly genericpolicyresult_take_structures: (a: number) => [number, number];
    readonly geometrysession_dental_legacy_fill: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => [number, number, number];
    readonly geometrysession_dental_policy: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number) => [number, number, number];
    readonly geometrysession_dental_tilt_scan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly geometrysession_diagnose: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number, number];
    readonly geometrysession_generate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => [number, number, number];
    readonly geometrysession_generic_place: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_generic_policy: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [number, number, number];
    readonly geometrysession_load_mesh: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly geometrysession_load_mesh_indexed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly geometrysession_load_placed: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_mesh_bounds: (a: number, b: number) => [number, number, number, number];
    readonly geometrysession_new: (a: number) => number;
    readonly geometrysession_orient_dental: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_pick: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly geometrysession_pick_index: (a: number, b: number) => [number, number, number];
    readonly geometrysession_pick_pixels: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly geometrysession_project_brush: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [number, number, number, number];
    readonly geometrysession_propose_dental_region: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly geometrysession_release_mesh: (a: number, b: number) => [number, number];
    readonly geometrysession_retune_dental_region: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly geometrysession_transform: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly geometrysession_used_bytes: (a: number) => number;
    readonly handwork_take_counts: (a: number) => [number, number];
    readonly handwork_take_deleted: (a: number) => [number, number];
    readonly handwork_take_targets: (a: number) => [number, number];
    readonly hiding_removal_ids: (a: number, b: number, c: number, d: number) => [number, number];
    readonly invert_matrix: (a: number, b: number) => [number, number, number, number];
    readonly legacyfill_take_ids: (a: number) => [number, number];
    readonly legacyfill_take_kept: (a: number) => [number, number];
    readonly legacyfill_take_normals: (a: number) => [number, number];
    readonly legacyfill_take_positions: (a: number) => [number, number];
    readonly live_mesh_handles: () => number;
    readonly pickindex_take_bounds: (a: number) => [number, number];
    readonly pickindex_take_links: (a: number) => [number, number];
    readonly pickindex_take_order: (a: number) => [number, number];
    readonly placement_matrix: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly policyhandle_alternate_faces: (a: number) => [number, number];
    readonly policyhandle_alternate_owners: (a: number) => [number, number];
    readonly policyhandle_alternate_points: (a: number) => [number, number];
    readonly policyhandle_automatic: (a: number) => number;
    readonly policyhandle_candidate_faces: (a: number) => [number, number];
    readonly policyhandle_candidate_ids: (a: number) => [number, number];
    readonly policyhandle_candidate_points: (a: number) => [number, number];
    readonly policyhandle_islands_outside_permitted: (a: number) => number;
    readonly policyhandle_landing_rule: (a: number) => number;
    readonly policyhandle_permitted_faces: (a: number) => [number, number];
    readonly policyhandle_profile_id: (a: number) => [number, number];
    readonly policyhandle_repair_budget: (a: number) => number;
    readonly policyhandle_reproduced: (a: number) => number;
    readonly policyhandle_ring_count: (a: number) => number;
    readonly policyhandle_structures: (a: number) => [number, number];
    readonly policyhandle_suggested_points: (a: number) => [number, number];
    readonly position_ids: (a: number, b: number) => [number, number, number, number];
    readonly refine_for_overlay: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly rekey_contact_ids: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly rekey_hand_work: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly remap_deleted_ids: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly supportproblems_take_areas: (a: number) => [number, number];
    readonly supportproblems_take_positions: (a: number) => [number, number];
    readonly transform_positions: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly transform_vectors: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly transformed_min_y: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly vertex_normals: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly weld_positions_in_place: (a: number, b: number, c: any, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly weldresult_take_indices: (a: number) => [number, number];
    readonly weldresult_take_positions: (a: number) => [number, number];
    readonly zoned_at: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
