/*
 * The tunable rules of the support planner, host side. The defaults and the rules live in Rust
 * (`supports::rules`, `SupportRules`); the host only passes overrides, by name, in `RULE_NAMES` order.
 * No heavy imports here: the main thread reads it too.
 */

/**
 * The planner's rules, each optional (absent: the engine's default, set in Rust `supports::rules`).
 * Counts are rounded by the engine and negative counts are ignored; non-finite values keep the default.
 * The two on/off rules (`capsuleJudge`, `neckPretest`) take a boolean here and are sent as 1 or 0.
 */
export interface GenerateRules {
  /** Most leaning segments before the vertical drop: 1 (one lean) or 2 (two leans). Capped at 2. */
  routeMaxBends?: number;
  /** Directions tried for one lean (11.25 degrees apart by default; a coarser step moves the pillar more than its diameter at 6 mm). */
  routeFineDirections?: number;
  /** Directions tried for the first of two leans and for a branch (22.5 degrees apart by default; the second lean refines). */
  routeCoarseDirections?: number;
  /** Sideways shift step of a pillar top, mm (default half a pillar diameter). */
  routeShiftStepMm?: number;
  /** Longest branch (mm), neck end to join: the longest leaning segment; the join braces it. */
  routeBranchMaxMm?: number;
  /** A branch joins at least this far (mm) under the trunk's pillar top, clear of its bend. Also the merge node distance. */
  routeJoinBelowTopMm?: number;
  /** A branch joins at least this far (mm) under the trunk's own contact, never beside its tip. */
  routeJoinBelowTipMm?: number;
  /** Most tips one pillar carries, its own included. One value for route, outline and merge. */
  tipsPerPillar?: number;
  /** Joints on one pillar are either one shared node or at least this far apart (mm, along the pillar). One value for route, outline, merge and trunk support. */
  jointGapMm?: number;
  /** Lower joins tried on a trunk (each jointGapMm lower) after the highest the lean limit allows. */
  routeDeeperJoins?: number;
  /** A trunk carrying more branches than this is built thicker (thickFactor). */
  thickOverBranches?: number;
  /** Pillar diameter factor of a trunk carrying more than thickOverBranches branches. */
  thickFactor?: number;
  /** Judge candidates on their skeleton (capsules, one BVH walk per piece) instead of building and checking the real column. The export's mesh verdict stays mandatory either way. */
  capsuleJudge?: boolean;
  /** Run the planner's own cone test before the judge's neck verdict. Off, every neck axis goes straight to the judge (slower, never stricter). Applies to route and outline. */
  neckPretest?: boolean;
  /** A tip lower than this (mm) never branches, never joins another tip's pillar and never merges; the pillar spacing rule does not apply to its pillar. */
  lowMinTipHeightMm?: number;
  /** No branch join or merge node lower than this (mm). */
  lowMinNodeHeightMm?: number;
  /** Longest outline rod (mm), start to joint (or to the foot). */
  outlineRodMaxMm?: number;
  /** An outline rod longer than this (mm) needs a brace. */
  outlineBracedOverMm?: number;
  /** Steepest lean from vertical (degrees) of an outline rod or brace. */
  outlineMaxAngleDeg?: number;
  /** Extra radius (mm) the rod and brace tests give the tube, so a rod that passes also passes the judge's test of the built column. */
  outlineRodMarginMm?: number;
  /** Centres of two pillars (outline pillars, feet, trunks) are at least this far apart (mm). */
  outlinePillarSpacingMm?: number;
  /** Deeper joints (each jointGapMm lower) tried per spot after the highest one allowed. */
  outlineDeeperJoints?: number;
  /** Lower brace ends (each jointGapMm lower) tried per brace pillar after the highest one allowed. */
  outlineDeeperBraces?: number;
  /** Added to every radius (mm) before the capsule clearance test, so the capsule verdict is never looser than the mesh verdict. */
  capsuleMarginMm?: number;
  /**
   * Route search: ask the quick capsule judge first and the real (mesh) judge only for what it takes; a candidate the capsule refuses is skipped.
   * The mesh judge keeps the last word, so results do not change (measured on the three denture cases: the capsule never refuses what the mesh
   * takes). Default 1 for dentures, always 0 for other builds.
   */
  capsuleFilter?: boolean;
  /** Measuring only: judge every candidate with both judges, follow the mesh, count where they differ (slow). Default 0. */
  judgeAgreement?: boolean;
  /** The capsule's margin (mm, negative: the capsule shrinks) while it only filters. Unset: derived from the tube's facets (about -0.03 for a 1.1 mm pillar). */
  capsuleFilterMarginMm?: number;
  /** Two pillars nearer than this in plan merge into a tree, in pillar diameters (the engine multiplies by the pillar diameter; default 3). */
  mergeSpacingDiameters?: number;
  /** Steepest lean from vertical (degrees) of the rod from the merged column's top to the node. */
  mergeMaxAngleDeg?: number;
  /** Longest merge rod (mm). */
  mergeRodMaxMm?: number;
  /** Most merge passes; each pass merges every pair it can, nearest first. */
  mergePasses?: number;
  /** Lower merge nodes tried (each jointGapMm lower) when the highest node the lean allows is taken by a joint. */
  mergeDeeperNodes?: number;
  /** Trunk support (engine 29, replacing the long trunk legs): a trunk gets a helper pillar beside it only when it stands higher than this above the foot top (mm) AND carries more tips than trunkSupportOverTips. */
  trunkSupportOverMm?: number;
  /** Trunk support: a trunk gets a helper only when it carries more tips than this (its own included, default 3) and stands higher than trunkSupportOverMm. */
  trunkSupportOverTips?: number;
  /** Steepest lean from vertical (degrees) of the helper's neck and braces (default 45). */
  trunkNeckAngleDeg?: number;
  /** Free length (mm) of the short thin neck between the helper and the trunk (default 2.5: the helper stands about 2.9 mm from the trunk). */
  trunkNeckMm?: number;
  /** The support point on the trunk lies at least this far (mm) under the trunk's lowest joint (default 2). */
  trunkSupportBelowJointMm?: number;
  /** Directions tried around the trunk for the helper (the side with the most room first). */
  trunkDirections?: number;
  /** The helper stands at least this far from every other pillar, in pillar diameters (default 3). */
  trunkSpacingDiameters?: number;
  /** Support points tried: at most this many steps (each jointGapMm) down from the highest allowed, the lowest that works wins (default 6). */
  trunkDeeperSupport?: number;
  /** Slope of the neck's clearance ramp (mm of gap per mm past the bite patch). */
  neckRampSlope?: number;
  /** The neck gap (mm) a neck keeps from faces it runs along (default 1.0). */
  neckGapMm?: number;
  /** Neck lift: when the straight neck is clear but its gap 1-2 mm from the tip is under neckGapTargetMm, up to this many short leans are judged and the clear one with the widest gap replaces it. 0 turns the lift off. */
  neckLiftTries?: number;
  /** The neck gap (mm, 1-2 mm from the tip) the lift aims for; a neck at or over it is left as it is. */
  neckGapTargetMm?: number;
  /** Most time (ms) one tip's search may take before it is given up as hopeless and the build goes on (default 10 000). 0: no window. */
  tipTimeMs?: number;
  /** 1 (default): tree merge and trunk legs run only for exact-contact (denture) builds; generic builds keep their Auto Trees and truss. 0: for every build. */
  treesForExactContactOnly?: number;
  /** Denture tilt scan: among tilts that pass the safety rules the pick prefers the fewest lowest points no support can reach. 0 turns the preference off; any positive value keeps it on (default 1). */
  boxedInTiltWeight?: number;
  /** Denture policy and review: 1 (default) puts one tip at the lowest vertex of every island of the posed model (source "island"), unless a tip already stands within `islandReuseMm`; 0 turns it off. Booleans are sent as 1 or 0. */
  islandTips?: number | boolean;
  /** Islands whose footprint (the area, seen from above, of their lowest `islandSlabMm` of surface) is smaller than this get no tip (mm2, default 0.05). */
  islandMinAreaMm2?: number;
  /** Where a low or island tip may stand outside the allowed area: 0 nowhere (only inside the allowed area or within the profile's lowRimBandMm of the rim), 1 anywhere except the no-support zone (default, the behaviour before engine 28), 2 everywhere. */
  lowOutsideAllowed?: number;
  /** A tip already planned within this distance (mm, default 0.5) of an island's lowest point serves it; also the radius of the report's resolved. */
  islandReuseMm?: number;
  /** Thickness (mm, default 0.2) of the lowest slab whose footprint is an island's size. */
  islandSlabMm?: number;
  /** A helper taller than this (mm, default 25) gets a second helper on the opposite side of the trunk. */
  trunkSecondHelperOverMm?: number;
  /** Trunk support: the support point on the trunk lies at most this fraction of the trunk's height above the foot top (default 2/3). */
  trunkSupportMaxFrac?: number;
  /** Trunk support: the helper's brace to the trunk comes every this many mm of height (default 8; 0 none). With the truss on the ordinary brace pass braces the helper to its neighbours and this is not used. */
  trunkBraceStepMm?: number;
  /** Trunk support: the support point lies at least this far (mm, default 10) above the foot top, so a helper is a pillar and not a stub. */
  trunkSupportMinMm?: number;
  /** Denture builds only: longest branch onto a trunk and longest merge rod (mm, default 8); the smaller of this and routeBranchMaxMm / mergeRodMaxMm applies. A tip whose only trunk is farther is left out, and the reason says the cap. Aligner builds are not capped. */
  branchRodMaxMm?: number;
  /** Denture builds only: longest last-resort outline rod (mm, default 15); the smaller of this and outlineRodMaxMm applies. */
  outlineRodCapMm?: number;
  /** Denture builds only: longest rod (mm, default 8) of the helper stage, a new pillar beside a tip that has no own route, tried before any branch; a rod over outlineBracedOverMm is braced. 0 turns the stage off. */
  helperRodMaxMm?: number;
  /** Edge (mm) of a cell of the space map (default 0.5): the plan grid every placement question reads; also the outline's pillar-spot pitch. */
  spaceCellMm?: number;
  /** Least free border (mm, default 6) the space map keeps around the model's plan bounds. */
  spaceMarginMm?: number;
  /** Denture last resort for a tip still left out (dentures only, default on): one more attempt with limits relaxed for that tip's route alone. */
  lastResort?: boolean;
  /** Last resort tier 1: the outline route's steepest lean from vertical, degrees (default 60; the normal limit is `outlineMaxAngleDeg`). */
  lastResortOutlineAngleDeg?: number;
  /** Last resort tier 2: the lowest pillar/rod clearance a tip may get, mm (default 1.0, the floor; the largest that fits is kept). */
  lastResortClearanceMm?: number;
  /** Dental rim lows (default on): a local low of the dental rim is forced past the overhang test only when its face is an overhang; one facing up gets no tip and is counted (`rimLowsFacingUp`). */
  rimLowNeedsOverhang?: boolean;
  /** Last resort tier 2: how far the clearance steps down from the build's at each try, mm (default 0.25: 1.25 then 1.0). */
  lastResortClearanceStepMm?: number;
  /** Denture tilt scan (default 0 = off, the old pick): above 0 the pick prefers the tilt whose tips have a way down by the landing circle (fewest lowest points without a path, then tips without, then tips with only a fallback), ahead of the boxed-in count and never over the safety tiers. */
  landingTiltWeight?: number;
  /** Denture tilt scan (default off): only lowest points whose face is in the allowed area count for the tilt pick, in both the boxed-in check and the landing score; lows and islands on other faces do not. */
  tiltAllowedLowsOnly?: boolean;
  /** Denture tilt scan pick order: 0 (default) the old pick; 1 = inside the safety tier the tilt needing the fewest tips overall, ties to the fewest tips in unwanted areas, then the old order; unreachable lows do not move the angle. */
  tiltPickOrder?: 0 | 1;
  /** Tips of difference that still count as a tie for tiltPickOrder 1 (default 5). */
  tiltTipCountSlack?: number;
  /** Denture no-support zone (default 0 = off): above 45 and below 90 adds R1b, a second parallel no-support ray turned this many degrees from the back toward straight down from the teeth side (67.5 is the owner's value). The zone is the first hits of R1 (45) and R1b together; the allowed area still overrides it. Applies to the tilt scan, the policy and the review. */
  noSupportSteepDeg?: number;
  /** Raft (default false): build the raft as a peel grid instead of the classic floor and rim: 2 mm tall (solid 0.5 mm bottom, 1.5 mm of ribs), a triangle grid of ridges in three directions 60 degrees apart, turned away from the outline's longest edges; a solid edge band whose outer wall leans out 40 degrees from the plate; a solid pad under every foot and under the label. Every piece stands on the plate. */
  raftGrid?: boolean;
  /** Plate outline (default false): trace the raft outline from the space map (shadow plus a disc under every foot, grown by the raft expand distance) instead of the voxel trace. A roof or cage always uses the voxel trace. */
  raftMapOutline?: boolean;
  /** Grid raft: solid bottom layer, mm (default 0.5). */
  raftGridBottomMm?: number;
  /** Grid raft: rib layer on top of the bottom, mm (default 1.5; bottom + top = 2 mm, the Formlabs Full Raft height). */
  raftGridTopMm?: number;
  /** Grid raft: rib width at the base of the ridge (the top of the bottom layer), mm (default 1). */
  raftRibMm?: number;
  /** Grid raft: side of the equilateral triangles the three rib directions form, mm (default 3.5). */
  raftRibPitchMm?: number;
  /** Grid raft: solid edge band along the outline, full height, mm (default 2). */
  raftRimMm?: number;
  /** Grid raft: a foot pad reaches this far past the foot radius, mm (default 0.5). */
  raftPadMarginMm?: number;
  /** Grid raft: width of the rib's flat top, mm (default 0.3); the ridge narrows straight from raftRibMm to it. */
  raftRibTopMm?: number;
  /** Grid raft: lean of the edge band's outer wall, degrees from vertical as raftWallAngle counts it (default 50 = 40 degrees from the plate); the top reaches past the footprint, the footprint is kept. */
  raftGridWallAngle?: number;
  /** Parts of a denture file (engine 50; default 1 mm): the file is split into its parts before anything else (faces joined by their edges; shells that only touch stay apart, nothing is welded or merged); the largest part by volume (by area when a part is open) gets the dental tips, a smaller part (hook, attachment) gets generic tips on its own faces with the denture spacing, and a part whose bounding box is less than this across is debris: listed, no tips. Every part is an obstacle to every support, and no tip is placed within 0.05 mm of another part or inside it. Engine 56: aligners too (the default only); a part overlapping or touching the target is fused: generic tips on its exposed faces only. 0 makes every smaller part an add-on. */
  partDebrisMm?: number;
  /** Plate auto-arrange (engine 53; default 6 mm): the least free distance between the footprints of two cases on one build plate (each build's space-map raft outline: the model's shadow joined with the foot discs, grown by the raft expand). One value for every case; the plate size comes from the printer profile. */
  plateGapMm?: number;
  /** Denture self-supporting overhangs (default false): an overhang region (faces joined by edges) that is small, gentle and short gets no open-area grid tips, like a slicer's min-area / min-angle / max-reach rules. Island, lowest-point, rim, dental rim band and hole-band tips are kept. */
  overhangSelfSupport?: boolean;
  /** Self-supporting overhangs: a region with this much projected area (mm2) or more keeps its tips (default 4). */
  overhangMinAreaMm2?: number;
  /** Self-supporting overhangs: a region reaching this far (mm, in plan) or more from where it joins the model keeps its tips (default 3). */
  overhangMaxReachMm?: number;
  /** Self-supporting overhangs: a region whose flattest face is within this many degrees of horizontal keeps its tips (default 19). */
  overhangMinAngleDeg?: number;
  /** Overhang angle (engine 57, default 45; replaces tipMaxFromDownDeg): the slope of a surface measured from horizontal, degrees (industry convention: 0 = a flat ceiling facing straight down, 90 = a vertical wall). A face needs support, and a tip may stand on it, when it points downward and its slope is BELOW this angle (flatter than the limit). It is the global value: the denture open-area and hole-band tips inherit it (generic units are placed by the scatterAngle setting, which is this same global value: engine 58, default 45, one Overhang angle control in the apps; the final guard judges exact-contact denture tips only); dentalRimOverhangAngleDeg and islandOverhangAngleDeg override it for their streams. Judged after the print tilt on the tip's averaged outward normal (tipNormalRadiusMm): the denture placement drops tips that fail (counted per stream, never silent), and the generate step holds every automatic exact-contact (denture) tip to it: one that fails, or stands on a knife-sharp fold, is left out with the reason tip-check:facing (or tip-check:fold). Hand-placed tips are exempt from this rule only (supports::tip_check). Range 0 to 90. */
  overhangAngleDeg?: number;
  /** Dental rim overhang angle (engine 57, default 60): overhangAngleDeg for the dental rim line and rim band tips (slope from horizontal, 0 = flat ceiling, 90 = vertical wall; a tip needs a face flatter than it). Range 0 to 90. */
  dentalRimOverhangAngleDeg?: number;
  /** Dental rim  (engine 39, default true): a rim, hole-band or area tip is skipped when its neck (along the tip's averaged normal, tipNormalRadiusMm) would enter the material behind a face within that radius (a knife-edge lip); a local low that is a true model lowest point is kept. Needs tipNormalRadiusMm above 0. */
  rimApproachOutside?: boolean;
  /** Tip direction (default 0.5 mm; 0 off): a tip's direction is the area-weighted average of the source-mesh face normals within this radius of its point (never the single most-downward adjacent face); the position never moves (supports::tip_orient). Dentures since engine 39; since engine 41 also every generic and aligner face or edge tip (in place of the remesh normal). Since engine 41 a face turned away from the face the tip stands on (the far side of a lip thinner than the radius, reached round its edge) does not vote. An average that is nearly zero gets no tip, counted in the review. */
  tipNormalRadiusMm?: number;
  /** Denture self-supporting overhangs, rim and hole streams (engine 40, default false; needs overhangSelfSupport): the dental rim, dental rim band and hole-band tips are also dropped on a self-supporting region. A tip within a rim pitch of a true lowest point, and island tips, are always kept. */
  overhangSelfSupportStreams?: boolean;
  /** Dental rim  respect the no-support zone (engine 40, default false): dental rim, dental rim band and hole-band tips are not placed on faces of the no-support zone (R1, with R1b when on) that the oral cavity ray (R2) does not see, so the fitting surface keeps its tips. A tip within a rim pitch of a true lowest point, and island tips, are kept. */
  rimRespectsNoSupport?: boolean;
  /** Denture tooth sockets (engine 42; default true since engine 43): blind craters on the teeth side, found once per model in the upright pose from the teeth-axis ray grid (basins of its depth map at least socketMinDepthMm deep, grown up their walls and inner lip), are a no-support zone for the rim, area and hole-band tips. Faces in the allowed area (the oral cavity ray R2 and the hole band) are never sockets (engine 59: where the allowed area overlaps the socket mask, the allowed area wins and the mask does not block tips there; it also overrides R1). Island and lowest-point tips are never dropped; they are listed. The review shows the sockets either way (socket_mask, sockets_cancelled_by_r2). */
  socketNoSupport?: boolean;
  /** Denture tooth sockets: the least depth a teeth-side basin holds to be a socket, mm (default 1). */
  socketMinDepthMm?: number;
  /** Denture tooth sockets: a through-hole of at most this area (mm2, seen along the teeth axis) at the bottom of a teeth-side crater is plugged, so the crater still counts as a socket (default 25; 0: every through-hole drains its crater). Larger through-holes always drain. */
  socketTunnelMaxMm2?: number;
  /** Denture resin-trap checks (engine 44, default true; false off): once per review at the chosen print tilt (never inside the tilt scan), the model is seen from the plate (a 0.4 mm ray grid along the print up) and every hollow whose opening faces the plate is measured: as a suction cup (the review's suction_cups / suction_mask, layer "Suction cups") and as a pocket that holds resin after printing (drain_pockets / drain_mask, layer "Drain / clean"; the model hangs from the plate, so such a hollow opens upward during the lift), with the tooth sockets deeper than drainSocketDepthMm (drain_sockets). Review-only: no tip and no tilt changes. Levels in every list and mask: 1 vented / drains, 2 low, 3 medium, 4 high (5 in drain_mask: a hard-to-clean socket). */
  trapCheck?: boolean;
  /** Resin traps: the least depth of resin a plate-facing hollow holds to be a cup or pocket, mm (default 0.5: shallower is surface texture, stipple and rugae run 0.2-0.4 mm; 0.5 mm is ten 0.05 mm layers). */
  trapMinDepthMm?: number;
  /** Resin traps: a through-hole of at most this area (mm2, seen from the plate; default 20, about 5 mm across) inside a hollow is its vent: the hollow is still found, marked vented (level 1: no suction, it drains). A larger opening makes the shape a tube, not a cup. 0: every through-hole drains its hollow away (not found). */
  trapVentMaxMm2?: number;
  /** Suction cups: the opening area (mm2, projected on the plate) from which a sealed cup counts (default 50, a cup about 8 mm across, where resin printers start to show cupping: the peel pull grows with the opening). Area and volume both reached: high; one: medium; neither: low. */
  suctionAreaMm2?: number;
  /** Suction cups: the trapped volume (mm3) from which a sealed cup counts (default 100, 0.1 ml: the 50 mm2 opening about 2 mm deep; the resin each lift must draw back in). A full upper denture's fitting surface face-down is thousands of both. */
  suctionVolumeMm3?: number;
  /** Drain / clean: the depth to opening-width ratio from which a pocket counts (default 1: deeper than wide, the rinse and a brush do not reach its floor). The width is the widest disc that fits the opening, so a long slot is as narrow as it is wide. Aspect and volume both reached: high; one: medium; neither: low. */
  drainAspectRatio?: number;
  /** Drain / clean: the resin volume (mm3) from which a pocket counts (default 20: enough uncured resin to pool and cure as a blob in the post-cure). */
  drainVolumeMm3?: number;
  /** Drain / clean: a tooth socket (socketMinDepthMm, R2's faces removed) at least this deep is reported hard to clean, mm (default 3: a socket is a few mm wide, so past 3 mm it is deeper than wide and a brush does not reach the floor, where uncured resin weakens the tooth's bond). */
  drainSocketDepthMm?: number;
  /** Tips by overhang area (engine 45; opt-in, default false: the area spacing is global, downPitchMm for dentures and Spacing for generic; on by default in engine 47 only): with true the open-area overhang faces (dentures: outside the dental rim band and the hole band; generic since engine 47: the Poisson field's overhang faces) are joined into connected regions and each region's pitch is base x f(A) x g(c), clamped to areaMinPitchMm..areaMaxPitchMm (widened to include the base), where the base is downPitchMm or Spacing, A is the region's projected area (what the vat film sees) and c its mean steepness: a large flat face-down area peels or sags, so its tips stand closer. f(A) = 1 up to areaRefMm2, else max(areaDenseFloor, sqrt(areaRefMm2 / A)); g(c) = 1 + areaSteepLighten x (1 - c) / 0.5. The edge streams never take these pitches (they keep the global spacing). Island and lowest-point tips are never moved or dropped by it. The review lists every region (area, steepness, height, pitch, tips). Aligners are not affected. */
  areaDensity?: boolean;
  /** Tips by area: regions up to this projected area keep the base pitch, mm2 (default 50). */
  areaRefMm2?: number;
  /** Tips by area: the smallest factor on the base pitch for a huge region (default 0.6: 2 mm becomes 1.2 mm; 0 < value <= 1). */
  areaDenseFloor?: number;
  /** Tips by area: how much a steep region lightens its pitch (default 0: steepness ignored; 0.5: a region lying 60 degrees from straight down gets 1.5 x the pitch). */
  areaSteepLighten?: number;
  /** Tips by area: the hard floor of a region's pitch, mm (default 1.0, two contact diameters). */
  areaMinPitchMm?: number;
  /** Tips by area: the hard ceiling of a region's pitch, mm (default 3.0). */
  areaMaxPitchMm?: number;
  /** Edge corners (engine 47; default 45 degrees; 0 off): every turn of an edge line (a dental rim stretch, a generic region border or ridge) sharper than this gets a tip exactly at it (generic: inset into the face by edgeInset like every anchor), and between two corners (or the ends of a stretch) the edge holds a whole number of equal gaps no longer than its pitch: the global spacing (downPitchMm, Spacing) unless dentalRimPitchMm / genericEdgePitchMm is set. The dental rim is first cut into the stretches where a tip may stand (the averaged tip direction overhangs within tipMaxFromDownDeg, no knife-sharp fold or inward neck, and not dropped by socketNoSupport, rimRespectsNoSupport or overhangSelfSupportStreams when on); a lowest-point or island tip on the line ends a stretch a rim pitch before it; a stretch shorter than half its pitch gets one tip at its lowest point. Corner tips pass the same hard rules (facing, path) as every edge tip. */
  edgeCornerDeg?: number;
  /** Edge corners: the edge length either side (mm, default 1.0) over which a turn is measured, so a scan line's zigzag along its triangles is no corner; within one span only the sharpest turn counts. */
  edgeCornerSpanMm?: number;
  /** Generic edge pitch (engine 47; default unset = the global Spacing): when set (mm, > 0) the generic border and ridge anchors are spaced at this value. */
  genericEdgePitchMm?: number;
  /** Contact fit (engine 45, exact-contact builds only, default false; true on): the controlled contact loop. Each tip's real contact patch is measured, not assumed: contactFitRays straight lines of the cone surface run up from the cone's end and where each crosses the model near the contact is a point of the real ring (the faces near every contact are copied once per build); the bite (how far the cone's end sits below the contact along its axis) is bisected until the ring's area-equivalent diameter is within contactFitTolMm of the nominal contact diameter (tipBallMm), so on a curved surface or a turned neck the contact stays the same size and breaks clean. The route planner judges the same end the builder builds. A ring that hangs off an edge (more than a quarter of the lines miss) or does not converge keeps the analytic end; no tip is moved or dropped. Off: the analytic end, as before. */
  contactFit?: boolean;
  /** Contact fit: accept a ring whose equivalent diameter is within this of the nominal diameter, mm (default 0.03). */
  contactFitTolMm?: number;
  /** Contact fit: lines of the cone surface per ring (default 16, at least 3). */
  contactFitRays?: number;
  /** Contact fit: bisection steps (default 6: 0.6 mm halved six times is 0.01 mm). */
  contactFitMaxIters?: number;
  /** Contact fit: the deepest bite searched, as a multiple of biteDepthMm (default 2.0). */
  contactFitMaxBiteFactor?: number;
  /** Tip check, outside the solid (engine 41, default true; false off): every support path, of every tip and every route stage, manual live edits included, leaves the surface outward (within 90 degrees of the tip's averaged normal) and its centre line, from tipInsideSkipMm past the contact through every bend, never runs inside the model (ray parity, and no crossing of the surface). This holds inside the radius the verdict's reach rule exempts around a contact, which let a neck pass through the far side of a thin lip. A refused path makes the route search try the next one; a tip with no acceptable path is left out with the reason tip-check:inside or tip-check:neck-inward (hand-placed ones too: they are never built inside the model). */
  tipInsideCheck?: boolean;
  /** Tip check: how far past the contact along the neck the centre line starts to count, mm (default 0.1): the tip itself sits in the surface. */
  tipInsideSkipMm?: number;
  /** Island and lowest-point overhang angle (engine 57, default 60; replaces islandMaxFromDownDeg): overhangAngleDeg for island tips (an island's lowest point, denture or generic) and denture lowest-point tips, slope from horizontal (0 = flat ceiling, 90 = vertical wall). A tip stands only where its averaged normal has a slope below it; past it the tip is not placed (the denture counts it, generate leaves it out as tip-check:facing) and the island is reported unsupported. Range 0 to 90. */
  islandOverhangAngleDeg?: number;
  /** Tip check, the cone's flank (engine 41, default 0.3 mm; 0 off): from this distance along the neck to the neck's end, points round the neck cone at its radius stay outside the model, so a neck leaning far from the surface normal never cuts its flank into the surface beside the tip; the route search leans it less or reroutes, else the tip is left out (tip-check:cone). */
  tipSkinFromMm?: number;
  /** Landing circle: steepest lean that still counts as a normal path, degrees from vertical (default 45; the fallback tier uses lastResortOutlineAngleDeg). */
  landingRodMaxDeg?: number;
  /** Landing circle: spacing of the sideways shifts tried along each direction, mm (default 1). */
  landingCellStepMm?: number;
  /** Landing circle: spacing of the height tests along a rod, mm (default 0.5). */
  landingRodSampleMm?: number;
  /** Landing circle: directions tried around the tip (default 16). */
  landingDirections?: number;
  /** Landing circle: 1 = straight and one lean, 2 = also a first lean and a second lean (default 2). */
  landingLeans?: 1 | 2;
  /**
   * Dental-only option (dentures only, default 0 = off): support a tip from the model's own surface, used only when the plate route and the
   * last-resort tier both failed. 0 off, 1 lowest points and islands only, 2 any left-out tip. The landing order is allowed area, other
   * surface, no-support zone. A per-tip allow list (`PolicyHandle.set_model_landing_allow`) admits single tips whatever the value is.
   */
  dentalModelLanding?: 0 | 1 | 2;
}

