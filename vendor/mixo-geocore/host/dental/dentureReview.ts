import type { TriangleMesh } from '../core/analysis/types';
import type { Vector } from '../core/vec3';
import type { GenerateRules } from '../supports/generateRules';
import { packRules } from '../supports/generateRules';
import { withDentalMesh, type DentureReviewResultLike } from './dentalEngine';
import { decodeIslands, type DentureIsland } from './dentureIslands';
import { partsOf, type DenturePart } from './dentureParts';
import { records } from '../core/arity';

/*
 * Review layers of the owner denture rules (Rust `dental::denture::review` through
 * `denture_review`): the no-support and allowed face masks, every hard edge, the down-facing hard edges, the middle
 * plane (and the chains it is fitted through), the tight box  and the generated tips with their pillar inputs, all in the unit-local mesh frame (mm),
 * independent of how the file was oriented. The host only decodes; the batch draws layers.
 */

/** Stream codes of a tip's `stream`. */
/** Source tags: `low` low point, `area` down-facing area grid, `rim` along the rim, `hole` around a hole loop, `island` the lowest vertex of an island (`bar`, `light` are the old streams). */
export const TIP_STREAM = ['low', 'area', 'bar', 'light', 'rim', 'hole', 'island'] as const;

/**
 * The stream a tip reports. `unknown` is NOT in `TIP_STREAM`: that array is the engine's code space,
 * indexed by code, so putting `unknown` in it would give code 7 a meaning the engine never assigned.
 */
export type TipStream = (typeof TIP_STREAM)[number] | 'unknown';

/** The stream a tip's code names, `unknown` for a code this version does not know (GEO-005). */
export const tipStreamOf = (code: number | undefined): TipStream => TIP_STREAM[code ?? -1] ?? 'unknown';

/** One line segment. */
export type Segment = [Vector, Vector];

/** A resin trap's level, the same numbers in every list and mask (engine 44): 1 vented / drains (found, harmless), 2 low, 3 medium, 4 high; 0 in a mask is "not a trap", 5 in `drainMask` a hard-to-clean socket. */
export const TRAP_LEVEL = ['none', 'vented', 'low', 'medium', 'high', 'socket'] as const;

/** A suction cup at the reviewed tilt: a hollow facing the plate whose rim closes all round as seen from the plate (engine 44, rules suctionAreaMm2 / suctionVolumeMm3). */
export interface SuctionCup {
  /** Opening area projected on the plate, mm2. */
  areaMm2: number;
  /** Trapped resin, mm3. */
  volumeMm3: number;
  /** Deepest resin, mm. */
  depthMm: number;
  /** The rim's least and greatest height above the model's lowest point along the print up, mm (the least is where it spills). */
  rimMm: [number, number];
  /** A through-hole (at most trapVentMaxMm2) in it: no suction. */
  vented: boolean;
  /** 1 vented, 2 low, 3 medium, 4 high (`TRAP_LEVEL`). */
  level: number;
  /** Its deepest floor point, for a label. */
  floor: Vector;
}

/** A pocket that holds uncured resin after printing: a hollow facing the plate, so open upward during the lift (engine 44, rules drainAspectRatio / drainVolumeMm3). */
export interface DrainPocket {
  volumeMm3: number;
  depthMm: number;
  /** The widest disc that fits its opening, mm. */
  widthMm: number;
  /** depthMm / widthMm. */
  aspect: number;
  areaMm2: number;
  /** A through-hole in its floor drains it. */
  vented: boolean;
  /** 1 drains, 2 low, 3 medium, 4 high (`TRAP_LEVEL`). */
  level: number;
  floor: Vector;
}

/** A tooth socket at least drainSocketDepthMm deep: hard to clean (engine 44). */
export interface DeepSocket {
  depthMm: number;
  areaMm2: number;
  widthMm: number;
  floor: Vector;
}

