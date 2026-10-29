/**
 * An indexed triangle mesh: `positions` is flat xyz f32 (mm, 3 per vertex), `indices` is flat
 * vertex-index triples (3 per triangle). Frame depends on the caller: unit-local for a unit's
 * source, plate space (Y up, plate at y = 0) after `applyTransform`.
 */
export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** A downward region of placement: an id and the indices of the faces it covers. */
export interface Region {
  id: number;
  faceIndices: number[];
}

/**
 * Why placement put a point there: inside a downward region, on its physical boundary, along a
 * sharp ridge, or at the lowest point of an island. Order matches the Rust source codes 0..3.
 */
export type SupportPointSource = 'interior' | 'physical-boundary' | 'sharp-ridge' | 'island';

/**
 * One automatic or manual contact tip. `id` is the stable contact id (`auto-X_Y_Z` for automatic
 * ones, see `supports/contactEdits`); `regionId` is -1 when the point belongs to no region;
 * `position` (mm) and unit `normal` (pointing out of the model) are in the frame of the mesh the
 * point was placed on.
 */
export interface SupportPoint {
  id: string;
  regionId: number;
  position: [number, number, number];
  normal: [number, number, number];
  source: SupportPointSource;
}

/**
 * Inputs of the automatic placement (Rust `generic_place`, packed by
 * `supports/genericPlacement.packPlacementSettings`). Angles in degrees, lengths in mm.
 */
export interface PlacementSettings {
  /** Overhang angle threshold in degrees (`scatterAngle`). */
  overhangAngleDegrees: number;
  /** Target distance between contacts (mm). */
  spacing: number;
  /** How far contacts on a region's edge are moved inwards (mm). */
  edgeInset: number;
  /** Dihedral turn (degrees) above which an edge counts as a sharp ridge. */
  sharpEdgeAngleDegrees: number;
  /** Add a contact at the lowest point of each island. */
  includeIslands: boolean;
  /** Blender "Downward Faces"; defaults to true. */
  includeDownward?: boolean;
  /** Blender "Reinforce Overhang Edges"; defaults to true. */
  reinforceEdges?: boolean;
  /**
   * Max bevel width W (mm, engine 10): a ridge rounded over many facets is reinforced when its turn
   * beyond the ridge angle is completed within this surface distance. Defaults to 2.5.
   */
  maxBevelWidth?: number;
}

/**
 * What a placement returns. `contactPositions` / `contactNormals` are the `points` again as flat
 * xyz f32 arrays (3 per point, same order), ready for a renderer or a transfer.
 */
export interface PlacementResult {
  points: SupportPoint[];
  regions: Region[];
  contactPositions: Float32Array;
  contactNormals: Float32Array;
  /** Every suggested tip, painted or not (where Add may snap), in the placement's frame. Never stored in a unit. */
  suggested?: SupportPoint[];
}

/** Reports how far a long job has come: `fraction` in [0, 1] and a short stage name. */
/** `stage` is a progress code (core/progress.ts), never display text. */
export type ProgressCallback = (fraction: number, stage: string) => void;

/** What a fresh placement made of a unit's hand work, with the counts the Regenerate report gives. */
export interface RekeyedHandWork<T> {
  /** The removals re-keyed; one no new contact matches is dropped (and counted in `removals.reset`). */
  deleted: string[];
  /** Per-support settings under the id of the support they now belong to; manual supports keep theirs. */
  overrides: Record<string, T>;
  removals: { kept: number; reset: number };
  customised: { kept: number; reset: number };
}
