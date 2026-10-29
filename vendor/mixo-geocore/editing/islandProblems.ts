import type { SupportProblem } from '../host/core/analysis/supportCheck';
import type { IslandReport } from '../host/core/supports/mesh';

/**
 * The island part of the support check, from the `generate` island verdict (Rust, built-path
 * graph; SHIP-PLAN D1 replaced the old distance heuristic with it):
 *   - `unresolved` islands are listed at their lowest vertex of `positions` (the unit's mesh, the one
 *     `generate` was given; the vertex index is into it);
 *   - `outside-policy` ones (unresolved, but off the policy's permitted area, where a support is
 *     forbidden) collapse into ONE `outside` entry (Show frames the first; the markers draw them all), informational: no Fix, not counted as a spot;
 *   - `resolved` ones, and ones resolved only through a manual support, are not problems;
 *   - an `inconclusive` verdict is one `unjudged` entry: no island is called resolved, and the list says so;
 *   - no verdict (the build is not current) lists nothing; the re-check that follows the build asks again.
 */
export function islandProblems(report: IslandReport | undefined, positions: Float32Array): SupportProblem[] {
  if (!report) return [];
  if (report.status === 'inconclusive') return [{ kind: 'unjudged', position: [0, 0, 0], area: 0 }];
  const listed: SupportProblem[] = [];
  const outside: NonNullable<SupportProblem['points']> = [];
  for (const island of report.islands) {
    if (island.status !== 'unresolved' && island.status !== 'outside-policy') continue;
    const o = island.vertex * 3;
    if (o + 2 >= positions.length) continue;
    const point: SupportProblem['position'] = [positions[o]!, positions[o + 1]!, positions[o + 2]!];
    if (island.status === 'unresolved') listed.push({ kind: 'island', position: point, area: 0 });
    else outside.push(point);
  }
  if (outside.length > 0) {
    listed.push({ kind: 'outside', position: outside[0]!, area: 0, points: outside });
  }
  return listed;
}