export interface DentureReview {
  /** Step 1, per face: 1 when a 45 degree front-top parallel ray hits it first (NO_SUPPORT before the override), else 0. */
  noSupportMask: Uint8Array;
  /** Per face: 1 when only R1b (the steep no-support ray, rule `noSupportSteepDeg`) hits it first, not R1; a subset of `noSupportMask`; all 0 with R1b off. */
  noSupportSteepMask: Uint8Array;
  /** The R1b angle in degrees, 0 when off. */
  noSupportSteepDeg: number;
  /** Step 2, per face: 1 when a ray from the back origin reaches it first (ALLOWED; overrides no-support; tips stand only here), else 0. */
  allowedMask: Uint8Array;
  /** Every hard edge. */
  hardEdges: Segment[];
  /** The hard edges that face down in the oriented pose (before the print tilt): the support candidates. */
  downEdges: Segment[];
  /** The down-facing hard edges joined into continuous lines (gaps bridged), each a polyline to draw as one line; `length` in mm. */
  downChains: { points: Vector[]; length: number }[];
  /** The tight oriented box; `centre` is the point rays are cast from. */
  box: { centre: Vector; axes: [Vector, Vector, Vector]; half: Vector };
  /** Oral cavity ray origin: on the rim plane, at the back edge of the tight box, on the symmetry plane; the allowed-area rays start here. */
  oralCavityRay: Vector;
  /** The unit 45 degree no-support ray direction (front-top toward back-bottom). */
  noSupportDir: Vector;
  /** Overhang candidates, per face: 1 when within 60 degrees of straight down for the reviewed plate normal. */
  downMask: Uint8Array;
  /** Tips on an overhang with no free path to the plate: not built, never rooted on the model. */
  unsupportable: { position: Vector; normal: Vector; stream: TipStream; face: number }[];
  /** Low points after the tilt outside the allowed area (left unsupported), with the face each sits on. */
  lowsOutside: { position: Vector; face: number }[];
  /** Lowest points that got a tip and the clause that admitted each (`lowTipReason`): in the allowed area, outside the no-support zone, or within profile `lowRimBandMm` of the rim; `anywhere` only under rule `lowOutsideAllowed` 2 (even in the no-support zone). Under the default rule a low point in the no-support zone and farther from the rim gets none and stays in `lowsOutside`. */
  lowTips: { position: Vector; lowTipReason: 'allowed' | 'outsideNoSupport' | 'rimBand' | 'anywhere' }[];
  /** Allowed low points no tip reaches. */
  lowsUnreached: { position: Vector; face: number }[];
  /** Candidates released because their face is not an overhang for the plate normal. */
  released: number;
  /** Local lows of the dental rim whose face points up: not forced, no tip (rule `rimLowNeedsOverhang`); counted apart from the left-out tips. */
  rimLowsFacingUp: number;
  /** The final guard (rule overhangAngleDeg, engine 39): tips refused for standing on a face not within the limit of straight down, per source, and the island / lowest-point tips on a face that is not down-facing (misidentified lows). */
  tipsDroppedFacingUp: { rim: number; hole: number; area: number; other: number; total: number };
  /** Tips skipped for a knife-sharp fold (averaged normal nearly zero) or a neck that would enter the material behind a nearby face (engine 39). */
  tipsSkippedFold: { rim: number; hole: number; area: number; other: number; total: number };
  lowsNotDownFacing: Vector[];
  /** Self-supporting overhang regions (rule `overhangSelfSupport`): their face ids (no open-area tips there) and the counts. Empty / zeros with the rule off. */
  selfSupport: { faces: Uint32Array; regions: number; selfSupporting: number; tipsSaved: number };
  /** Rule areaDensity (engine 45): every open-area region with its projected area (mm2), mean steepness, mean height (mm), grid pitch (mm), face count and tips; empty with the rule off. */
  areaRegions: Array<{ projectedMm2: number; steepness: number; heightMm: number; pitchMm: number; faces: number; tips: number }>;
  /** The islands of the reviewed pose (regions that start mid-air) with the tip that serves each or the reason it has none; `tipIndex` indexes `tips`. Empty with rule `islandTips` off. */
  islands: DentureIsland[];
  /** Why the islands could not be told (the surface is not a clean manifold...); empty when they could. */
  islandsNote: string;
  /** The file's parts (engine 50; `dentureParts.ts`): the review runs on the target, every mask and face id is the file's. */
  parts: DenturePart[];
  /** The part id of every face of the file (the layer "Parts"); empty from an engine before 50. */
  faceParts: Uint32Array;
  /** Rim plane (least squares through the rim loop points, normal to the top), absent without a rim. */
  rimPlane?: { point: Vector; normal: Vector };
  /** Symmetry plane: the upright plane that splits the U left/right (normal = the left-right axis). */
  symmetryPlane: { point: Vector; normal: Vector };
  /** The oriented pose's plate normal in the mesh frame; down is its reverse. */
  up: Vector;
  /** The tips; `face` is the mesh face each stands on. */
  tips: { position: Vector; normal: Vector; stream: TipStream; face: number }[];
  /** The rim (low points joined over the mesh edges, engine 20): one or more ordered polylines; `edges` are the mesh edge ids (segment k joins point k and k + 1, a closed line's last segment closes it). Absent without a rim. */
  rimLoops?: { lines: { points: Vector[]; edges: number[]; closed: boolean }[]; lengthMm: number; allTheWayRound: boolean; largestGapDeg: number };
  /** Hole outlines (hit points around each hole seen along the teeth axis, canonical pose) with the hole area and the count of faces next to it. */
  holeOutlines: { points: Vector[]; areaMm2: number; faceCount: number }[];
  /** Per face: 1 within 5 mm along the surface of a hole (support-allowed). */
  holeBandMask: Uint8Array;
  /** Per face: 1 on a tooth socket (engine 42, rule socketMinDepthMm), whether or not socketNoSupport keeps tips off it: the layer "Sockets (no support)". */
  socketMask: Uint8Array;
  /** Basin faces the allowed area covers (R2 and the hole band), so not sockets (the allowed area cancels the socket mask, engine 59). */
  socketsCancelledByR2: number;
  /** Per face: 1 on the fitting surface seen as a basin from the tissue side: the cross-check layer "Fitting (basin)" (changes no tip). */
  fittingMask: Uint8Array;
  /** The fitting basin against the zones, face counts: fitting, fitting and allowed, fitting and no-support, fitting and neither, allowed but not fitting. */
  fittingCheck: Uint32Array;
  /** socketNoSupport: tips kept off sockets [rim, hole, area, other]. */
  tipsDroppedSocket: Uint32Array;
  /** Island and lowest-point tips standing on a socket (kept), xyz each. */
  lowsInSockets: Float64Array;
  /** Suction cups at the reviewed tilt (engine 44; empty with trapCheck off). */
  suctionCups: SuctionCup[];
  /** Per face: the level of the suction cup it belongs to (0 none): the layer "Suction cups"; empty with trapCheck off. */
  suctionMask: Uint8Array;
  /** Pockets that hold resin after printing (engine 44). */
  drainPockets: DrainPocket[];
  /** Tooth sockets deeper than drainSocketDepthMm (hard to clean). */
  deepSockets: DeepSocket[];
  /** Per face: the pocket level (1..4), 5 on a hard-to-clean socket, 0 elsewhere: the layer "Drain / clean"; empty with trapCheck off. */
  drainMask: Uint8Array;
  /** Per face: 1 within the dental rim band (profile `rimBandMm`) of the dental rim: support-allowed outside the oral cavity area. */
  rimBandMask: Uint8Array;
  /** The ray test's up decision (absent for a mesh with no box): the median travel before the first hit near the + and the - end of the up axis (the end whose rays reach farther is the top), their margin, and the arch frame's up before it. */
  upDecision?: {
    /** T1b ray-median numbers: diagnostic only since ABI 23 (axis, medians at the + / - end, margin, hits). */
    axis: number; medianMm: [number, number]; marginMm: number; hits: [number, number];
    decided: boolean; flipped: boolean;
    /** Up as decided by the front/back result (from the back, the open end of the U, toward the front). */
    up: Vector; archUpBefore: Vector;
    /** Section slices: how many name the chosen top, name the other side, did not vote. */
    sliceVotes: { for: number; against: number; abstain: number };
    /** Share of voting slices that agree (0 when none voted: the arch frame's teeth side was kept). */
    confidence: number;
    /** The crown (top) side. */
    top: Vector;
    teethFlipped: boolean;
    /** Front/back from the arch footprint; absent for a mesh with no footprint. */
    frontBack?: { back: Vector; widthMargin: number; crossCheckAgrees: boolean; endWidthMm: [number, number] };
  };
  /** Pillar geometry inputs, mm: contact ball, frustum base, neck length, pillar diameter, lift off the plate. */
  pillar: { tipBall: number; frustumBase: number; neckLength: number; pillarDiameter: number; lift: number };
}

