export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Region {
  id: number;
  faceIndices: number[];
}

export type SupportPointSource = 'interior' | 'physical-boundary' | 'sharp-ridge' | 'island';

export interface SupportPoint {
  id: string;
  regionId: number;
  position: [number, number, number];
  normal: [number, number, number];
  source: SupportPointSource;
}

export interface PlacementSettings {
  overhangAngleDegrees: number;
  spacing: number;
  edgeInset: number;
  sharpEdgeAngleDegrees: number;
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
