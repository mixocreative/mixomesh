import type { PlacementResult } from '../core/analysis/types';

/*
 * The overlap rule applied to a generic placement: a contact standing on a face that is buried
 * inside (or against) another part of the same object is dropped, so a body-and-arm model gets no
 * support where the two meshes overlap.
 *
 * Pure on purpose. The engine answers WHICH contacts are buried (`contactsBuried`, engine 66); this
 * module only has to drop them from a `PlacementResult` without letting its four parallel views
 * drift apart, which is the one mistake available here: `contactPositions` / `contactNormals` are
 * `points` again as flat arrays, and a filter that forgets them leaves the viewport drawing tips
 * the job no longer has.
 */

/**
 * `result` without the contacts `buried` marks (true = buried). Ids are untouched, so every saved
 * `deleted`, `overrides` and manual entry still matches: dropping is the whole reason this is done
 * after placement instead of by placing differently.
 *
 * The count goes out as `buried`, so the app can say why the overlap has no supports instead of
 * leaving the operator to guess.
 *
 * `regions` is kept whole: a region is a set of FACE indices, not of contacts, and a region that
 * loses its last contact is still the overhang region it was.
 *
 * shortcut: `suggested` is passed through untouched, so Add can still snap to a buried face. It is
 * a separate list with no mask of its own (the dental path is the only producer today); mask it when
 * a generic path starts filling it.
 */
export function dropBuried(result: PlacementResult, buried: readonly boolean[]): PlacementResult {
  if (!buried.some(Boolean)) return result;
  const points = result.points.filter((_, k) => !buried[k]);
  return {
    ...result,
    points,
    buried: result.points.length - points.length,
    contactPositions: new Float32Array(points.flatMap((point) => point.position)),
    contactNormals: new Float32Array(points.flatMap((point) => point.normal)),
  };
}
