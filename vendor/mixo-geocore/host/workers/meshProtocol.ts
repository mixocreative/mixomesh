import type { TriangleMesh } from '../core/analysis/types';
import type { JobTransform, SupportJob } from '../core/jobs';
import type { GeneratedSupportMesh } from '../core/supports/mesh';
import type { ExportFilePlan } from '../supports/export';

export type MeshMode = SupportJob['mode'];

/**
 * A support job as it travels to the mesh worker. The model goes once per unit (identified by
 * `sourceToken`) and the worker keeps it in its source cache; later jobs omit it.
 */
export interface SupportJobPayload {
  unitId: string;
  /** The request's revision: `generate` echoes it and the host drops any result that is not the newest. */
  revision: number;
  sourceToken: number;
  /** Names the job's policy (same object, same token): the worker keeps the policy it made for it. */
  policyToken?: number;
  source?: TriangleMesh;
  job: Omit<SupportJob, 'mesh'>;
}

/** A unit in an export: its support job plus where it stands on the plate. */
export interface ExportUnitPayload extends SupportJobPayload {
  transform: JobTransform;
}

export type MeshTask =
  /** Support mesh of one unit (preview or full export resolution). */
  | { kind: 'build'; unit: SupportJobPayload }
  /** STL files of an export: full-resolution supports plus models, encoded in the worker. */
  | { kind: 'export'; units: ExportUnitPayload[]; files: ExportFilePlan[] }
  /** The unit is gone: drop its model, build session and caches. */
  | { kind: 'forget'; unitId: string };

/** What one unit's export build says about itself; the host decides from it whether the files may be written. */
export interface ExportUnitResult {
  unitId: string;
  /** The revision `generate` echoed for this unit's supports. */
  revision: number;
  verdict: 'clear' | 'blocked' | 'inconclusive';
  islands: 'ok' | 'inconclusive';
}

export interface ExportedFile {
  fileName: string;
  buffer: ArrayBuffer;
}

export type MeshTaskResult =
  | { kind: 'mesh'; mesh: GeneratedSupportMesh }
  | { kind: 'files'; files: ExportedFile[]; units: ExportUnitResult[] }
  /** The worker has no model for these units (a new worker, or evicted from its cache): send them again. */
  | { kind: 'need-source'; unitIds: string[] }
  | { kind: 'forgotten' };
