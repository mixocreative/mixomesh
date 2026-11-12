// Ported from mixodental src/workers/geometryVersion.ts. The version is bumped with every ABI change
// (9 at the port, 10 since P5.14, 11 with the repair budget, 12: STL import drops weld-collapsed
// triangles, 13: Step 1 orientation by the trim - the orient result carries the arch kind and the
// up/down cross-check, the rim scalars its front (22 values), and `diagnose_orientation` exists; now
// 14: the denture profile - `orient_denture`, `denture_tilt_scan`, `denture_policy`, `denture_profile_ids`).
// 19: denture review rim loop, hole loops + band, up decision; tip source tags low/area/rim/hole.
// 35: denture tilt pick can count only allowed-area lowest points (rule tiltAllowedLowsOnly, appended: 76 rule names in total, tiltPickOrder 1 = fewest tips first; the scan result has `counted_lows()` and `tip_counts()`).
// 34: route judging: the capsule judge asks first and the mesh judge only for what it takes (rules capsuleFilter 1 default for dentures / judgeAgreement 0 / capsuleFilterMarginMm unset = derived, appended: 71 rule names), landing-circle rules appended in the same engine (see generateRules.ts).
// 33: dentures: the dental-only model landing for tips left out (rule dentalModelLanding 0 off / 1 lowest points + islands / 2 any left-out tip, appended: 68 rule names; allow list `PolicyHandle.set_model_landing_allow`; `reroute_support` takes `allow_model_landing`, `policy`, `zones` and a NaN pillar spot, its result `landing_tier()` / `landing_point()`; `GeometrySession.empty_policy()`; the generate result lists take_model_landed_ids/tiers/points and the unresolved report take_unresolved_ids/streams/points/reasons/best_gaps/needed).
// 32: denture speed round: `denture_tilt_paths` (the live tilt view: tips of one tilt with a path state each, by the landing circle), the scan result's `path_counts()`, rules landingTiltWeight / landingRodMaxDeg / landingCellStepMm / landingRodSampleMm (67 rule names); the per-model analysis is cached by the engine; the dental crease midlines are computed once per edge (same results).
// 31: dentures: the last-resort tier for tips left out (rules lastResort, lastResortOutlineAngleDeg, lastResortClearanceMm, lastResortClearanceStepMm; the generate result lists them: take_last_resort_ids/tiers/clearances) and the dental rim low rule rimLowNeedsOverhang (denture policy/review report rim_lows_facing_up): 63 rule names.
// 30: the space map (supports/skeleton/space.rs) replaces the route drop map and the outline footprint raster: rule outlineGridMm is now spaceCellMm (same slot, the map's cell edge), new spaceMarginMm (58 rule names); support placement is meant to stay equal.
// 29: support rules - the trunk legs are replaced by the trunk support (helper pillar + short neck + braces): rule names legOverHeightMm..legDeeperAttach are now trunkSupportOverMm, trunkSupportOverTips, trunkNeckAngleDeg, trunkNeckMm, trunkSupportBelowJointMm, trunkDirections, trunkSpacingDiameters, trunkDeeperSupport (same slots); new trunkSecondHelperOverMm, trunkSupportMaxFrac, trunkBraceStepMm, trunkSupportMinMm, branchRodMaxMm, outlineRodCapMm, helperRodMaxMm (57 rule names); denture builds cap branch/merge rods at 8 mm and the outline rod at 15 mm and run the helper stage.
// 28: denture island tips: `denture_policy_ruled` / `denture_review_ruled` take `rules` (rule names islandTips, islandMinAreaMm2, lowOutsideAllowed, islandReuseMm, islandSlabMm: 50 rule names); tip source `island` (stream 6); `PolicyHandle.island_facts()` / `islands_note()` and the review's `islands()` / `islands_note()`; low-tip reason 3 (lowOutsideAllowed 2).
// 27: denture tilt scan prefers tilts whose lowest points a support can reach: `denture_tilt_scan_ruled` (takes `rules`), result `boxed_counts()` / `boxed_points()` / `boxed_reasons()`; rule `boxedInTiltWeight` (45 rule names).
// 26: `generate` takes `rules` (planner rule overrides, Float64Array in `rule_names()` order) after `limits`; `rule_names()`, `reroute_support`, `pillar_reach` exist.
// 25: `generate` takes `limits` (time-rule overrides, Float64Array) in place of `timeout_ms`; the result has `stop_reason()`.
// 24: dental rim band (profile placement.rimBandMm, review rim_band_mask): overhang faces within 2 mm of the dental rim are support-allowed.
// 23: denture review up decision by dental/arch_slices (front/back from the arch footprint, crown side from 11 section slices); up_decision array 29 values (slice votes, confidence, top, back, cross-check); T1b numbers kept as a diagnostic.
// 22: settings layout 68 (neckMaxShift, minClearance: angled neck offset + min gap), denture profile supports minClearanceMm/neckMaxShiftMm.
// 21: denture review: up decision by the T1b ray median test (run first, up_decision layout changed), rim_plane / symmetry_plane / oral_cavity_ray + no_support_dir replace middle_plane / ray_origin; middle_edges, middle_chain_of_edge, box_face, face_scores removed.
// 20: denture review rim = low points joined over the mesh (rim_loops/rim_sizes/rim_closed/rim_edges/rim_info), holes by an axis ray grid (hole_outlines/hole_sizes/hole_info/hole_band_mask); rim_loop, rim_bridged, hole_loops, hole_edges removed.

