/**
 * The operator's area controls of a two-contour area. Defaults and limits are aligner-profile data
 * (`src/dental/tuning.ts`); Rust validates the numbers again against the profile it is given.
 * `positionMm` is the signed distance (mm, along the surface) of the area's middle line from the
 * detected edge: positive onto the outer side, negative across the edge (Rust `Tuning::band`).
 */
export interface DentalTuning {
  positionMm: number;
  stripWidthMm: number;
  density: number;
}
