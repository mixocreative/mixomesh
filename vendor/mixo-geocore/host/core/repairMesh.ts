import { exact, records } from './arity';

/*
 * Mesh repair on import (engine 63): the decoder for `repair_mesh` and `diagnose_mesh`. The engine
 * packs its report as flat f64 arrays (the layouts are in crates/geometry-wasm/src/repair.rs and
 * repeated here); this turns them into objects, and nothing else - no policy, no thresholds.
 *
 * Welding, collapsed triangles, the non-manifold split, the winding, and hole filling up to a rim
 * length THE CALLER passes (`maxFillLoopMm`; 0 fills nothing). There is no default for it here
 * either: the number belongs to measured rim lengths on real files, and `loopLengthsMm` per body is
 * the measurement. A loop that is not filled comes back in `fills` with the reason.
 *
 * A noise shell is marked, never dropped: whether to drop one is the caller's decision, which is
 * why `noiseShell` and the body's size are both in the report.
 *
 * Separate bodies always stay separate. If a step would have moved a face from one physical body
 * to another the engine abandons the repair instead: `ok` is false, `reason` is
 * `body-invariant:<step>`, and `positions` / `indices` are the file exactly as it came in.
 */

/** One physical body of a file: a piece a real gap (0.005 mm) keeps apart from the rest. */
export interface RepairBody {
  /** Body id, numbered in the order of the bodies' lowest face. */
  id: number;
  triangles: number;
  vertices: number;
  /** Signed volume (mm3): negative means the body is wound inside out. */
  volumeMm3: number;
  areaMm2: number;
  diagonalMm: number;
  /** Every edge on exactly two of the body's faces. */
  closed: boolean;
  boundaryLoops: number;
  boundaryEdges: number;
  /** Boundary chains that did not close on themselves. */
  openBoundaryChains: number;
  nonManifoldEdges: number;
  /** Bowtie vertices: two cones of faces meeting at one point. */
  nonManifoldVertices: number;
  windingConsistent: boolean;
  /** Volume under the engine's noise threshold. Reported only; the body is still in the mesh. */
  noiseShell: boolean;
  /** Summed edge length (mm) of each of its boundary loops, longest first. */
  loopLengthsMm: number[];
}

/** A file as a whole, body by body. */
export interface RepairReport {
  triangles: number;
  vertices: number;
  bodies: RepairBody[];
  boundaryLoops: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  nonManifoldVertices: number;
  closed: boolean;
  windingConsistent: boolean;
  /** Closed, manifold and consistently wound: what a slicer needs. */
  watertight: boolean;
  noiseShells: number;
  /** The gap the bodies were found at (mm). */
  bodyGapMm: number;
}

/** Why a boundary loop was, or was not, filled. `''` when it was. */
export type FillReason =
  | ''
  /** An outcome code this host version does not know (GEO-005): never another reason's meaning. */
  | 'unknown'
  | 'fill-too-long'
  | 'fill-non-planar'
  | 'fill-self-intersecting'
  | 'fill-too-many-edges'
  | 'fill-not-a-loop'
  | 'fill-degenerate'
  | 'fill-spans-bodies'
  | 'fill-disabled'
  /** The rim encloses no area: a crack, whose two sides sit too far apart for the weld to merge. */
  | 'fill-crack';

/** Which patch closed a loop. */
export type FillStrategy = 'none' | 'triangle' | 'ear-clip' | 'min-area' | 'unknown';

/** One boundary loop the fill step looked at, and what became of it. */
export interface LoopFill {
  /** Body the rim belongs to. */
  body: number;
  /** Summed rim length (mm): the measurement the fill limit should be chosen from. */
  lengthMm: number;
  edges: number;
  /** How far the rim bends out of its best-fit plane, over its own reach. 0 is flat. */
  flatness: number;
  filled: boolean;
  /** `''` when filled, otherwise why it was left open. */
  reason: FillReason;
  strategy: FillStrategy;
  trianglesAdded: number;
}

/** What each repair step did. All zero when the repair was abandoned. */
export interface RepairSteps {
  weldVerticesMerged: number;
  weldBoundaryLoopsBefore: number;
  weldBoundaryLoopsAfter: number;
  weldBoundaryEdgesBefore: number;
  weldBoundaryEdgesAfter: number;
  weldDistanceMm: number;
  degenerateTrianglesRemoved: number;
  nonManifoldEdgesFound: number;
  bowtieVerticesFound: number;
  verticesAdded: number;
  nonManifoldEdgesLeft: number;
  facesFlipped: number;
  bodiesMadeConsistent: number;
  bodiesTurnedOutward: number;
  bodiesLeftOpen: number;
  nonOrientableEdges: number;
  /** The fill limit as passed (mm). */
  maxFillLoopMm: number;
  loopsConsidered: number;
  loopsFilled: number;
  loopsLeftOpen: number;
  patchTrianglesAdded: number;
  noiseShells: number;
  noiseTriangles: number;
  noiseVolumeThresholdMm3: number;
}

