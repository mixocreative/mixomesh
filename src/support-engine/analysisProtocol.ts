import type { SupportProblem } from '@mixo-geocore/host/core/analysis/supportCheck';
import type { PlacementResult, TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import type { CheckJob, PlacementJob } from '@mixo-geocore/host/core/jobs';

/**
 * Which contacts of one object stand inside ANOTHER object (C2).
 *
 * In the worker, not on the main thread, and that is the whole reason this task exists: the check is
 * a parts split plus a ray index over the two meshes combined, and run on the UI thread during a
 * build it blocked long enough to swallow a right-click — `browser-supports-walk` caught it, as
 * "e right-click on a support removes it -- removed 0 -> 0", with no page error to explain it.
 *
 * `others` are already shifted into `mesh`'s frame by the caller, which is the pure half
 * (`src/supports/crossObject.ts`) and is unit-tested there.
 */
export interface InsideOthersJob {
  mesh: TriangleMesh;
  contacts: { position: [number, number, number] }[];
  others: { name: string; mesh: TriangleMesh; offset: [number, number, number] }[];
}

/** One analysis job: automatic placement, a support check, or the cross-object overlap test. */
export type AnalysisTask =
  | { kind: 'place'; job: PlacementJob }
  | { kind: 'check'; job: CheckJob }
  | { kind: 'inside-others'; job: InsideOthersJob };

export type AnalysisResult =
  | { kind: 'placed'; result: PlacementResult }
  | { kind: 'checked'; problems: SupportProblem[] }
  | { kind: 'inside-others'; positions: [number, number, number][]; names: string[] };