/** Must equal the Rust `engine_version()`; both change together on any ABI change. */
// 68: `part_tips` and `contacts_buried` WELD the caller's mesh before splitting it into parts, as
// `surface::parts::split` has always required. Without it a RENDER mesh - a glTF or textured import,
// whose vertices are split along every UV seam - arrives as one part per face, every face touching
// its neighbours, so every contact on it reads as buried. mixoMesh's baseline measured the cost at
// engine 67: an ordinary cube lost the sixteen contacts under its 4 x 4 bottom. The weld is the
// import weld itself (duplicates only), keeps face order and count, and costs no copy on a mesh
// that is already welded.
// 67: the overlap rule now applies to EVERY generic placement, not only the dental one:
// `runPlacementJob` drops the contacts `contacts_buried` marks (host/supports/buriedContacts.ts), so
// an object whose file holds several meshes gets no support where they overlap -- a body and an arm
// keep their own supports and the joint gets none. No ABI change: contact IDS are untouched, which
// is why this is a drop after placement and not a different placement. Same engine, cheaper:
// `Overlap::own_part` finds a contact's own part off the ray index instead of scanning every face
// (same answers, guarded by a full-scan comparison in `parts.rs`).
// 66: new ABI export `contacts_buried(positions, indices, points, radius, debrisMm)` -> one byte per
// point, 1 where the contact is buried inside or against another part of the same object. The
// smallest thing a generic policy needs to stop supporting a face it cannot reach: placement is
// untouched, so contact IDS do not change and no saved record needs migrating. Host side:
// host/supports/partTips.ts.
// 65: `LoopOutcome::Crack` = 9 (`fill-crack`): a rim of three or more edges enclosing no area is
// a crack, reported apart from `fill-degenerate`, which now means only "fewer than three edges".
// 65: new ABI export `part_tips(positions, indices, settings, rules, debrisMm, target)` ->
// PartTipsResult: tips on every non-debris part's EXPOSED faces, with per-tip part and face,
// the part rows, the per-face part map and the hidden mask. `target` is the host's declared
// target part (-1 = the engine's largest), which outranks the engine's pick in the reported
// roles. Host side: host/supports/partTips.ts.
// 64: the engine-63 audit's fixes, the ones that change what the host tells an app
// (docs/cia-audit-2026-11-12.md). Each line below was added by the commit that shipped it.
// New ABI export `repair_strides()`: the five repair layout strides, so host/core/repairMesh.ts's
// copies are checked rather than restated (GEO-004).
// A build with no contacts no longer answers for the engine: its verdict and island report are
// `inconclusive` with reason `not judged: no contacts` instead of `clear` / `ok`, its `mesh.revision`
// is set like every other return path, and the export gate has a fourth refusal reason
// `nothing-built` (its result row carries `triangles`) - GEO-002, GEO-003.
// Every engine code table in host/ and editing/ has an `unknown` member and every lookup falls back
// to it (or to the table's own existing honest unknown), so a code this version does not know is
// reported as unknown rather than as a neighbour's meaning - GEO-005. Unions widened: SupportPart,
// SupportIssue.origin, the per-island status, modelLanded.tier, FillReason, FillStrategy,
// DentalArchKind, TiltPickReason, IslandState, PartRole, TipPathState, PieceKind,
// SupportPointSource, and the review's tip stream (now the type `TipStream`).
// The repair decoders and `unpackFootprint` refuse a short or mis-strided array instead of padding
// it with zeros, dropping the trailing record or walking past the end into NaN - a RangeError, as
// fatal as the engine's own INVALID_LENGTH, which the host already throws through these functions
// (GEO-006).
// `editing/` takes the product name and the project file extension from the app instead of naming
// mixoDental in four shared i18n keys: `UiState.product` / `UiState.ext` (both required) and
// `openFailure(error, name, { product, ext })` - GEO-011.
// A job that ran on the CALLING thread because no Web Worker could be created says so:
// `JobRow.inline`, and that row offers no Cancel because nothing can interrupt it (GEO-012).
// `take_unresolved_kinds`, `take_unresolved_normals` and `take_footprint` are REQUIRED members, and
// an unresolved point the engine gave no direction for carries `normal: null` instead of a
// fabricated straight-down one - GEO-008.
// New ABI export `phase_names()`: the build phase names in the engine's own order, so
// host/core/progress.ts's `GENERATE_PHASES` is a copy that is CHECKED rather than a second
// hand-written list; and a phase name the host does not know is forwarded as `'unknown'` with its
// counts rather than dropped in silence, so the progress bar no longer freezes on a working build
// (GEO-015). The channel itself and the "a listener changes nothing" invariant now have a test at
// the seam (GEO-014).
// 63: hole filling, repair slice 2 (`crates/geometry-core/src/repair/fill.rs`): `repair_mesh(positions, indices, max_fill_loop_mm)` takes a THIRD argument - the longest boundary rim (mm) the caller permits to be closed. There is no default and 0 (or any non-positive or non-finite value) fills nothing: the number belongs to measured rim lengths on real files, which `diagnose_mesh`'s `take_loops()` (body id, length mm per loop) already reports. A patch uses only the vertices of its own rim and only one physical body, adds no vertex and is all-or-nothing per loop; a three-edge rim becomes one triangle, a near-planar rim (bend under 10% of its reach) is ear-clipped in its own plane, a rim up to 35% takes the minimum-area triangulation of the 3D polygon, and anything beyond that - or crossing itself, or over 256 edges, or not a closed loop - is LEFT OPEN and reported. New `MeshRepairResult::take_fills()`: 7 scalars per loop (body, length mm, edges, flatness, outcome, strategy, triangles added), outcome 0 filled / 1 fill-too-long / 2 fill-non-planar / 3 fill-self-intersecting / 4 fill-too-many-edges / 5 fill-not-a-loop / 6 fill-degenerate / 7 fill-spans-bodies / 8 fill-disabled, strategy 0 none / 1 triangle / 2 ear-clip / 3 min-area. `take_steps()` is now 24 scalars (the fill's limit, loops considered, filled, left open and patch triangles inserted before the noise-shell values). `after.watertight` still means every body closed, so one loop left open keeps it false. Host decoder: host/core/repairMesh.ts.
// 62: mesh repair on import, slice 1 (`crates/geometry-core/src/repair/`): `diagnose_mesh(positions, indices)` -> `MeshDiagnosis` (`take_mesh` 12 scalars, `take_bodies` 14 per physical body, `take_loops` 2 per boundary loop) replaces the single `mesh_ok` bit with a per-body report (triangles, vertices, signed volume, area, box diagonal, closed, boundary loops and each loop's length, non-manifold edges, bowtie vertices, consistent winding, noise shell); `repair_mesh(positions, indices)` -> `MeshRepairResult` (`ok`, `reason`, `changed`, `take_positions`, `take_indices`, `take_before`/`take_after`, `take_bodies_before`/`take_bodies_after`, `take_loops_before`/`take_loops_after`, `take_steps` 19 scalars) welds coincident vertices, drops collapsed triangles (the existing rule), splits non-manifold edges and bowtie vertices, makes the winding consistent per body and outward for the closed ones, and marks the bodies under 0.001 mm3 as noise. A PHYSICAL BODY (a piece separated by a 0.005 mm gap, `Tolerance::BodyGap`) is invariant: the wrapper checks between steps, and a step that would move a face between bodies abandons the repair - `ok() === false`, `reason()` `body-invariant:<weld|degenerate|manifold|winding>`, the file handed back unchanged (not a throw). Holes are measured, never filled (slice 2); noise shells are reported, never dropped. A clean mesh comes back bit-identical with `changed() === false`. Host decoder: host/core/repairMesh.ts.
// 61: `dental_rim_from_points(model, points, flip, profile)` -> `DentalRimResult` (`ok`, `reason`, `rim_scalars` as an orient result's 22, `take_rim_points`, `take_visibility_mask`, `floor_offset`, `flipped`): the rim for a loop the operator drew on the surface, for an aligner whose rim detection found none. Same rasteriser, same mask shape; the opening's side comes from the floor rule, not the loop's winding.
// 60: `generate` takes an optional last argument `on_phase(name, done, total)` (engine phase events for a staged progress bar: preparing, routing, placing, bracing, raft, checking, judging, finishing, writing); results unchanged. Host: `GENERATE_PHASES` in host/core/progress.ts.
// 59: the allowed area (R2 and the hole band) ALWAYS cancels the socket mask (owner 2026-11-02, plan P3, option A): a socket face inside it is no socket, so rim, hole-band and area tips stand there; before, only R2 cancelled it. No ABI change.
// 58: ONE overhang angle setting (owner 2026-11-02, plan P1b): the generic `scatterAngle` default is 45 (was 50), the same value as the global `overhangAngleDeg` rule; hosts show one Overhang angle control and send it as both. No ABI change.
// 57: ONE overhang angle rule (owner 2026-11-02, plan P1): `overhangAngleDeg` (45, slope of the surface from horizontal: 0 = flat ceiling, 90 = vertical wall; a tip needs a face flatter than it), overrides `dentalRimOverhangAngleDeg` (60) and `islandOverhangAngleDeg` (60, islands and lowest points); replace tipMaxFromDownDeg, islandMaxFromDownDeg (rule names appended: 128), the denture profile's tipMinFromUpDeg and DOWN_DEG; the aligner profile's tipMinFromUpDeg becomes overhangAngleDeg (70 = 180 - 110).
// 56: Round B for aligners, the parts of an aligner file (dental/aligner_parts.rs; plans PD.7 and P5.15): the file is split as a denture file is; every aligner step (orientation, trim and rim detection, region and strip, print-angle scan, two-contour policy tips, the orientation evidence and test-ABI orientation, pose and opening) runs on the largest part, its face ids, masks and contour vertex pairs in the file's (saved regions are read back onto the aligner); a painted area (from scratch or an older saved policy) is read over the whole file as before. For aligners and dentures alike, a part that overlaps or touches the target (a vertex of either within 0.05 mm of or inside the other, directly or through another such part) is fused (part role 3, printed with it): its faces whose centre lies inside another part or within 0.05 mm of one are hidden and get no tips, its exposed faces get the part's generic placement wherever they overhang (aligner: outer spacing and the generic overhang angle; denture: its spacing) and are permitted; a free part is an add-on with generic tips; debris gets none; no target tip within 0.05 mm of another part or inside it. Every part stays an obstacle in the build. One-part files are unchanged. The aligner policy handle has `part_list()` and `face_parts()`. No new rule.
// 55: a hand-placed tip serves an island (owner 2026-11-02): a planned island tip the build left out is no longer reported unresolved when a built manual tip stands within the island cover (`scatterSpacing`, the verdict's own serving distance) of the island's lowest point and no higher than the cover above it, and the clearance review did not withdraw it (`supports/generate/manual_serve.rs`). Bare islands already counted manual supports through the verdict. Builds with no manual tip are unchanged; no new rule.
// 54: Round D island bubbles (owner 2026-11-02): an island id (`island-<vertex>`, the unresolved report's bare islands) on the model-landing allow list (`PolicyHandle.set_model_landing_allow`) puts a tip at the island's lowest vertex in `generate` (`supports/generate/island_admit.rs`), on the face there that points most down, then the build tries the plate, the last-resort tier and the model-surface tiers (allowed area, other surface, no-support zone) and reports the tier in `take_model_landed_*`; the island verdict then counts the island resolved. An island whose lowest face leans past `islandMaxFromDownDeg` (60) gets no tip and its unresolved reason says it faces sideways. Results with no island id on the list are unchanged; no new rule.
// 53: Round C plate auto-arrange (owner 2026-11-01): the generate result has `take_footprint()` (the case footprint: the space-map raft outline, model shadow joined with the foot discs, grown by the raft expand); `arrange_plate(width, depth, rules, loops, offsets, frozen, full)` -> `PlateArrangement` (`offsets()`, `moved()`, `unplaced()`, `conflicts()`) packs cases by footprint, the new rule `plateGapMm` (default 6 mm) apart, inside the plate, deterministic; with frozen cases only the cases that no longer fit move. Appended: 127 rule names.
// 52: Round C live-tilt split (owner 2026-11-01): `DentureLiveTilt` (constructor: positions, indices, profile, scan settings, rules; `ok()`, `reason()`, `paths(tilt)` -> `DentureTiltPaths`) keeps the per-model work of the live angle view, so a tilt is only the tips and their path states; `denture_tilt_paths` gives the same answers (now `LiveTilt::new(..).at(..)`). Faster per tilt with identical results: the rim stretch gate memoises its tilt-independent averaged normals, one face pass gives the down mask and the overhang area, one raster pass gives both space-map layers and the looser map reuses them, a vertical drop is judged at its top sample. No new rule.
// 51: Round C engine prerequisites for the unresolved-point bubble (owner 2026-11-01): the generate result's unresolved report says what each entry is (`take_unresolved_kinds()`: island / lowest / tip) and its outward normal (`take_unresolved_normals()`, for `reroute_support`), gives islands a best gap too, and lists the lowest points the denture policy placed no tip on (ids `denture-low-unreached-<k>`); `PolicyHandle.set_model_landing_allow` with such an id makes the point a candidate (`dental::denture::model_landing::admit`). Results with an empty allow list are unchanged; no new rule.
// 50: Round B, the parts of a denture file (surface/parts.rs, dental/denture/parts.rs; owner 2026-11-01, plans PD.7 and P5.15): the file is split into its parts before any repair (faces joined by their edges, touching shells stay apart, nothing welded or merged); every dental step (upright, tilt scan, tilt view, rules analysis, tips, sockets, traps, review) runs on the largest part; an add-on part gets generic tips on its own faces with the denture spacing; debris (rule partDebrisMm, default 1 mm across) gets none; no tip within 0.05 mm of another part or inside it; every part stays an obstacle in the build. One-part files are unchanged. The policy handle and the review result have `part_list()` and `face_parts()`; island state 6 = touches another part. Appended: 126 rule names.
// 49: the grid raft redesigned (owner 2026-11-02; still opt-in, raftGrid off): 2 mm tall (raftGridTopMm default 1.5), every piece from the plate; a triangle grid of ridges (three families 60 degrees apart, triangle side raftRibPitchMm, turned away from the outline's dominant edges), each 1 mm at the ridge base narrowing to a flat top (rule raftRibTopMm 0.3); the edge band's outer wall leans out 40 degrees from the plate (rule raftGridWallAngle 50, degrees from vertical like raftWallAngle), the footprint kept. Appended: 125 rule names.
// 48: owner corrections 2026-11-01 (docs/round-a6-area-supports.md "Owner reversal"): areaDensity back to OFF by default (opt-in; the area spacing is global); the edge streams keep the global spacing (rule edgePitchMaxStep and supports/edge_pitch.rs removed: 123 rule names); the dental rim is cut into the stretches where a tip may stand, each tipped at its ends and corners with equal gaps (rim_tips::stretch_samples); corner tips, islands and minima first kept.
// 47: owner decisions 2026-11-01 (docs/round-a6-area-supports.md "Owner reversal"): areaDensity ON by default (dentures and the generic Poisson field, per connected overhang region; aligners unchanged); the edge streams (dental rim, dental rim band, hole band; generic border and ridge anchors) inherit the local region pitch, smoothed (supports/edge_pitch.rs, rule edgePitchMaxStep), overridable (dentalRimPitchMm, holePitchMm, genericEdgePitchMm); a tip on every edge corner and even spacing corner to corner (supports/edge_line.rs; rules edgeCornerDeg, edgeCornerSpanMm); island and lowest-point tips claim first and are never dropped by spacing or density (generic stream order now minima, anchors, Poisson with a half-pitch claim gap). Appended: 124 rule names; `generic_place` takes an optional rules array.
// 46: Round A8, speed only (same results): the route rod and tube tests (`Obstacles::near` / `hugs`) skip BVH nodes and faces whose box, grown by the test radius, the segment misses (slab test); the knot.stl generic job ~78 s -> ~21 s native.
// 45: Round A6, both opt-in (defaults unchanged): tips by overhang area (dental/denture/area_density.rs; rules areaDensity, areaRefMm2, areaDenseFloor, areaSteepLighten, areaMinPitchMm, areaMaxPitchMm) and the controlled contact loop (supports/parts/contact_ring.rs, contact_fit.rs; rules contactFit, contactFitTolMm, contactFitRays, contactFitMaxIters, contactFitMaxBiteFactor), appended: 120 rule names; the review result has `area_regions()`, the generate result `contact_fits()`.
// 44: resin-trap checks at the chosen print tilt, once per review (dental/denture/print_basins.rs, suction.rs, drain.rs; surface/view_grid.rs): rules trapCheck, trapMinDepthMm, trapVentMaxMm2, suctionAreaMm2, suctionVolumeMm3, drainAspectRatio, drainVolumeMm3, drainSocketDepthMm (appended: 109 rule names); the review result has `suction_cups()`, `suction_mask()`, `drain_pockets()`, `drain_sockets()`, `drain_mask()`. No tip or tilt changes.
// 43: owner defaults: tipMaxFromDownDeg 60 (was 45), islandMaxFromDownDeg 60 (was 50), socketNoSupport ON; the oral cavity ray R2 cancels the socket mask (the review result has `sockets_cancelled_by_r2()`).
// 42: basins seen along the teeth axis (surface::basins, dental/denture/sockets.rs), once per model before any tilt: tooth sockets (rules socketNoSupport opt-in, socketMinDepthMm 1, socketTunnelMaxMm2 25; appended: 101 rule names) keep rim, area and hole-band tips off when on; the review result has `socket_mask()`, `fitting_mask()` (the fitting surface as a tissue-side basin, a cross-check), `fitting_check()`, `tips_dropped_socket()`, `lows_in_sockets()`.
// 41: the owner's hard tip rules for every tip (supports::tip_orient, supports::tip_check; rules tipInsideCheck, tipInsideSkipMm, islandMaxFromDownDeg, tipSkinFromMm appended: 98 rule names): every path leaves the surface outward and its centre line and neck-cone flank stay outside the model (route stages, model landing, live edit); generate leaves out automatic tips that do not face down (island tips within 50 degrees) and hand-placed tips whose path would enter the model; generic and aligner face/edge tips take the averaged normal; the far side of a thin lip no longer votes in the average. `left_out` names the rule (tip-check:facing / fold / neck-inward / inside / cone).
// 40: opt-in rules overhangSelfSupportStreams and rimRespectsNoSupport (appended: 94 rule names): the self-support test also filters dental rim, dental rim band and hole-band tips; those tips stay off no-support-zone faces the oral cavity ray does not see. Off by default, so a build without them is unchanged.
// 39: correctness rules tipMaxFromDownDeg (45) and rimApproachOutside (on), appended: 92 rule names (tipNormalRadiusMm 0.5: a tip's direction is the area-weighted average of the face normals within that radius; a knife-sharp fold gets no tip). ON by default: after the tilt a rim, hole-band or area tip stands only on a face within 45 degrees of straight down, and a rim sample on a knife-edge lip whose neck would enter the far face is skipped; the review result has `tips_dropped_facing_up()`, `tips_skipped_fold()` and `lows_not_down_facing()`.
// 38: the self-supporting overhang rule (rules overhangSelfSupport, overhangMinAreaMm2, overhangMaxReachMm, overhangMinAngleDeg, appended: 89 rule names); off by default, so a build without it is unchanged; the review result has `self_support_faces()` and `self_support_info()`; the tilt scan honours it.
// 37: the plate outline and the grid raft (rules raftGrid, raftMapOutline, raftGridBottomMm, raftGridTopMm, raftRibMm, raftRibPitchMm, raftRimMm, raftPadMarginMm, appended: 85 rule names); both switches default off, so a build without them is unchanged.
// 36: opt-in R1b, the steep no-support ray (rule noSupportSteepDeg, appended: 77 rule names; the review result has `no_support_steep_mask()` and `no_support_steep_deg()`).
export const HOST_GEOMETRY_VERSION = 68;

/** Thrown when the loaded engine's `engine_version()` is not `HOST_GEOMETRY_VERSION` (code 'geometry-version-mismatch'). */
export class GeometryVersionMismatch extends Error {
  /** @param {number} actual */
  constructor(actual) {
    super(`Geometry core schema ${actual} does not match host schema ${HOST_GEOMETRY_VERSION}`);
    this.name = 'GeometryVersionMismatch';
    this.code = 'geometry-version-mismatch';
    this.actual = actual;
  }
}

/** @param {number} actual */
/** Throws `GeometryVersionMismatch` unless `actual` equals `HOST_GEOMETRY_VERSION`. */
export function assertGeometryVersion(actual) {
  if (actual !== HOST_GEOMETRY_VERSION) throw new GeometryVersionMismatch(actual);
}

/**
 * Awaits `ready()` (the realm's engine load), then runs `work`, so a worker never calls the
 * engine before it is loaded. meshWorker wraps every engine task (all but `forget`) in it.
 *
 * @template T
 * @param {() => Promise<unknown>} ready
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function runAfterGeometryReady(ready, work) {
  await ready();
  return work();
}
