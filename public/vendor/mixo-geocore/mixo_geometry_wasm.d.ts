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
     * What the trim found (engine 13, `dental::trim`): 0 open arch (the trim plane and its U ends
     * decided up and front), 1 ring (a U bridged by a plate; the floor rule decided), 2 not oriented.
     */
    arch_kind(): number;
    /**
     * Whether the rule that did not decide agrees on up/down: 0 agrees, 1 inconclusive, 2 disagrees
     * (the host reports a disagreement as needing a look; nothing resolves it silently).
     */
    cross_check(): number;
    /**
     * confidence, floor offset ratio (how far the axis-facing floor leans toward one end), axial variance ratio.
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
     * bitangent (3 each), visibility resolution, visibility min (2), visibility max (2), whether the
     * trim's U decided a front (0/1), that front (3; zeros without one).
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
 * The rim built from a loop the operator drew on the surface. Deliberately NOT a
 * `DentalOrientResult`: that result also carries `diagnostics`, `opening`, `arch` and
 * `cross_check`, which are measurements of a detection that did not happen here, and a drawn rim
 * has no honest value for any of them. The three rim getters keep the orient result's names and
 * shapes, so the host reads either with one decoder.
 */
export class DentalRimResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Whether `flip` reversed the side the floor rule chose.
     */
    flipped(): boolean;
    /**
     * The side evidence: `orient::floor_offset` along the fitted plane normal before any flip, in
     * [-1, 1]. Positive means the axis-facing floor area leans the way that normal points, so the
     * opening was taken to face the other way. Near zero the floor decides nothing - that is what
     * `rim-side-uncertain` reports.
     */
    floor_offset(): number;
    /**
     * False when the drawn points fit no plane (a normal result, not a throw); `reason` says why.
     */
    ok(): boolean;
    /**
     * `rim-collinear` when the points lie on a line; `rim-side-uncertain` on an otherwise good rim
     * whose floor lean did not reach the profile's minimum, so the side needs the operator's eye
     * (see `floor_offset`). Empty when the side is certain.
     */
    reason(): string;
    /**
     * As `DentalOrientResult::rim_scalars` (22 values, same layout); empty when not `ok`.
     */
    rim_scalars(): Float64Array;
    /**
     * The drawn loop points as f32 xyz triples, as given.
     */
    take_rim_points(): Float32Array;
    /**
     * The visibility footprint, `resolution * resolution` bytes, built by the engine's own
     * rasteriser exactly as an orientation-derived rim's is.
     */
    take_visibility_mask(): Uint8Array;
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
     * Denture scan: per row, how many lowest points no support can reach at that tilt; empty for the aligner scan or with the rule off.
     */
    boxed_counts(): Uint32Array;
    /**
     * Denture scan: the picked row's boxed-in lowest points, x y z each (mesh frame, mm).
     */
    boxed_points(): Float64Array;
    /**
     * Denture scan: why each of `boxed_points()` is boxed in, same order.
     */
    boxed_reasons(): string[];
    /**
     * Denture scan (engine 35): per row, how many lowest points the tilt pick counted; empty with no lowest-point score on.
     */
    counted_lows(): Uint32Array;
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
     * Denture scan with rule `landingTiltWeight` above 0 (engine 32): per row 4 numbers, lowest points without a path, tips without a path,
     * tips with only a fallback path, tips; empty otherwise.
     */
    path_counts(): Uint32Array;
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
    /**
     * Denture scan with rule `tiltPickOrder` 1 (engine 35): per row 2 numbers, tips needed, tips in unwanted areas; empty otherwise.
     */
    tip_counts(): Uint32Array;
}

/**
 * Support-area comparison: per-face classes and the three areas (mm^2).
 */
export class DentureAreaResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Owner area, generated area, area in both (mm^2).
     */
    areas(): Float64Array;
    /**
     * Per face: 0 neither, 1 owner only, 2 generated only, 3 both.
     */
    mask(): Uint8Array;
}

/**
 * One mesh's live tilt view. Failed to prepare (the mesh cannot be oriented): `ok() == false` with `reason()`.
 */
export class DentureLiveTilt {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Does the per-model work for `positions` / `indices` (moved in) under the denture profile `profile`, with the scan settings and
     * the rule overrides (`rules` in `rule_names()` order, NaN keeps the default) `denture_tilt_paths` takes.
     */
    constructor(positions: Float32Array, indices: Uint32Array, profile: string, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, rules: Float64Array);
    /**
     * False when the per-model work failed (see `reason`); `paths` then answers failed for every tilt.
     */
    ok(): boolean;
    /**
     * The tips and path states at `tilt_deg` (degrees from upright), as `denture_tilt_paths` gives them.
     */
    paths(tilt_deg: number): DentureTiltPaths;
    /**
     * Why the per-model work failed (`orientation-...`); empty when ok.
     */
    reason(): string;
}

/**
 * Step 1 result for a denture. Failed: `status() == 1` with `reason()`. Oriented: `status() == 0`.
 */
export class DentureOrientResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * flatness (smallest / largest covariance eigenvalue), legs gap ratio, teeth offset mm.
     */
    diagnostics(): Float64Array;
    /**
     * The arch frame: centroid, up (apex direction), teeth side, across (3 each); empty when failed.
     */
    frame(): Float64Array;
    /**
     * Failure reason (`too-few-vertices`, `no-arch-plane`, `no-legs`, `both-ends-split`), empty when oriented.
     */
    reason(): string;
    /**
     * Euler XYZ radians turning the mesh upright (tilt 0); empty when failed.
     */
    rotation(): Float64Array;
    status(): number;
    /**
     * False when the teeth side's lean was below the profile's minimum (a side was still taken;
     * the host reports it as needing a look).
     */
    teeth_decided(): boolean;
}

/**
 * The review layers of the owner denture rules, flat numbers in the mesh frame (mm).
 */
