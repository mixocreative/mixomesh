import type { SupportProblem } from '@mixo-geocore/host/core/analysis/supportCheck';
import type { PlacementResult } from '@mixo-geocore/host/core/analysis/types';
import type { CheckJob, PlacementJob } from '@mixo-geocore/host/core/jobs';

/** One analysis job: automatic placement or a support check (the mesh arrives as a transferred copy). */
export type AnalysisTask = { kind: 'place'; job: PlacementJob } | { kind: 'check'; job: CheckJob };

export type AnalysisResult = { kind: 'placed'; result: PlacementResult } | { kind: 'checked'; problems: SupportProblem[] };
