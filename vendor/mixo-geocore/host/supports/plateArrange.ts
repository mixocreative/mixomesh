import { packRules, type GenerateRules } from './generateRules';
import { supportEngine } from './supportEngine';

/*
 * Plate auto-arrange (Rust `supports::plate::arrange` through `arrange_plate`, engine 53, Round C): several cases packed on one
 * build plate by their footprints (`GeneratedSupportMesh.footprint`: the space-map raft outline, the model's shadow joined with the
 * foot discs, grown by the raft expand), at least `plateGapMm` (one global rule, default 6 mm) apart and inside the plate. Pure: the
 * same cases give the same layout. editing/arrange.ts turns a layout into scene commands.
 */

/** A footprint: closed loops, plan (x, z) mm, relative to the case's plate position; the region is the union of their insides. */
export type PlateFootprint = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

/** The build plate, from the printer profile: `widthMm` along x, `depthMm` along z, centred on the plate origin. */
export interface PlateSize {
  widthMm: number;
  depthMm: number;
}

/** One case to place. */
export interface PlateCase {
  id: string;
  footprint: PlateFootprint;
  /** Where it stands now (plan x, z, mm). */
  offset: readonly [number, number];
  /** Not moved (the other cases while one is edited). */
  frozen?: boolean;
}

/** The layout. */
export interface PlateLayout {
  /** New plan offset per case id (an unmoved case keeps its own). */
  offsets: Map<string, [number, number]>;
  /** Cases that moved. */
  moved: string[];
  /** Unfrozen cases that fit nowhere (left where they were). */
  unplaced: string[];
  /** Frozen cases that overlap an earlier frozen case or leave the plate (left as they are). */
  conflicts: string[];
}

/** The footprint flat as the engine reads it: loop count, then per loop the point count and x z per point. */
export function packFootprint(footprint: PlateFootprint): number[] {
  return [footprint.length, ...footprint.flatMap((loop) => [loop.length, ...loop.flatMap((p) => [p[0], p[1]])])];
}

/**
 * Packs `cases` on `plate`. `mode: 'keep'` (default) moves only the unfrozen cases that no longer fit where they are (the incremental
 * re-pack after an edit: freeze every other case); `'full'` re-packs every unfrozen case (a fresh layout). Moved cases go largest
 * footprint first to the first free spot from the plate's front-left corner. `rules` carries `plateGapMm`.
 */
export function arrangePlate(cases: readonly PlateCase[], plate: PlateSize, options: { mode?: 'keep' | 'full'; rules?: GenerateRules } = {}): PlateLayout {
  const out = supportEngine().arrange_plate(plate.widthMm, plate.depthMm, packRules(options.rules), Float64Array.from(cases.flatMap((c) => packFootprint(c.footprint))),
    Float64Array.from(cases.flatMap((c) => [c.offset[0], c.offset[1]])), Uint8Array.from(cases.map((c) => (c.frozen ? 1 : 0))), options.mode === 'full');
  try {
    const flat = out.offsets();
    const ids = (list: Uint32Array) => Array.from(list, (k) => cases[k]!.id);
    return {
      offsets: new Map(cases.map((c, k) => [c.id, [flat[k * 2]!, flat[k * 2 + 1]!] as [number, number]])),
      moved: ids(out.moved()), unplaced: ids(out.unplaced()), conflicts: ids(out.conflicts()),
    };
  } finally {
    out.free();
  }
}