const triple = (a: ArrayLike<number>, at: number): Vector => [a[at]!, a[at + 1]!, a[at + 2]!];
const lows = (flat: ArrayLike<number>, faces: ArrayLike<number>) => Array.from({ length: faces.length }, (_, k) => ({ position: triple(flat, k * 3), face: faces[k]! }));
/** The review's `suction_cups()`, 10 numbers each. */
export const decodeCups = (f: ArrayLike<number>): SuctionCup[] => Array.from({ length: Math.floor(f.length / 10) }, (_, k) => {
  const a = k * 10;
  return { areaMm2: f[a]!, volumeMm3: f[a + 1]!, depthMm: f[a + 2]!, rimMm: [f[a + 3]!, f[a + 4]!], vented: f[a + 5] === 1, level: f[a + 6]!, floor: triple(f, a + 7) };
});
/** The review's `drain_pockets()`, 10 numbers each. */
export const decodePockets = (f: ArrayLike<number>): DrainPocket[] => Array.from({ length: Math.floor(f.length / 10) }, (_, k) => {
  const a = k * 10;
  return { volumeMm3: f[a]!, depthMm: f[a + 1]!, widthMm: f[a + 2]!, aspect: f[a + 3]!, areaMm2: f[a + 4]!, vented: f[a + 5] === 1, level: f[a + 6]!, floor: triple(f, a + 7) };
});
/** The review's `drain_sockets()`, 6 numbers each. */
export const decodeDeepSockets = (f: ArrayLike<number>): DeepSocket[] => Array.from({ length: Math.floor(f.length / 6) }, (_, k) => {
  const a = k * 6;
  return { depthMm: f[a]!, areaMm2: f[a + 1]!, widthMm: f[a + 2]!, floor: triple(f, a + 3) };
});
const segments = (flat: ArrayLike<number>): Segment[] => Array.from({ length: flat.length / 6 }, (_, k) => [triple(flat, k * 6), triple(flat, k * 6 + 3)]);

