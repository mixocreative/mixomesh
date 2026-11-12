import type { SupportProblem } from '../host/core/analysis/supportCheck';
import type { Vector } from '../host/core/vec3';

/**
 * The "contacts inside another mesh" entry of the check, from a placement's `buried` positions: the
 * automatic contacts the OVERLAP RULE left out because they stood on a face buried inside another
 * mesh of the same object (engine 67).
 *
 * Beside `omittedProblems` and deliberately not folded into it. `omitted` means the BUILD dropped a
 * support, which a different setting might bring back; this means the model's own shape puts the
 * surface out of reach, which no setting changes. Telling an operator they are the same thing would
 * send them hunting through settings for a cause that is not there.
 *
 * Informational: no Fix, and never counted as a spot that may print unsupported. `points` carries
 * every dropped position so the list can frame them.
 *
 * `positions` are in the frame the placement reported them in; the caller maps them to the unit
 * frame, as it does for every other finding.
 */
export function buriedProblems(positions: readonly Vector[] | undefined): SupportProblem[] {
  if (!positions || positions.length === 0) return [];
  return [{ kind: 'buried', position: positions[0]!, area: 0, points: [...positions] }];
}
