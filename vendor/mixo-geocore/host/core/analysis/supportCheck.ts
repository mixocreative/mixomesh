import type { Vector } from '../vec3';

/*
 * Types of the support check. Overhang coverage is the Rust `check_support_problems`
 * (crates/geometry-core/src/supports/check, host adapter `host/supports/checkSupports.ts`); islands
 * come from the `generate` verdict (`editing/islandProblems.ts`).
 */

/**
 * A finding of the support check:
 *   - `overhang`: overhang area far from every contact (the Rust check, a non-gating warning);
 *   - `island`: a lowest point of the model that no built support carries to the plate (the
 *     `unresolved` entries of the `generate` island verdict);
 *   - `outside`: ONE entry for every unresolved island that lies outside the active policy's permitted
 *     area (a no-support zone or other restriction): a support there is forbidden, so it is informational, has no Fix,
 *     is not a spot that may print unsupported, and carries all its points in `points` (`position` is
 *     the first);
 *   - `omitted`: ONE entry for the automatic supports the build left out (`dropped`, minus those a
 *     no-support zone took), informational like `outside`; `points` holds their contacts (`position` is the first);
 *   - `buried`: ONE entry for the automatic contacts the OVERLAP RULE left out, because they stood on
 *     a face buried inside another mesh of the same object (engine 67). Informational like `outside`:
 *     a support there could not be printed or removed, so there is nothing to fix -- but it carries
 *     every dropped position in `points`, so the operator can look at the overlap instead of reading
 *     a number. Distinct from `omitted` on purpose: those were dropped BY THE BUILD and could come
 *     back if a setting changed; these cannot, and the reason is the model's own shape.
 *   - `unjudged`: the island verdict is `inconclusive` (the model's mesh cannot be judged, e.g.
 *     non-manifold edges); it has no place on the model, so `position` is the origin and the list
 *     offers no Show or Fix.
 */
export interface SupportProblem {
  kind: 'island' | 'overhang' | 'unjudged' | 'outside' | 'omitted' | 'buried';
  /** Centre of the spot, in the frame of the checked mesh (Y up). */
  position: Vector;
  /** Unsupported overhang area in mm² (0 for an island point). */
  area: number;
  /** `outside`, `omitted` and `buried`: every point the entry stands for (unit frame); `position` is the first. */
  points?: Vector[];
}

/**
 * Settings of the support check (`CheckJob.settings`, made by `supports/unitSupports.checkJobOf`):
 * `overhangAngleDegrees` is the placement's overhang angle in degrees (`scatterAngle`), `spacing`
 * the contact spacing in mm (`scatterSpacing`).
 */
export interface CheckSettings {
  overhangAngleDegrees: number;
  spacing: number;
}