/** A finished repair. */
export interface RepairResult {
  /** False only for `body-invariant:<step>`; the mesh then comes back untouched. */
  ok: boolean;
  reason: string;
  /** Whether any step changed anything. False means the arrays are the input's own values. */
  changed: boolean;
  positions: Float32Array;
  indices: Uint32Array;
  before: RepairReport;
  after: RepairReport;
  steps: RepairSteps;
  /** One entry per boundary loop the fill step looked at, in rim order. */
  fills: LoopFill[];
}

interface DiagnosisObject {
  take_mesh(): Float64Array;
  take_bodies(): Float64Array;
  take_loops(): Float64Array;
  free(): void;
}

interface RepairObject {
  ok(): boolean;
  reason(): string;
  changed(): boolean;
  take_positions(): Float32Array;
  take_indices(): Uint32Array;
  take_before(): Float64Array;
  take_after(): Float64Array;
  take_bodies_before(): Float64Array;
  take_bodies_after(): Float64Array;
  take_loops_before(): Float64Array;
  take_loops_after(): Float64Array;
  take_steps(): Float64Array;
  take_fills(): Float64Array;
  free(): void;
}

interface RepairEngine {
  repair_mesh(positions: Float32Array, indices: Uint32Array, maxFillLoopMm: number): RepairObject;
  diagnose_mesh(positions: Float32Array, indices: Uint32Array): DiagnosisObject;
}

/** Values per mesh roll-up. */
export const MESH_SCALARS = 12;
/** Values per body. */
export const BODY_SCALARS = 14;
/** Values per boundary loop: body id, then its length in mm. */
export const LOOP_SCALARS = 2;
/** Values in the step array. */
export const STEP_SCALARS = 24;
/** Values per boundary loop in the fill array. */
export const FILL_SCALARS = 7;

const reasons: FillReason[] = [
  '',
  'fill-too-long',
  'fill-non-planar',
  'fill-self-intersecting',
  'fill-too-many-edges',
  'fill-not-a-loop',
  'fill-degenerate',
  'fill-spans-bodies',
  'fill-disabled',
  'fill-crack',
];

const strategies: FillStrategy[] = ['none', 'triangle', 'ear-clip', 'min-area'];

const empty: RepairReport = {
  triangles: 0,
  vertices: 0,
  bodies: [],
  boundaryLoops: 0,
  boundaryEdges: 0,
  nonManifoldEdges: 0,
  nonManifoldVertices: 0,
  closed: false,
  windingConsistent: false,
  watertight: false,
  noiseShells: 0,
  bodyGapMm: 0,
};

function decodeReport(mesh: Float64Array, bodyValues: Float64Array, loopValues: Float64Array): RepairReport {
  // An EMPTY roll-up is the engine's `blank()`: the side of an abandoned repair that was never
  // measured (repair.rs). `watertight` is then false, which fails closed. Any OTHER length is drift
  // or truncation, and the all-zero report it used to produce reads as a measured clean mesh.
  if (mesh.length === 0) return { ...empty, bodies: [] };
  exact(mesh, MESH_SCALARS, 'repair mesh roll-up');
  const bodies: RepairBody[] = [];
  const bodyCount = records(bodyValues, BODY_SCALARS, 'repair body array');
  for (let b = 0; b < bodyCount; b++) {
    const at = b * BODY_SCALARS;
    const v = bodyValues.subarray(at, at + BODY_SCALARS);
    bodies.push({
      id: v[0],
      triangles: v[1],
      vertices: v[2],
      volumeMm3: v[3],
      areaMm2: v[4],
      diagonalMm: v[5],
      closed: v[6] === 1,
      boundaryLoops: v[7],
      boundaryEdges: v[8],
      openBoundaryChains: v[9],
      nonManifoldEdges: v[10],
      nonManifoldVertices: v[11],
      windingConsistent: v[12] === 1,
      noiseShell: v[13] === 1,
      loopLengthsMm: [],
    });
  }
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const loopCount = records(loopValues, LOOP_SCALARS, 'repair boundary-loop array');
  for (let l = 0; l < loopCount; l++) {
    const at = l * LOOP_SCALARS;
    byId.get(loopValues[at])?.loopLengthsMm.push(loopValues[at + 1]);
  }
  return {
    triangles: mesh[0],
    vertices: mesh[1],
    bodies,
    boundaryLoops: mesh[3],
    boundaryEdges: mesh[4],
    nonManifoldEdges: mesh[5],
    nonManifoldVertices: mesh[6],
    closed: mesh[7] === 1,
    windingConsistent: mesh[8] === 1,
    watertight: mesh[9] === 1,
    noiseShells: mesh[10],
    bodyGapMm: mesh[11],
  };
}