export class DentureReviewResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Step 2, per face: 1 when a ray from the back origin reaches it first (ALLOWED; overrides no-support; tips stand only here), else 0.
     */
    allowed_mask(): Uint8Array;
    /**
     * Per open-area region `[projected mm2, steepness, height mm, pitch mm, faces, tips]`, six values each (engine 45, rule `areaDensity`); empty with the rule off.
     */
    area_regions(): Float64Array;
    /**
     * Tight box: centre (3, the line-of-sight point), axes (9), half extents (3).
     */
    box_(): Float64Array;
    /**
     * Length (mm) of each chain.
     */
    chain_lengths(): Float64Array;
    /**
     * The continuous down-edge chains: `x y z` per point, chains back to back (sizes in `chain_sizes`).
     */
    chain_points(): Float64Array;
    /**
     * Point count of each chain.
     */
    chain_sizes(): Uint32Array;
    /**
     * The hard edges that face down in the oriented pose (before the print tilt), same layout.
     */
    down_edges(): Float64Array;
    /**
     * Overhang candidates, per face: 1 when within 60 degrees of straight down for the reviewed plate normal.
     */
    down_mask(): Uint8Array;
    /**
     * Per face: the pocket level (1..4), 5 on a hard-to-clean socket, 0 elsewhere: the layer "Drain / clean". Empty with `trapCheck` off.
     */
    drain_mask(): Uint8Array;
    /**
     * Pockets that hold resin after printing (engine 44): 10 numbers each: volume mm3, depth mm, opening width mm, aspect (depth / width), area mm2, vented 0/1, level (1 drains, 2 low, 3 medium, 4 high), floor x y z.
     */
    drain_pockets(): Float64Array;
    /**
     * Tooth sockets at least `drainSocketDepthMm` deep (hard to clean): 6 numbers each: depth mm, area mm2, width mm, floor x y z.
     */
    drain_sockets(): Float64Array;
    /**
     * The part id of every face of the file (engine 50; the layer "Parts"); every review runs on the target part.
     */
    face_parts(): Uint32Array;
    /**
     * The fitting basin against the zones, face counts: fitting, fitting and allowed, fitting and no-support, fitting and neither, allowed but not fitting.
     */
    fitting_check(): Uint32Array;
    /**
     * Per face: 1 on the fitting surface seen as a basin from the tissue side (a cross-check layer; it changes no tip).
     */
    fitting_mask(): Uint8Array;
    /**
     * Every hard edge as segments `ax ay az bx by bz`.
     */
    hard_edges(): Float64Array;
    /**
     * Per face: 1 within 5 mm along the surface of a hole (support-allowed).
     */
    hole_band_mask(): Uint8Array;
    /**
     * Per hole: area (mm2), faces next to it.
     */
    hole_info(): Float64Array;
    /**
     * The hole outlines (hit points around each hole seen along the teeth axis), `x y z` points back to back.
     */
    hole_outlines(): Float64Array;
    /**
     * Point count of each hole outline.
     */
    hole_sizes(): Uint32Array;
    /**
     * The islands of the reviewed pose, 9 numbers each (layout as `PolicyHandle::island_facts`; the serving tip index counts into `tips`). Empty with the rule `islandTips` off.
     */
    islands(): Float64Array;
    /**
     * Why the islands could not be told; empty when they could.
     */
    islands_note(): string;
    /**
     * Low points that got a tip (xyz each).
     */
    low_tip_points(): Float64Array;
    /**
     * Per low tip: 0 allowed, 1 outside the no-support zone, 2 within lowRimBandMm of the rim, 3 anywhere (lowOutsideAllowed 2).
     */
    low_tip_reasons(): Uint8Array;
    /**
     * The island and lowest-point tips standing on a socket (kept), xyz each.
     */
    lows_in_sockets(): Float64Array;
    /**
     * Island and lowest-point tips on a face that is not down-facing, xyz triples (engine 39).
     */
    lows_not_down_facing(): Float64Array;
    /**
     * Low points outside the allowed area (left unsupported), `x y z` each.
     */
    lows_outside(): Float64Array;
    /**
     * The face of each `lows_outside` point.
     */
    lows_outside_faces(): Uint32Array;
    /**
     * Allowed low points no tip reaches, `x y z` each.
     */
    lows_unreached(): Float64Array;
    /**
     * The face of each `lows_unreached` point.
     */
    lows_unreached_faces(): Uint32Array;
    /**
     * The unit 45 degree no-support ray direction xyz.
     */
    no_support_dir(): Float64Array;
    /**
     * Step 1, per face: 1 when a 45 degree front-top parallel ray hits it first (NO_SUPPORT before the override), else 0.
     */
    no_support_mask(): Uint8Array;
    /**
     * The R1b angle in degrees, 0 when off (engine 36).
     */
    no_support_steep_deg(): number;
    /**
     * Per face: 1 when only R1b (the steep no-support ray, rule `noSupportSteepDeg`) hits it first, not R1; a subset of `no_support_mask`; all 0 with R1b off (engine 36).
     */
    no_support_steep_mask(): Uint8Array;
    /**
     * Oral cavity ray origin xyz: on the rim plane, at the back edge of the tight box, on the symmetry plane (the allowed-area rays start here).
     */
    oral_cavity_ray(): Float64Array;
    /**
     * The file's parts, 6 numbers each: id, role (0 target, 1 add-on, 2 debris), triangles, volume mm3, area mm2, review tips on it.
     */
    part_list(): Float64Array;
    /**
     * Pillar geometry inputs: contact ball diameter, frustum base diameter, neck length, pillar diameter, lift (mm).
     */
    pillar(): Float64Array;
    /**
     * Candidates released because their face is not an overhang for the plate normal.
     */
    released(): number;
    /**
     * Per face: 1 within the dental rim band of the dental rim (support-allowed; overhanging band faces get dental rim tips).
     */
    rim_band_mask(): Uint8Array;
    /**
     * Per rim polyline: 1 when closed (the last edge joins the last point to the first).
     */
    rim_closed(): Uint8Array;
    /**
     * Mesh edge ids of the rim polylines, back to back (a closed line has as many edges as points, an open one one fewer).
     */
    rim_edges(): Uint32Array;
    /**
     * Total rim length (mm), line count, all the way around 0/1, largest empty stretch (deg); zeros without a rim.
     */
    rim_info(): Float64Array;
    /**
     * The rim (engine 20): one or more ordered polylines of mesh vertex positions, `x y z` each, back to back.
     */
    rim_loops(): Float64Array;
    /**
     * Local lows of the dental rim whose face points up: no tip (rule `rimLowNeedsOverhang`); not "left out".
     */
    rim_lows_facing_up(): number;
    /**
     * Rim plane: point xyz, unit normal xyz pointing to the top; empty without a rim.
     */
    rim_plane(): Float64Array;
    /**
     * Point count of each rim polyline.
     */
    rim_sizes(): Uint32Array;
    /**
     * Faces of the self-supporting overhang regions (rule `overhangSelfSupport`, engine 38): they get no open-area tips; empty with the rule off.
     */
    self_support_faces(): Uint32Array;
    /**
     * `[overhang regions, self-supporting regions, open-area tips saved]` (engine 38); zeros with the rule off.
     */
    self_support_info(): Float64Array;
    /**
     * Per face: 1 on a tooth socket (`dental/denture/sockets.rs`, rule `socketMinDepthMm`), shown whether or not `socketNoSupport` is on.
     */
    socket_mask(): Uint8Array;
    /**
     * Basin faces the allowed area covers (R2 and the hole band), so not sockets (the allowed area cancels the socket mask, engine 59).
     */
    sockets_cancelled_by_r2(): number;
    /**
     * Suction cups at the reviewed tilt (engine 44, rule `trapCheck`): 10 numbers each: area mm2 (projected on the plate), volume mm3, depth mm, rim min and max height mm (above the model's lowest point along the print up), vented 0/1, level (1 vented, 2 low, 3 medium, 4 high), floor x y z. Empty with `trapCheck` off.
     */
    suction_cups(): Float64Array;
    /**
     * Per face: the level of the suction cup it belongs to (0 none): the layer "Suction cups". Empty with `trapCheck` off.
     */
    suction_mask(): Uint8Array;
    /**
     * Symmetry plane (splits the U left/right): point xyz, unit normal xyz.
     */
    symmetry_plane(): Float64Array;
    /**
     * The mesh face each tip stands on, in `tips` order.
     */
    tip_faces(): Uint32Array;
    /**
     * Generated tips, `x y z nx ny nz stream` each (0 low, 1 area, 4 rim, 5 hole, 6 island).
     */
    tips(): Float64Array;
    /**
     * Tips the final guard refused (`overhangAngleDeg`, engine 39), `[rim, hole, area, other]`.
     */
    tips_dropped_facing_up(): Uint32Array;
    /**
     * `socketNoSupport`: tips kept off sockets [rim, hole, area, other].
     */
    tips_dropped_socket(): Uint32Array;
    /**
     * Tips skipped for a knife-sharp fold or a neck that would enter the material behind a nearby face (engine 39), `[rim, hole, area, other]`.
     */
    tips_skipped_fold(): Uint32Array;
    /**
     * Tips on an overhang with no free path to the plate, same layout as `tips`; not built.
     */
    unsupportable(): Float64Array;
    /**
     * The oriented pose's plate normal (up) in the mesh frame, xyz.
     */
    up(): Float64Array;
    /**
     * The up decision (layout in `denture/review.rs` `up_decision_values`): T1b diagnostic (box axis, decided, flipped, medians, margin, hits), up xyz, arch frame up before xyz, slice votes (for, against, abstain), confidence, top xyz, teeth flipped, back xyz, front/back margin, cross-check agrees, end widths; empty for a mesh with no box.
     */
    up_decision(): Float64Array;
}