/** Decodes and frees a `denture_review` result. */
export function decodeDentureReview(result: DentureReviewResultLike): DentureReview {
  try {
    const box = result.box_();
    const rimPlane = result.rim_plane();
    const symmetry = result.symmetry_plane();
    const tips = result.tips();
    const faces = result.tip_faces();
    const pillar = result.pillar();
    const rimFlat = result.rim_loops();
    const rimSizes = result.rim_sizes();
    const rimClosed = result.rim_closed();
    const rimEdges = result.rim_edges();
    const rimInfo = result.rim_info();
    const holeFlat = result.hole_outlines();
    const holeSizes = result.hole_sizes();
    const holeInfo = result.hole_info();
    const decision = result.up_decision();
    return {
      rimLoops: rimSizes.length === 0 ? undefined : (() => {
        let at = 0;
        let edgeAt = 0;
        const lines = Array.from(rimSizes, (n, k) => {
          const closed = rimClosed[k] === 1;
          const edgeCount = closed ? n : n - 1;
          const points = Array.from({ length: n }, (_, i) => triple(rimFlat, (at + i) * 3));
          const edges = Array.from(rimEdges.slice(edgeAt, edgeAt + edgeCount));
          at += n;
          edgeAt += edgeCount;
          return { points, edges, closed };
        });
        return { lines, lengthMm: rimInfo[0]!, allTheWayRound: rimInfo[2] === 1, largestGapDeg: rimInfo[3]! };
      })(),
      holeOutlines: (() => {
        let at = 0;
        return Array.from(holeSizes, (n, k) => {
          const points = Array.from({ length: n }, (_, i) => triple(holeFlat, (at + i) * 3));
          at += n;
          return { points, areaMm2: holeInfo[k * 2]!, faceCount: holeInfo[k * 2 + 1]! };
        });
      })(),
      holeBandMask: result.hole_band_mask(),
      socketMask: result.socket_mask(),
      socketsCancelledByR2: result.sockets_cancelled_by_r2(),
      fittingMask: result.fitting_mask(),
      fittingCheck: result.fitting_check(),
      tipsDroppedSocket: result.tips_dropped_socket(),
      lowsInSockets: result.lows_in_sockets(),
      suctionCups: decodeCups(result.suction_cups()),
      suctionMask: result.suction_mask(),
      drainPockets: decodePockets(result.drain_pockets()),
      deepSockets: decodeDeepSockets(result.drain_sockets()),
      drainMask: result.drain_mask(),
      rimBandMask: result.rim_band_mask(),
      upDecision: decision.length === 0 ? undefined : {
        axis: decision[0]!, decided: decision[1] === 1, flipped: decision[2] === 1, medianMm: [decision[3]!, decision[4]!], marginMm: decision[5]!,
        hits: [decision[6]!, decision[7]!], up: triple(decision, 8), archUpBefore: triple(decision, 11),
        sliceVotes: { for: decision[14]!, against: decision[15]!, abstain: decision[16]! },
        confidence: decision[17]!, top: triple(decision, 18), teethFlipped: decision[21] === 1,
        frontBack: Number.isNaN(decision[22]) ? undefined : {
          back: triple(decision, 22), widthMargin: decision[25]!, crossCheckAgrees: decision[26] === 1, endWidthMm: [decision[27]!, decision[28]!],
        },
      },
      noSupportMask: result.no_support_mask(),
      noSupportSteepMask: result.no_support_steep_mask(),
      noSupportSteepDeg: result.no_support_steep_deg(),
      allowedMask: result.allowed_mask(),
      hardEdges: segments(result.hard_edges()),
      downEdges: segments(result.down_edges()),
      downChains: (() => {
        const flat = result.chain_points();
        const sizes = result.chain_sizes();
        const lengths = result.chain_lengths();
        let at = 0;
        return Array.from(sizes, (n, k) => {
          const points = Array.from({ length: n }, (_, i) => triple(flat, (at + i) * 3));
          at += n;
          return { points, length: lengths[k]! };
        });
      })(),
      box: { centre: triple(box, 0), axes: [triple(box, 3), triple(box, 6), triple(box, 9)], half: triple(box, 12) },
      oralCavityRay: triple(result.oral_cavity_ray(), 0),
      noSupportDir: triple(result.no_support_dir(), 0),
      lowsOutside: lows(result.lows_outside(), result.lows_outside_faces()),
      lowTips: (() => {
        const flat = result.low_tip_points();
        const reasons = result.low_tip_reasons();
        return Array.from(reasons, (reason, k) => ({ position: triple(flat, k * 3), lowTipReason: reason === 0 ? 'allowed' as const : reason === 1 ? 'outsideNoSupport' as const : reason === 2 ? 'rimBand' as const : 'anywhere' as const }));
      })(),
      lowsUnreached: lows(result.lows_unreached(), result.lows_unreached_faces()),
      downMask: result.down_mask(),
      unsupportable: (() => {
        const u = result.unsupportable();
        // GEO-006: `u.length / 7` on a truncated array is fractional, and `Array.from` rounds it
        // down - the last point vanished rather than being reported as a bad array.
        return Array.from({ length: records(u, 7, 'review unsupportable array') }, (_, k) => ({ position: triple(u, k * 7), normal: triple(u, k * 7 + 3), stream: tipStreamOf(u[k * 7 + 6]), face: -1 }));
      })(),
      released: result.released(),
      rimLowsFacingUp: result.rim_lows_facing_up(),
      tipsDroppedFacingUp: (() => {
        const d = result.tips_dropped_facing_up();
        return { rim: d[0] ?? 0, hole: d[1] ?? 0, area: d[2] ?? 0, other: d[3] ?? 0, total: (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) + (d[3] ?? 0) };
      })(),
      tipsSkippedFold: (() => {
        const d = result.tips_skipped_fold();
        return { rim: d[0] ?? 0, hole: d[1] ?? 0, area: d[2] ?? 0, other: d[3] ?? 0, total: (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) + (d[3] ?? 0) };
      })(),
      lowsNotDownFacing: (() => {
        const l = result.lows_not_down_facing();
        return Array.from({ length: l.length / 3 }, (_, k) => triple(l, k * 3));
      })(),
      selfSupport: (() => {
        const info = result.self_support_info();
        return { faces: result.self_support_faces(), regions: info[0] ?? 0, selfSupporting: info[1] ?? 0, tipsSaved: info[2] ?? 0 };
      })(),
      areaRegions: (() => {
        const r = result.area_regions();
        return Array.from({ length: Math.floor(r.length / 6) }, (_, k) => ({ projectedMm2: r[k * 6]!, steepness: r[k * 6 + 1]!, heightMm: r[k * 6 + 2]!, pitchMm: r[k * 6 + 3]!, faces: r[k * 6 + 4]!, tips: r[k * 6 + 5]! }));
      })(),
      islands: decodeIslands(result.islands()),
      islandsNote: result.islands_note(),
      ...partsOf(result),
      rimPlane: rimPlane.length === 6 ? { point: triple(rimPlane, 0), normal: triple(rimPlane, 3) } : undefined,
      symmetryPlane: { point: triple(symmetry, 0), normal: triple(symmetry, 3) },
      up: triple(result.up(), 0),
      // GEO-006: the same truncation, on the array the operator's tip list is built from.
      tips: Array.from({ length: records(tips, 7, 'review tip array') }, (_, k) => ({ position: triple(tips, k * 7), normal: triple(tips, k * 7 + 3), stream: tipStreamOf(tips[k * 7 + 6]), face: faces[k]! })),
      pillar: { tipBall: pillar[0]!, frustumBase: pillar[1]!, neckLength: pillar[2]!, pillarDiameter: pillar[3]!, lift: pillar[4]! },
    };
  } finally {
    result.free();
  }
}