function decodeSteps(values: Float64Array): RepairSteps {
  // The step array is ALWAYS `STEP_SCALARS` long, all zero when the repair was abandoned
  // (repair.rs), so a short one is never a legal state - and it used to decode as a healthy run
  // that filled nothing. This is the `loopsLeftOpen: 0` case GEO-006 exists to pin.
  exact(values, STEP_SCALARS, 'repair step array');
  const at = (k: number) => values[k]!;
  return {
    weldVerticesMerged: at(0),
    weldBoundaryLoopsBefore: at(1),
    weldBoundaryLoopsAfter: at(2),
    weldBoundaryEdgesBefore: at(3),
    weldBoundaryEdgesAfter: at(4),
    weldDistanceMm: at(5),
    degenerateTrianglesRemoved: at(6),
    nonManifoldEdgesFound: at(7),
    bowtieVerticesFound: at(8),
    verticesAdded: at(9),
    nonManifoldEdgesLeft: at(10),
    facesFlipped: at(11),
    bodiesMadeConsistent: at(12),
    bodiesTurnedOutward: at(13),
    bodiesLeftOpen: at(14),
    nonOrientableEdges: at(15),
    maxFillLoopMm: at(16),
    loopsConsidered: at(17),
    loopsFilled: at(18),
    loopsLeftOpen: at(19),
    patchTrianglesAdded: at(20),
    noiseShells: at(21),
    noiseTriangles: at(22),
    noiseVolumeThresholdMm3: at(23),
  };
}

function decodeFills(values: Float64Array): LoopFill[] {
  const out: LoopFill[] = [];
  // Empty is legal (the engine reports no fills when the repair was abandoned); a remainder is not.
  const count = records(values, FILL_SCALARS, 'repair fill array');
  for (let k = 0; k < count; k++) {
    const at = k * FILL_SCALARS;
    const v = values.subarray(at, at + FILL_SCALARS);
    out.push({
      body: v[0],
      lengthMm: v[1],
      edges: v[2],
      flatness: v[3],
      filled: v[4] === 0,
      // GEO-005: `fill-degenerate` said "the rim had no area" about a hole left open for a reason
      // this version cannot read, and `none` said "nothing closed it" while `filled` may be true.
      reason: reasons[v[4]] ?? 'unknown',
      strategy: strategies[v[5]] ?? 'unknown',
      trianglesAdded: v[6],
    });
  }
  return out;
}

/**
 * What a file is, with nothing changed: the per-body report that replaces the one `mesh_ok` bit.
 * Throws the engine's coded errors (INVALID_LENGTH, NON_FINITE, INVALID_INDEX).
 */
export function diagnoseMesh(engine: RepairEngine, positions: Float32Array, indices: Uint32Array): RepairReport {
  const result = engine.diagnose_mesh(positions, indices);
  try {
    return decodeReport(result.take_mesh(), result.take_bodies(), result.take_loops());
  } finally {
    result.free();
  }
}

/**
 * Repairs a file on import: weld, collapsed triangles, non-manifold split, winding, hole filling up
 * to `maxFillLoopMm`, noise shells. Pass 0 to fill nothing - there is no default, because the limit
 * belongs to measured rim lengths. Throws the engine's coded errors for arrays that are not a mesh.
 * A `body-invariant:<step>` result is not a throw - check `ok`.
 */
export function repairMesh(
  engine: RepairEngine,
  positions: Float32Array,
  indices: Uint32Array,
  maxFillLoopMm: number,
): RepairResult {
  const result = engine.repair_mesh(positions, indices, maxFillLoopMm);
  try {
    return {
      ok: result.ok(),
      reason: result.reason(),
      changed: result.changed(),
      positions: result.take_positions(),
      indices: result.take_indices(),
      before: decodeReport(result.take_before(), result.take_bodies_before(), result.take_loops_before()),
      after: decodeReport(result.take_after(), result.take_bodies_after(), result.take_loops_after()),
      steps: decodeSteps(result.take_steps()),
      fills: decodeFills(result.take_fills()),
    };
  } finally {
    result.free();
  }
}