/**
 * One tilt's tips with their path states. Failed: `ok() == false` with `reason()`.
 */
export class DentureTiltPaths {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Lowest points without a path, tips without a path, tips with only a fallback path, tips.
     */
    counts(): Uint32Array;
    ok(): boolean;
    /**
     * Area (mm2) of the faces steeper than the overhang angle at this tilt.
     */
    overhang_mm2(): number;
    /**
     * Why the call could not run (`invalid-scan-input` or an upright reason `orientation-...`); empty when ok.
     */
    reason(): string;
    /**
     * Euler XYZ (radians) turning the mesh into this print pose.
     */
    rotation(): Float64Array;
    /**
     * Per tip, same order: 0 path, 1 fallback, 2 none.
     */
    states(): Uint8Array;
    /**
     * The tips (mesh frame): `x y z nx ny nz stream` each (stream 0 low, 1 area, 4 rim, 5 hole, 6 island).
     */
    tips(): Float64Array;
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
     * Rule `contactFit` (engine 45): the built contact ends by fit state `[fitted, seat, unconverged]`; zeros with the rule off.
     */
    contact_fits(): Uint32Array;
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
    /**
     * The full sentence when the time rule stopped the build ("stopped: no progress for 30 s"); empty otherwise.
     */
    stop_reason(): string;
    take_contact_ids(): string[];
    take_dropped(): string[];
    take_dropped_by_zones(): string[];
    /**
     * Structures the repair switched off: 1 tree, 2 brace, 3 only the crossing brace segments.
     */
    take_fallback(): Uint8Array;
    /**
     * The case's footprint on the plate (engine 53, `supports::plate::footprint`), as `arrange_plate` reads one case: the loop count,
     * then per loop its point count and x z per point (plate plan, mm, largest loop first); `[0]` without a model.
     */
    take_footprint(): Float64Array;
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
    /**
     * Last-resort tips: the pillar clearance (mm) each was judged and verified at.
     */
    take_last_resort_clearances(): Float64Array;
    /**
     * Tips the last-resort tier placed (denture builds): ids.
     */
    take_last_resort_ids(): string[];
    /**
     * Last-resort tips: the tier of each (1 the outline lean limit relaxed, 2 the clearance stepped down as well).
     */
    take_last_resort_tiers(): Uint8Array;
    /**
     * Left-out contacts with a reason: ids.
     */
    take_left_out_ids(): string[];
    /**
     * Left-out contacts: x y z of each tip (plate frame, mm).
     */
    take_left_out_points(): Float64Array;
    /**
     * Left-out contacts: the reason of each, `step` or `step:part` (build-omission, leave-out:pillar, leave-out:neck, all-manual, structures-off-leave-out, structure-fallback).
     */
    take_left_out_reasons(): string[];
    /**
     * Tips supported from the model's own surface (dental option `dentalModelLanding` / the allow list): ids.
     */
    take_model_landed_ids(): string[];
    /**
     * Model-landed tips: x y z of each landing point (plate frame, mm).
     */
    take_model_landed_points(): Float64Array;
    /**
     * Model-landed tips: the landing tier of each (1 allowed area, 2 other surface, 3 no-support zone).
     */
    take_model_landed_tiers(): Uint8Array;
    take_positions(): Float32Array;
    take_reach(): Float64Array;
    /**
     * Per ring: perimeter, retained contacts, largest gap, review gap, needs review (0/1).
     */
    take_rings(): Float64Array;
    take_tags(): Uint32Array;
    /**
     * Unresolved report: the best gap (mm) at which a route from the plate was found, NaN when none was found or searched.
     */
    take_unresolved_best_gaps(): Float64Array;
    /**
     * Unresolved report (every tip still left out and every island no support reaches): ids (`island-<vertex>` for an island with no tip).
     */
    take_unresolved_ids(): string[];
    /**
     * Unresolved report (engine 51): what each entry is, `island`, `lowest` (a lowest-point tip left out, or a lowest point with no tip) or `tip`.
     */
    take_unresolved_kinds(): string[];
    /**
     * Unresolved report: the gap (mm) the build needs, per entry.
     */
    take_unresolved_needed(): Float64Array;
    /**
     * Unresolved report (engine 51): the outward surface normal per entry, xyz (plate frame; an island: straight down), for `reroute_support`.
     */
    take_unresolved_normals(): Float64Array;
    /**
     * Unresolved report: x y z of each (plate frame, mm; the height above the plate is y minus the plate's).
     */
    take_unresolved_points(): Float64Array;
    /**
     * Unresolved report: why, in words.
     */
    take_unresolved_reasons(): string[];
    /**
     * Unresolved report: the stream of each (low, area, bar, light, rim, hole, island; empty for a tip of another policy).
     */
    take_unresolved_streams(): string[];
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
     * The rim for a hand-drawn loop, for an aligner whose rim detection found none: the same
     * scalars, loop points and 96 x 96 visibility mask an orient result carries, built by the same
     * rasteriser. Which way the opening faces comes from the floor rule detection itself uses, not
     * from the loop's winding, and `floor_offset()` reports the measurement behind it.
     */
    dental_rim_from_points(model: number, points: Float32Array, flip: boolean, profile: string): DentalRimResult;
    /**
     * Print-angle search over the profile's tilt range (docs/ROADMAP.md F) with the host's current
     * support settings. `on_tilt(done, total)`, when given, is called after each scanned tilt.
     */
    dental_tilt_scan(model: number, profile: string, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, on_tilt?: Function | null): DentalTiltScanResult;
    /**
     * Classes every face by whether it lies within `radius_mm` of the owner points, of the generated points, of both or neither.
     */
    denture_compare_areas(model: number, owner: Float64Array, generated: Float64Array, radius_mm: number): DentureAreaResult;
    /**
     * The denture policy of a unit as a `PolicyResult` for `generate`: every face permitted, the
     * pose's tips as candidates (lowest points, bottom band, bars, light fill), pillars may land on
     * the model, Tree off, Brace by `brace`. `frame` is the unit's placement `[position xyz,
     * rotation xyz]` the result is expressed in (its +Y is the plate normal the tips are placed
     * for); `manual_positions` the unit's manual tips (unit-local xyz triples) to keep clear of.
     */
    denture_policy(model: number, profile: string, frame: Float64Array, brace: boolean, manual_positions: Float64Array): PolicyHandle;
    /**
     * [`denture_policy`] with the host's rule overrides (`rules`, one entry per name of `rule_names()`; a missing or NaN entry keeps
     * Rust's default). The rules `islandTips`, `islandMinAreaMm2`, `lowOutsideAllowed`, `islandReuseMm` and `islandSlabMm` apply: an
     * island tip (candidate source "island") stands at the lowest vertex of each island of the pose, and the handle's
     * `island_facts()` reports every island.
     */
    denture_policy_ruled(model: number, profile: string, frame: Float64Array, brace: boolean, manual_positions: Float64Array, rules: Float64Array): PolicyHandle;
    /**
     * The review layers of the owner denture rules on a loaded mesh (independent of its import orientation) at the print tilt `tilt_deg` (0 = canonical).
     */
    denture_review(model: number, profile: string, tilt_deg: number): DentureReviewResult | undefined;
    /**
     * [`denture_review`] with the host's rule overrides (`rules`, `rule_names()` order; empty keeps the defaults): the island tips and the low-tip admission (`lowOutsideAllowed`) apply.
     */
    denture_review_ruled(model: number, profile: string, tilt_deg: number, rules: Float64Array): DentureReviewResult | undefined;
    /**
     * The live tilt view (engine 32): the tips of one print tilt with, per tip, whether a support has a way down by the landing circle
     * (`path` 0, `fallback` 1, `none` 2), and no supports built. The per-model work (rim, holes, masks, ray index, upright frame) is
     * cached by the engine per model, so after the first call a tilt costs tens of milliseconds. `rules` as `denture_tilt_scan_ruled`.
     */
    denture_tilt_paths(model: number, profile: string, tilt_deg: number, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, rules: Float64Array): DentureTiltPaths;
    /**
     * Print-angle search of a denture from upright over the profile's range, with the host's
     * current support settings; rows as `dental_tilt_scan` (fitting-side tips and rim gap are 0).
     * `on_tilt(done, total)`, when given, is called after each scanned tilt. The default support
     * rules apply (`denture_tilt_scan_ruled` takes the host's).
     */
    denture_tilt_scan(model: number, profile: string, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, on_tilt?: Function | null): DentalTiltScanResult;
    /**
     * [`denture_tilt_scan`] with the host's support-rule overrides (`rules`, one entry per name of `rule_names()`; a missing or NaN
     * entry keeps Rust's default). The rule `boxedInTiltWeight` (default 1) makes the pick prefer the tilt with the fewest lowest
     * points no support can reach; 0 turns that off. The result then also carries `boxed_counts()` (per row), `boxed_points()` and
     * `boxed_reasons()` (the picked row's boxed-in points).
     */
    denture_tilt_scan_ruled(model: number, profile: string, neck_length_mm: number, pillar_diameter_mm: number, lift_mm: number, braced: boolean, rules: Float64Array, on_tilt?: Function | null): DentalTiltScanResult;
    /**
     * Review layers of a loaded aligner: the contact strip, the contours and, when given, the
     * diagnostic strips (`bands`: four masks of one byte per face, or empty), the sampled
     * contacts (position then normal, 6 numbers each), and a support mesh with a tip flag per
     * triangle. Review only; nothing here is support permission.
     */
    diagnose(model: number, revision: number, profile: string, contact_faces: Uint8Array, outer_ridge_edges: Uint32Array, connector_edges: Uint32Array, opening_edges: Uint32Array, bands: Uint8Array, outer_contacts: Float64Array, inner_contacts: Float64Array, support_positions: Float32Array, support_indices: Uint32Array, tip_flags: Uint8Array): Diagnosis;
    /**
     * Step 1 evidence layers of a loaded aligner (`dental::review_orientation`): the detected trim
     * chains, the two U ends, the bottom plane's outline and the back arrow. Review only.
     */
    diagnose_orientation(model: number, revision: number, profile: string): Diagnosis;
    /**
     * A policy with nothing in it, for a live edit call that does not use the policy (`reroute_support` with `allow_model_landing` false).
     */
    empty_policy(): PolicyHandle;
    /**
     * The support pipeline for a plate-space model: `contacts` and `shapes` as `build_supports`,
     * `policy` the unit's policy as Rust made it (same frame as the model). `limits` overrides the time rule
     * (`supports::time_limits::TimeRules::from_overrides`: base, per tip, per 100k triangles, stall, ceiling; ms; a missing or NaN
     * entry keeps the default, an empty array keeps them all). The build gets a start allowance by size, is extended while it
     * progresses, and stops with an inconclusive verdict (never a clear one) after the stall window or at the ceiling;
     * `stop_reason()` then holds the sentence. `rules` overrides the planner's rules (`supports::rules::SupportRules::from_overrides`,
     * one entry per name of `rule_names()`; a missing or NaN entry keeps Rust's default). `plate_y` is the
     * plate's height in the model's frame: 0 for a model placed on the plate; a lift change keeps the
     * placed model (and its caches) and moves the plate instead. Island heights are above the plate.
     * `on_phase` (optional, engine 60) is called as `(phase, done, total)` at each phase of the build (`supports::phase::Phase::name`: preparing,
     * routing, placing, bracing, raft, checking, judging, finishing, writing); `total` is 0 at a phase's entry and the tips counted in routing and placing;
     * a repair round can repeat the build phases. It changes nothing in the result.
     */
    generate(model: number, ids: string[], contacts: Float64Array, shapes: Float64Array, settings: Float64Array, mode: number, label_text: string, zones: Float64Array, policy: PolicyHandle, limits: Float64Array, rules: Float64Array, revision: number, plate_y: number, frame: Float64Array, on_phase?: Function | null): Generation;
    /**
     * Automatic contacts of a loaded model (already in the frame they are wanted in). `rules` (optional, engine 47): the
     * `supports::rules::NAMES` override array (`areaDensity`, the edge rules); absent or NaN entries keep the engine defaults.
     */
    generic_place(model: number, settings: Float64Array, rules?: Float64Array | null): GenericPlacement;
    /**
     * The generic policy of a unit as a `PolicyHandle` for `generate`: its contacts (automatic
     * minus deleted and zoned, plus manual; unit-local), every face of `model` permitted, the
     * structures the settings ask for, and `repair_budget` safety-repair trials (0: report only). Arguments as `generic_policy_contacts`.
     */
    generic_policy(model: number, settings: Float64Array, auto_ids: string[], auto_positions: Float64Array, auto_normals: Float64Array, auto_sources: Uint8Array, manual_ids: string[], manual_positions: Float64Array, manual_normals: Float64Array, manual_sources: Uint8Array, deleted: string[], zones: Float64Array, repair_budget: number): PolicyHandle;
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
     * Step 1 for a denture: the upright frame (arch plane vertical, legs down, teeth side) and its rotation.
     */
    orient_denture(model: number, profile: string): DentureOrientResult;
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
     * Where the pillar of that support may stand (`skeleton::edit::pillar_reach`): a grid mask around the
     * tip, `radius_mm` out at `grid_mm` a cell; `judged` false gives the cheap space-map answer, true judges
     * every cell's support. `take_pieces()` holds [x0, z0, cell, nx, nz, then nx*nz cells as 0/1, row by row].
     */
    pillar_reach(model: number, settings: Float64Array, rules: Float64Array, tip: Float64Array, normal: Float64Array, plate_y: number, radius_mm: number, grid_mm: number, judged: boolean): Reroute;
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
     * Live edit of one support (`skeleton::edit::reroute_support`): the tip at `tip` (xyz, plate frame)
     * with outward `normal`, its pillar dragged to plan (`x`, `z`); `settings` and `rules` as `generate`'s
     * (the capsule judge's margin comes from the rules). The result's `take_pieces()` is the skeleton, nine
     * numbers per piece: kind (0 tip cone, 1 neck, 2 rod, 3 transition, 4 trunk, 5 joint, 6 brace, 7 foot),
     * the piece's two points (xyz each; a joint or foot repeats its point) and its two radii (mm). Empty
     * with `refusal()` naming the rule that refused (too far, under the floor, clearance). With `allow_model_landing` (dental option) a spot the plate
     * route refuses, or no spot (`x` or `z` NaN), falls to a column that ends on the model's own surface (best tier first: allowed area, other surface,
     * no-support zone): `landing_tier()` is then 1, 2 or 3 and `landing_point()` holds the landing; `policy` supplies the tier masks and `zones`
     * (`packZones`) the painted no-support stamps. Otherwise `policy` and `zones` are ignored (`empty_policy()`, an empty array).
     */
    reroute_support(model: number, settings: Float64Array, rules: Float64Array, tip: Float64Array, normal: Float64Array, x: number, z: number, plate_y: number, allow_model_landing: boolean, policy: PolicyHandle, zones: Float64Array): Reroute;
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
 * The diagnosis of one mesh: what the file is, with nothing changed.
 */
export class MeshDiagnosis {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `BODY_SCALARS` values per physical body, in body id order (moved out).
     */
    take_bodies(): Float64Array;
    /**
     * `LOOP_SCALARS` values per boundary loop (moved out).
     */
    take_loops(): Float64Array;
    /**
     * The whole-mesh roll-up, `MESH_SCALARS` values (moved out).
     */
    take_mesh(): Float64Array;
}

/**
 * The result of a repair: the mesh plus the report of every step.
 */
export class MeshRepairResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Whether any step changed anything. False means the arrays below are the caller's own,
     * element for element (a clean mesh is returned bit-identical).
     */
    changed(): boolean;
    /**
     * False when a step would have moved a face between physical bodies: the repair was abandoned
     * and `take_positions` / `take_indices` give the file back exactly as it came in. A normal
     * result, not a throw; `reason` names the step. The `before` report is filled either way.
     */
    ok(): boolean;
    /**
     * Empty when `ok`. Otherwise `body-invariant:<step>`, the step being `weld`, `degenerate`,
     * `manifold` or `winding`.
     */
    reason(): string;
    /**
     * The file as it leaves repair: `MESH_SCALARS` values (moved out).
     */
    take_after(): Float64Array;
    /**
     * The file as it came in: `MESH_SCALARS` values (moved out).
     */
    take_before(): Float64Array;
    /**
     * Bodies after repair, `BODY_SCALARS` each (moved out).
     */
    take_bodies_after(): Float64Array;
    /**
     * Bodies before repair, `BODY_SCALARS` each (moved out).
     */
    take_bodies_before(): Float64Array;
    /**
     * Every boundary loop the fill step looked at, `FILL_SCALARS` values each (moved out): whether
     * it was closed and, when it was not, why. Empty when not `ok`.
     */
    take_fills(): Float64Array;
    /**
     * The repaired indices, u32 triangle triples (moved out).
     */
    take_indices(): Uint32Array;
    /**
     * Boundary loops left after repair, `LOOP_SCALARS` each (moved out).
     */
    take_loops_after(): Float64Array;
    /**
     * Boundary loops before repair, `LOOP_SCALARS` each (moved out).
     */
    take_loops_before(): Float64Array;
    /**
     * The repaired positions, f32 xyz triples (moved out).
     */
    take_positions(): Float32Array;
    /**
     * What each step did: `STEP_SCALARS` values (moved out). All zero when not `ok`.
     */
    take_steps(): Float64Array;
}