/** The review of `mesh` (unit-local) for the denture type `profile`, or `undefined` for a mesh too small to have a box. `rules` (absent: the engine's defaults) are the planner rules the review reads (island tips, `lowOutsideAllowed`). */
export function reviewDenture(mesh: TriangleMesh, profile: string, tiltDeg = 0, rules?: GenerateRules): DentureReview | undefined {
  return withDentalMesh(mesh, (session, model) => {
    const result = session.denture_review_ruled(model, profile, tiltDeg, packRules(rules));
    return result ? decodeDentureReview(result) : undefined;
  });
}

/** Face classes of `compareDentureAreas`: neither, owner only, generated only, both (paint in three colours). */
export const AREA_CLASS = { neither: 0, ownerOnly: 1, generatedOnly: 2, both: 3 } as const;

export interface DentureAreaComparison {
  /** Per face, an `AREA_CLASS` code. */
  mask: Uint8Array;
  ownerMm2: number;
  generatedMm2: number;
  bothMm2: number;
  /** Share (0..1) of the owner area also in the generated area. */
  coverage: number;
  /** Share (0..1) of the generated area outside the owner area. */
  extra: number;
}

/**
 * Support areas compared: faces whose centroid lies within `radiusMm` (2 by the owner) of the owner
 * contacts, of the generated tips, of both. Points are in the unit-local mesh frame.
 */
export function compareDentureAreas(mesh: TriangleMesh, owner: readonly Vector[], generated: readonly Vector[], radiusMm = 2): DentureAreaComparison {
  return withDentalMesh(mesh, (session, model) => {
    const result = session.denture_compare_areas(model, Float64Array.from(owner.flat()), Float64Array.from(generated.flat()), radiusMm);
    try {
      const [ownerMm2, generatedMm2, bothMm2] = result.areas() as unknown as [number, number, number];
      return { mask: result.mask(), ownerMm2, generatedMm2, bothMm2,
        coverage: bothMm2 / Math.max(ownerMm2, 1e-12), extra: (generatedMm2 - bothMm2) / Math.max(generatedMm2, 1e-12) };
    } finally {
      result.free();
    }
  });
}