/** The override array's layout; mirrors Rust `supports::rules::NAMES` exactly (a test checks it against the wasm's `rule_names()`). */
export const RULE_NAMES: readonly string[] = [
  'routeMaxBends', 'routeFineDirections', 'routeCoarseDirections', 'routeShiftStepMm', 'routeBranchMaxMm', 'routeJoinBelowTopMm', 'routeJoinBelowTipMm',
  'tipsPerPillar', 'jointGapMm', 'routeDeeperJoins', 'thickOverBranches', 'thickFactor', 'capsuleJudge', 'neckPretest',
  'lowMinTipHeightMm', 'lowMinNodeHeightMm',
  'outlineRodMaxMm', 'outlineBracedOverMm', 'outlineMaxAngleDeg', 'spaceCellMm', 'outlineRodMarginMm', 'outlinePillarSpacingMm', 'outlineDeeperJoints', 'outlineDeeperBraces',
  'capsuleMarginMm',
  'mergeSpacingDiameters', 'mergeMaxAngleDeg', 'mergeRodMaxMm', 'mergePasses', 'mergeDeeperNodes',
  'trunkSupportOverMm', 'trunkSupportOverTips', 'trunkNeckAngleDeg', 'trunkNeckMm', 'trunkSupportBelowJointMm', 'trunkDirections', 'trunkSpacingDiameters', 'trunkDeeperSupport',
  'neckRampSlope', 'neckGapMm', 'neckLiftTries', 'neckGapTargetMm', 'tipTimeMs', 'treesForExactContactOnly', 'boxedInTiltWeight',
  'islandTips', 'islandMinAreaMm2', 'lowOutsideAllowed', 'islandReuseMm', 'islandSlabMm',
  'trunkSecondHelperOverMm', 'trunkSupportMaxFrac', 'trunkBraceStepMm', 'trunkSupportMinMm',
  'branchRodMaxMm', 'outlineRodCapMm', 'helperRodMaxMm',
  'spaceMarginMm',
  'lastResort', 'lastResortOutlineAngleDeg', 'lastResortClearanceMm', 'rimLowNeedsOverhang', 'lastResortClearanceStepMm',
  'landingTiltWeight', 'landingRodMaxDeg', 'landingCellStepMm', 'landingRodSampleMm',
  'dentalModelLanding',
  'capsuleFilter', 'judgeAgreement', 'capsuleFilterMarginMm',
  'landingDirections', 'landingLeans',
  'tiltAllowedLowsOnly', 'tiltPickOrder', 'tiltTipCountSlack',
  'noSupportSteepDeg',
  'raftGrid', 'raftMapOutline', 'raftGridBottomMm', 'raftGridTopMm', 'raftRibMm', 'raftRibPitchMm', 'raftRimMm', 'raftPadMarginMm',
  'overhangSelfSupport', 'overhangMinAreaMm2', 'overhangMaxReachMm', 'overhangMinAngleDeg',
  'overhangAngleDeg', 'rimApproachOutside', 'tipNormalRadiusMm',
  'overhangSelfSupportStreams', 'rimRespectsNoSupport',
  'tipInsideCheck', 'tipInsideSkipMm', 'islandOverhangAngleDeg', 'tipSkinFromMm',
  'socketNoSupport', 'socketMinDepthMm', 'socketTunnelMaxMm2',
  'trapCheck', 'trapMinDepthMm', 'trapVentMaxMm2', 'suctionAreaMm2', 'suctionVolumeMm3', 'drainAspectRatio', 'drainVolumeMm3', 'drainSocketDepthMm',
  'areaDensity', 'areaRefMm2', 'areaDenseFloor', 'areaSteepLighten', 'areaMinPitchMm', 'areaMaxPitchMm',
  'contactFit', 'contactFitTolMm', 'contactFitRays', 'contactFitMaxIters', 'contactFitMaxBiteFactor',
  'edgeCornerDeg', 'edgeCornerSpanMm', 'genericEdgePitchMm',
  'raftRibTopMm', 'raftGridWallAngle',
  'partDebrisMm',
  'plateGapMm',
  'dentalRimOverhangAngleDeg',
];

/** `rules` as the engine reads it: one entry per `RULE_NAMES` name; NaN keeps the engine's default, booleans become 1 or 0. */
export function packRules(rules?: GenerateRules): Float64Array {
  const values = new Float64Array(RULE_NAMES.length).fill(NaN);
  if (!rules) return values;
  const given = rules as Record<string, number | boolean | undefined>;
  RULE_NAMES.forEach((name, k) => {
    const v = given[name];
    if (v !== undefined) values[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
  return values;
}

/**
 * The overrides every `generate` call uses; empty, so the engine's defaults apply. Put values here to
 * tune the planner without a Rust rebuild.
 */
export const GENERATE_RULES: GenerateRules = {};