/**
 * Tips per part, plus what the operator has to be shown to understand them.
 */
export class PartTipsResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Part id of each file face.
     */
    take_face_parts(): Uint32Array;
    /**
     * 1 where a file face is buried inside another part. This is what the viewport tints, and what
     * lets the app tell an operator WHY a face got no tip.
     */
    take_hidden(): Uint8Array;
    /**
     * `part<N>-<position id>`, one per tip, in part order.
     */
    take_ids(): string[];
    /**
     * Tip normals, xyz f64 — what the neck is aimed by.
     */
    take_normals(): Float64Array;
    /**
     * `PART_STRIDE` numbers per part: id, role, triangles, volume mm3, area mm2, tips. The same row
     * shape the dental parts list uses, so a host that decodes one decodes both.
     */
    take_part_list(): Float64Array;
    /**
     * Tip points, xyz f64.
     */
    take_positions(): Float64Array;
    /**
     * The file face each tip stands on.
     */
    take_tip_faces(): Uint32Array;
    /**
     * Which part each tip belongs to. Without this a host cannot attribute a tip.
     */
    take_tip_parts(): Uint32Array;
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
 * The layout: a new plan offset per case and which cases moved, fit nowhere, or overlap while frozen.
 */
export class PlateArrangement {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Indices of the frozen cases that overlap an earlier frozen case or leave the plate.
     */
    conflicts(): Uint32Array;
    /**
     * Indices of the cases that moved.
     */
    moved(): Uint32Array;
    /**
     * x z per case (plan, mm), input order.
     */
    offsets(): Float64Array;
    /**
     * Indices of the unfrozen cases that fit nowhere (left where they were).
     */
    unplaced(): Uint32Array;
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
    /**
     * A dental policy's part id of every face of the file (the layer "Parts"); empty for any other policy.
     */
    face_parts(): Uint32Array;
    /**
     * A denture policy's islands, 9 numbers each (x y z, height above the pose's lowest vertex mm, footprint mm2, distance to the nearest planned tip mm or -1, state 0 tipped / 1 served by a tip nearby / 2 below min size / 3 in no-support zone / 4 outside allowed area / 5 no usable face, index of the serving candidate or -1, face or -1). Empty for any other policy or with the rule `islandTips` off.
     */
    island_facts(): Float64Array;
    /**
     * Why a denture policy could not tell its islands (the surface is not a clean manifold...); empty when it could.
     */
    islands_note(): string;
    islands_outside_permitted(): boolean;
    /**
     * 1 when secondary landings are limited to the permitted faces.
     */
    landing_rule(): number;
    /**
     * A dental policy's parts (dentures engine 50, aligners engine 56), 6 numbers each: part id, role (0 target: the dental tips;
     * 1 add-on: generic tips on its own faces; 2 debris: no tips; 3 fused: joined to the target, printed with it, generic tips
     * on its exposed faces only), triangles, volume mm3, area mm2, candidates placed on it. Empty for any other policy.
     */
    part_list(): Float64Array;
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
    /**
     * Local lows of the dental rim whose face points up: no tip (rule `rimLowNeedsOverhang`), counted apart from the left-out tips; 0 for any other policy.
     */
    rim_lows_facing_up(): number;
    ring_count(): number;
    /**
     * The dental model-landing allow list (tip ids): those tips may be supported from the model's own surface even when the rule
     * `dentalModelLanding` is 0 (denture builds only; replaces the earlier list). The UI bubble "support from model surface" fills it.
     * An id of a lowest point the policy placed no tip on (`denture-low-unreached-<k>`, the unresolved report's `lowest` entries with
     * no tip) also makes that point a candidate (engine 51, `dental::denture::model_landing::admit`). An island id (`island-<vertex>`, the
     * report's bare islands) makes `generate` put a tip at that island's lowest vertex when it faces within `islandOverhangAngleDeg` of
     * straight down (engine 54, `supports::generate::island_admit`).
     */
    set_model_landing_allow(ids: string[]): void;
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
 * The answer of a live edit (`GeometrySession::reroute_support`, `pillar_reach`): a flat number array and, for a refused reroute, the reason.
 */
export class Reroute {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * x y z of the landing on the model (plate frame, mm); empty when the support reaches the plate.
     */
    landing_point(): Float64Array;
    /**
     * 0 the support reaches the plate; 1, 2, 3 it lands on the model (allowed area, other surface, no-support zone).
     */
    landing_tier(): number;
    /**
     * Why the reroute was refused; empty when it was taken.
     */
    refusal(): string;
    /**
     * The flat array (see the call that made it); taken once.
     */
    take_pieces(): Float64Array;
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
 * Packs the cases on a `width_mm` x `depth_mm` plate centred on the origin. `loops` per case: the loop count, then per loop its point
 * count and x z per point (relative to the case's offset); `offsets` x z per case; `frozen` one 0/1 per case. `full` re-packs every
 * unfrozen case; otherwise only those that do not fit where they are move. `rules` in `rule_names()` order (`plateGapMm`).
 */
export function arrange_plate(width_mm: number, depth_mm: number, rules: Float64Array, loops: Float64Array, offsets: Float64Array, frozen: Uint8Array, full: boolean): PlateArrangement;

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

export function denture_profile_ids(): string[];

/**
 * What a mesh is, body by body: the diagnosis that replaces the dental `mesh_ok` bit. Changes
 * nothing and allocates no mesh.
 */
export function diagnose_mesh(positions: Float32Array, indices: Uint32Array): MeshDiagnosis;

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
 * Tips on every part's exposed faces.
 *
 * `target` is the host's declared target part, or `-1` to let the engine pick the largest. It is
 * here rather than added later on purpose: the engine ranks by volume, the operator's active object
 * is not necessarily that part, and in an editor a merge makes the active object the lead. Only the
 * host can settle the three.
 *
 * A `debris` part gets no tips, which is a DENTAL judgement about scan noise; a generic caller that
 * wants every part supported passes a `debris_mm` of 0.
 */
export function part_tips(positions: Float32Array, indices: Uint32Array, settings: Float64Array, rules: Float64Array, debris_mm: number, target: number): PartTipsResult;

/**
 * The build phase names `generate`'s `on_phase` callback reports, in the order a first (unrepaired)
 * build runs them (`mixo_geometry_core::supports::phase::Phase::ALL`). Engine 64, for GEO-015: the
 * host held a second hand-written copy of this list (`GENERATE_PHASES` in host/core/progress.ts)
 * and the gate between them DROPPED a name it did not know, so a phase added here without a host
 * update left the operator's bar sitting still on a build that was working fine.
 */
export function phase_names(): string[];

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
 * Removes collapsed triangles; the host reports the count.
 */
export function remove_degenerate_triangles(positions: Float32Array, indices: Uint32Array): WeldResult;

/**
 * Repair on import: weld coincident vertices, drop collapsed triangles, split non-manifold edges
 * and bowtie vertices, make the winding consistent per body and outward for the closed ones, fill
 * the boundary loops `max_fill_loop_mm` allows, and mark the noise shells. Separate bodies always
 * stay separate, every patch is built from one loop's own vertices, and a loop that is not filled
 * is reported with the reason (`take_fills`). `max_fill_loop_mm` is the longest rim the caller
 * permits to be closed, in mm; 0 (or any non-positive or non-finite value) fills nothing. The
 * engine has no default for it on purpose - the number comes from measured rim lengths.
 */
export function repair_mesh(positions: Float32Array, indices: Uint32Array, max_fill_loop_mm: number): MeshRepairResult;

/**
 * The five stride constants above, in this order: mesh roll-up, per body, per boundary loop, step
 * array, per fill. Engine 64, for GEO-004: the host declared the same five numbers independently
 * (`host/core/repairMesh.ts`), and no gate compared them - the Rust side was proved against the
 * Rust constants and the host side against a fake that emitted whatever the host expected. Exported
 * so the host's copies are CHECKED rather than restated; `host/core/repairMesh.contract.test.ts`
 * is the consumer. Add a value to any layout here and that test goes red.
 */
export function repair_strides(): Uint32Array;

/**
 * The names of the planner rules `generate`'s `rules` array overrides, in array order
 * (`mixo_geometry_core::supports::rules::NAMES`): the host packs its overrides by these names.
 */
export function rule_names(): string[];

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
    readonly __wbg_dentalrimresult_free: (a: number, b: number) => void;
    readonly __wbg_dentaltiltscanresult_free: (a: number, b: number) => void;
    readonly __wbg_denturearearesult_free: (a: number, b: number) => void;
    readonly __wbg_denturelivetilt_free: (a: number, b: number) => void;
    readonly __wbg_dentureorientresult_free: (a: number, b: number) => void;
    readonly __wbg_denturereviewresult_free: (a: number, b: number) => void;
    readonly __wbg_denturetiltpaths_free: (a: number, b: number) => void;
    readonly __wbg_diagnosis_free: (a: number, b: number) => void;
    readonly __wbg_faceoverlay_free: (a: number, b: number) => void;
    readonly __wbg_generation_free: (a: number, b: number) => void;
    readonly __wbg_genericplacement_free: (a: number, b: number) => void;
    readonly __wbg_genericpolicyresult_free: (a: number, b: number) => void;
    readonly __wbg_geometrysession_free: (a: number, b: number) => void;
    readonly __wbg_handwork_free: (a: number, b: number) => void;
    readonly __wbg_legacyfill_free: (a: number, b: number) => void;
    readonly __wbg_meshdiagnosis_free: (a: number, b: number) => void;
    readonly __wbg_meshrepairresult_free: (a: number, b: number) => void;
    readonly __wbg_parttipsresult_free: (a: number, b: number) => void;
    readonly __wbg_pickindex_free: (a: number, b: number) => void;
    readonly __wbg_platearrangement_free: (a: number, b: number) => void;
    readonly __wbg_policyhandle_free: (a: number, b: number) => void;
    readonly __wbg_reroute_free: (a: number, b: number) => void;
    readonly __wbg_supportproblems_free: (a: number, b: number) => void;
    readonly __wbg_weldresult_free: (a: number, b: number) => void;
    readonly arrange_plate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
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
    readonly dentalorientresult_arch_kind: (a: number) => number;
    readonly dentalorientresult_cross_check: (a: number) => number;
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
    readonly dentalrimresult_flipped: (a: number) => number;
    readonly dentalrimresult_floor_offset: (a: number) => number;
    readonly dentalrimresult_ok: (a: number) => number;
    readonly dentalrimresult_reason: (a: number) => [number, number];
    readonly dentalrimresult_rim_scalars: (a: number) => [number, number];
    readonly dentalrimresult_take_rim_points: (a: number) => [number, number];
    readonly dentalrimresult_take_visibility_mask: (a: number) => [number, number];
    readonly dentaltiltscanresult_band: (a: number) => [number, number];
    readonly dentaltiltscanresult_boxed_counts: (a: number) => [number, number];
    readonly dentaltiltscanresult_boxed_points: (a: number) => [number, number];
    readonly dentaltiltscanresult_boxed_reasons: (a: number) => [number, number];
    readonly dentaltiltscanresult_counted_lows: (a: number) => [number, number];
    readonly dentaltiltscanresult_failing: (a: number) => [number, number];
    readonly dentaltiltscanresult_ok: (a: number) => number;
    readonly dentaltiltscanresult_order: (a: number) => [number, number];
    readonly dentaltiltscanresult_path_counts: (a: number) => [number, number];
    readonly dentaltiltscanresult_pick_reason: (a: number) => number;
    readonly dentaltiltscanresult_reason: (a: number) => [number, number];
    readonly dentaltiltscanresult_rows: (a: number) => [number, number];
    readonly dentaltiltscanresult_start_deg: (a: number) => number;
    readonly dentaltiltscanresult_tip_counts: (a: number) => [number, number];
    readonly denture_profile_ids: () => [number, number];
    readonly denturearearesult_areas: (a: number) => [number, number];
    readonly denturearearesult_mask: (a: number) => [number, number];
    readonly denturelivetilt_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly denturelivetilt_ok: (a: number) => number;
    readonly denturelivetilt_paths: (a: number, b: number) => [number, number, number];
    readonly denturelivetilt_reason: (a: number) => [number, number];
    readonly dentureorientresult_diagnostics: (a: number) => [number, number];
    readonly dentureorientresult_frame: (a: number) => [number, number];
    readonly dentureorientresult_reason: (a: number) => [number, number];
    readonly dentureorientresult_rotation: (a: number) => [number, number];
    readonly dentureorientresult_status: (a: number) => number;
    readonly dentureorientresult_teeth_decided: (a: number) => number;
    readonly denturereviewresult_allowed_mask: (a: number) => [number, number];
    readonly denturereviewresult_area_regions: (a: number) => [number, number];
    readonly denturereviewresult_box_: (a: number) => [number, number];
    readonly denturereviewresult_chain_lengths: (a: number) => [number, number];
    readonly denturereviewresult_chain_points: (a: number) => [number, number];
    readonly denturereviewresult_chain_sizes: (a: number) => [number, number];
    readonly denturereviewresult_down_edges: (a: number) => [number, number];
    readonly denturereviewresult_down_mask: (a: number) => [number, number];
    readonly denturereviewresult_drain_mask: (a: number) => [number, number];
    readonly denturereviewresult_drain_pockets: (a: number) => [number, number];
    readonly denturereviewresult_drain_sockets: (a: number) => [number, number];
    readonly denturereviewresult_face_parts: (a: number) => [number, number];
    readonly denturereviewresult_fitting_check: (a: number) => [number, number];
    readonly denturereviewresult_fitting_mask: (a: number) => [number, number];
    readonly denturereviewresult_hard_edges: (a: number) => [number, number];
    readonly denturereviewresult_hole_band_mask: (a: number) => [number, number];
    readonly denturereviewresult_hole_info: (a: number) => [number, number];
    readonly denturereviewresult_hole_outlines: (a: number) => [number, number];
    readonly denturereviewresult_hole_sizes: (a: number) => [number, number];
    readonly denturereviewresult_islands: (a: number) => [number, number];
    readonly denturereviewresult_islands_note: (a: number) => [number, number];
    readonly denturereviewresult_low_tip_points: (a: number) => [number, number];
    readonly denturereviewresult_low_tip_reasons: (a: number) => [number, number];
    readonly denturereviewresult_lows_in_sockets: (a: number) => [number, number];
    readonly denturereviewresult_lows_not_down_facing: (a: number) => [number, number];
    readonly denturereviewresult_lows_outside: (a: number) => [number, number];
    readonly denturereviewresult_lows_outside_faces: (a: number) => [number, number];
    readonly denturereviewresult_lows_unreached: (a: number) => [number, number];
    readonly denturereviewresult_lows_unreached_faces: (a: number) => [number, number];
    readonly denturereviewresult_no_support_dir: (a: number) => [number, number];
    readonly denturereviewresult_no_support_mask: (a: number) => [number, number];
    readonly denturereviewresult_no_support_steep_deg: (a: number) => number;
    readonly denturereviewresult_no_support_steep_mask: (a: number) => [number, number];
    readonly denturereviewresult_oral_cavity_ray: (a: number) => [number, number];
    readonly denturereviewresult_part_list: (a: number) => [number, number];
    readonly denturereviewresult_pillar: (a: number) => [number, number];
    readonly denturereviewresult_released: (a: number) => number;
    readonly denturereviewresult_rim_band_mask: (a: number) => [number, number];
    readonly denturereviewresult_rim_closed: (a: number) => [number, number];
    readonly denturereviewresult_rim_edges: (a: number) => [number, number];
    readonly denturereviewresult_rim_info: (a: number) => [number, number];
    readonly denturereviewresult_rim_loops: (a: number) => [number, number];
    readonly denturereviewresult_rim_lows_facing_up: (a: number) => number;
    readonly denturereviewresult_rim_plane: (a: number) => [number, number];
    readonly denturereviewresult_rim_sizes: (a: number) => [number, number];
    readonly denturereviewresult_self_support_faces: (a: number) => [number, number];
    readonly denturereviewresult_self_support_info: (a: number) => [number, number];
    readonly denturereviewresult_socket_mask: (a: number) => [number, number];
    readonly denturereviewresult_sockets_cancelled_by_r2: (a: number) => number;
    readonly denturereviewresult_suction_cups: (a: number) => [number, number];
    readonly denturereviewresult_suction_mask: (a: number) => [number, number];
    readonly denturereviewresult_symmetry_plane: (a: number) => [number, number];
    readonly denturereviewresult_tip_faces: (a: number) => [number, number];
    readonly denturereviewresult_tips: (a: number) => [number, number];
    readonly denturereviewresult_tips_dropped_facing_up: (a: number) => [number, number];
    readonly denturereviewresult_tips_dropped_socket: (a: number) => [number, number];
    readonly denturereviewresult_tips_skipped_fold: (a: number) => [number, number];
    readonly denturereviewresult_unsupportable: (a: number) => [number, number];
    readonly denturereviewresult_up: (a: number) => [number, number];
    readonly denturereviewresult_up_decision: (a: number) => [number, number];
    readonly denturetiltpaths_counts: (a: number) => [number, number];
    readonly denturetiltpaths_ok: (a: number) => number;
    readonly denturetiltpaths_overhang_mm2: (a: number) => number;
    readonly denturetiltpaths_reason: (a: number) => [number, number];
    readonly denturetiltpaths_rotation: (a: number) => [number, number];
    readonly denturetiltpaths_states: (a: number) => [number, number];
    readonly denturetiltpaths_tips: (a: number) => [number, number];
    readonly diagnose_mesh: (a: number, b: number, c: number, d: number) => [number, number, number];
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
    readonly generation_contact_fits: (a: number) => [number, number];
    readonly generation_island_reason: (a: number) => [number, number];
    readonly generation_reason: (a: number) => [number, number];
    readonly generation_revision: (a: number) => number;
    readonly generation_status: (a: number) => number;
    readonly generation_stop_reason: (a: number) => [number, number];
    readonly generation_take_contact_ids: (a: number) => [number, number];
    readonly generation_take_dropped: (a: number) => [number, number];
    readonly generation_take_dropped_by_zones: (a: number) => [number, number];
    readonly generation_take_fallback: (a: number) => [number, number];
    readonly generation_take_footprint: (a: number) => [number, number];
    readonly generation_take_indices: (a: number) => [number, number];
    readonly generation_take_intents: (a: number) => [number, number];
    readonly generation_take_island_heights: (a: number) => [number, number];
    readonly generation_take_island_status: (a: number) => [number, number];
    readonly generation_take_island_vertices: (a: number) => [number, number];
    readonly generation_take_issues: (a: number) => [number, number];
    readonly generation_take_last_resort_clearances: (a: number) => [number, number];
    readonly generation_take_last_resort_ids: (a: number) => [number, number];
    readonly generation_take_last_resort_tiers: (a: number) => [number, number];
    readonly generation_take_left_out_ids: (a: number) => [number, number];
    readonly generation_take_left_out_points: (a: number) => [number, number];
    readonly generation_take_left_out_reasons: (a: number) => [number, number];
    readonly generation_take_model_landed_ids: (a: number) => [number, number];
    readonly generation_take_model_landed_points: (a: number) => [number, number];
    readonly generation_take_model_landed_tiers: (a: number) => [number, number];
    readonly generation_take_positions: (a: number) => [number, number];
    readonly generation_take_reach: (a: number) => [number, number];
    readonly generation_take_rings: (a: number) => [number, number];
    readonly generation_take_tags: (a: number) => [number, number];
    readonly generation_take_unresolved_best_gaps: (a: number) => [number, number];
    readonly generation_take_unresolved_ids: (a: number) => [number, number];
    readonly generation_take_unresolved_kinds: (a: number) => [number, number];
    readonly generation_take_unresolved_needed: (a: number) => [number, number];
    readonly generation_take_unresolved_normals: (a: number) => [number, number];
    readonly generation_take_unresolved_points: (a: number) => [number, number];
    readonly generation_take_unresolved_reasons: (a: number) => [number, number];
    readonly generation_take_unresolved_streams: (a: number) => [number, number];
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
    readonly geometrysession_dental_rim_from_points: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly geometrysession_dental_tilt_scan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly geometrysession_denture_compare_areas: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly geometrysession_denture_policy: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly geometrysession_denture_policy_ruled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly geometrysession_denture_review: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly geometrysession_denture_review_ruled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly geometrysession_denture_tilt_paths: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly geometrysession_denture_tilt_scan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly geometrysession_denture_tilt_scan_ruled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly geometrysession_diagnose: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number, number];
    readonly geometrysession_diagnose_orientation: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly geometrysession_empty_policy: (a: number) => number;
    readonly geometrysession_generate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number, number];
    readonly geometrysession_generic_place: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly geometrysession_generic_policy: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number, number];
    readonly geometrysession_load_mesh: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly geometrysession_load_mesh_indexed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly geometrysession_load_placed: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_mesh_bounds: (a: number, b: number) => [number, number, number, number];
    readonly geometrysession_new: (a: number) => number;
    readonly geometrysession_orient_dental: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_orient_denture: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly geometrysession_pick: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly geometrysession_pick_index: (a: number, b: number) => [number, number, number];
    readonly geometrysession_pick_pixels: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly geometrysession_pillar_reach: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly geometrysession_project_brush: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [number, number, number, number];
    readonly geometrysession_propose_dental_region: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly geometrysession_release_mesh: (a: number, b: number) => [number, number];
    readonly geometrysession_reroute_support: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
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
    readonly meshdiagnosis_take_bodies: (a: number) => [number, number];
    readonly meshdiagnosis_take_loops: (a: number) => [number, number];
    readonly meshdiagnosis_take_mesh: (a: number) => [number, number];
    readonly meshrepairresult_changed: (a: number) => number;
    readonly meshrepairresult_ok: (a: number) => number;
    readonly meshrepairresult_reason: (a: number) => [number, number];
    readonly meshrepairresult_take_after: (a: number) => [number, number];
    readonly meshrepairresult_take_before: (a: number) => [number, number];
    readonly meshrepairresult_take_bodies_after: (a: number) => [number, number];
    readonly meshrepairresult_take_bodies_before: (a: number) => [number, number];
    readonly meshrepairresult_take_fills: (a: number) => [number, number];
    readonly meshrepairresult_take_indices: (a: number) => [number, number];
    readonly meshrepairresult_take_loops_after: (a: number) => [number, number];
    readonly meshrepairresult_take_loops_before: (a: number) => [number, number];
    readonly meshrepairresult_take_positions: (a: number) => [number, number];
    readonly meshrepairresult_take_steps: (a: number) => [number, number];
    readonly part_tips: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly parttipsresult_take_face_parts: (a: number) => [number, number];
    readonly parttipsresult_take_hidden: (a: number) => [number, number];
    readonly parttipsresult_take_ids: (a: number) => [number, number];
    readonly parttipsresult_take_normals: (a: number) => [number, number];
    readonly parttipsresult_take_part_list: (a: number) => [number, number];
    readonly parttipsresult_take_positions: (a: number) => [number, number];
    readonly parttipsresult_take_tip_faces: (a: number) => [number, number];
    readonly parttipsresult_take_tip_parts: (a: number) => [number, number];
    readonly phase_names: () => [number, number];
    readonly pickindex_take_bounds: (a: number) => [number, number];
    readonly pickindex_take_links: (a: number) => [number, number];
    readonly pickindex_take_order: (a: number) => [number, number];
    readonly placement_matrix: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly platearrangement_conflicts: (a: number) => [number, number];
    readonly platearrangement_moved: (a: number) => [number, number];
    readonly platearrangement_offsets: (a: number) => [number, number];
    readonly platearrangement_unplaced: (a: number) => [number, number];
    readonly policyhandle_alternate_faces: (a: number) => [number, number];
    readonly policyhandle_alternate_owners: (a: number) => [number, number];
    readonly policyhandle_alternate_points: (a: number) => [number, number];
    readonly policyhandle_automatic: (a: number) => number;
    readonly policyhandle_candidate_faces: (a: number) => [number, number];
    readonly policyhandle_candidate_ids: (a: number) => [number, number];
    readonly policyhandle_candidate_points: (a: number) => [number, number];
    readonly policyhandle_face_parts: (a: number) => [number, number];
    readonly policyhandle_island_facts: (a: number) => [number, number];
    readonly policyhandle_islands_note: (a: number) => [number, number];
    readonly policyhandle_islands_outside_permitted: (a: number) => number;
    readonly policyhandle_landing_rule: (a: number) => number;
    readonly policyhandle_part_list: (a: number) => [number, number];
    readonly policyhandle_permitted_faces: (a: number) => [number, number];
    readonly policyhandle_profile_id: (a: number) => [number, number];
    readonly policyhandle_repair_budget: (a: number) => number;
    readonly policyhandle_reproduced: (a: number) => number;
    readonly policyhandle_rim_lows_facing_up: (a: number) => number;
    readonly policyhandle_ring_count: (a: number) => number;
    readonly policyhandle_set_model_landing_allow: (a: number, b: number, c: number) => void;
    readonly policyhandle_structures: (a: number) => [number, number];
    readonly policyhandle_suggested_points: (a: number) => [number, number];
    readonly position_ids: (a: number, b: number) => [number, number, number, number];
    readonly refine_for_overlay: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly rekey_contact_ids: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly rekey_hand_work: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly remap_deleted_ids: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly remove_degenerate_triangles: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly repair_mesh: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly repair_strides: () => [number, number];
    readonly reroute_landing_point: (a: number) => [number, number];
    readonly reroute_landing_tier: (a: number) => number;
    readonly reroute_refusal: (a: number) => [number, number];
    readonly reroute_take_pieces: (a: number) => [number, number];
    readonly rule_names: () => [number, number];
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
