import type { TriangleMesh } from '../core/analysis/types';
import type { GeneratedSupportMesh } from '../core/supports/mesh';
import { encodeStl, type ExportPart } from '../supports/export';
import { runSupportJob } from '../supports/jobRunner';
import { geometryReady } from './geometryClient';
import { runAfterGeometryReady } from '../geometryVersion.js';
import type { ExportUnitPayload, ExportUnitResult, MeshTask, MeshTaskResult, SupportJobPayload } from './meshProtocol';
import { serveTask, transferable, type TaskContext } from './serveTask';
import { SourceCache } from './sourceCache';
import { BuildSessions } from './buildSessions';

/**
 * Each unit's model by source token, so a later job need not send it again. Freed by 'forget'
 * (unit removed) and capped in total bytes.
 */
const SOURCE_CACHE_BYTES = 512 * 1024 * 1024;
const sources = new SourceCache(SOURCE_CACHE_BYTES);
/** Each unit's build session (preview builds): its model, placed copy and policy stay loaded in WASM. */
const sessions = new BuildSessions();

/** Tests drive this module in-process: a terminated worker frees its WASM state, this does the same. */
export function releaseBuildSessions(): void {
  sessions.clear();
}

const PROGRESS_INTERVAL_MS = 60;

function throttled(post: TaskContext['progress'], scale = (fraction: number) => fraction) {
  let last = 0;
  return (fraction: number, stage: string) => {
    const now = performance.now();
    if (now - last < PROGRESS_INTERVAL_MS && fraction < 1) return;
    last = now;
    post({ fraction: scale(fraction), stage });
  };
}

/** The payloads' models, or the ids the worker has no current model for. */
function resolveSources(payloads: readonly SupportJobPayload[]): Map<string, TriangleMesh> | string[] {
  const missing: string[] = [];
  const found = new Map<string, TriangleMesh>();
  for (const { unitId, sourceToken, source } of payloads) {
    if (source) sources.put(unitId, sourceToken, source);
    const stored = sources.get(unitId, sourceToken);
    if (stored) found.set(unitId, stored);
    else missing.push(unitId);
  }
  for (const unitId of sources.trim(new Set(payloads.map((payload) => payload.unitId)))) sessions.forget(unitId);
  return missing.length > 0 ? missing : found;
}

function exportFiles(task: Extract<MeshTask, { kind: 'export' }>, models: Map<string, TriangleMesh>, post: TaskContext['progress']) {
  // 80 % of the time goes to the full-resolution supports, the rest to writing files.
  const supports = new Map<string, GeneratedSupportMesh>();
  const results: ExportUnitResult[] = [];
  const units = task.units.filter(({ unitId }) => task.files.some((file) => file.parts.some((part) => part.unitId === unitId && part.content === 'supports')));
  units.forEach(({ unitId, job, revision }, k) => {
    const progress = throttled(post, (fraction) => 0.8 * (k + fraction) / units.length);
    const built = runSupportJob({ ...job, mesh: models.get(unitId)! }, progress, revision);
    supports.set(unitId, built);
    results.push({ unitId, revision: built.revision ?? -1, verdict: built.verdict?.status ?? 'inconclusive', islands: built.islands?.status === 'inconclusive' ? 'inconclusive' : 'ok' });
  });
  const byId = new Map<string, ExportUnitPayload>(task.units.map((payload) => [payload.unitId, payload]));
  const files = task.files.flatMap((file, k) => {
    const parts: ExportPart[] = file.parts.map((part) => ({
      mesh: part.content === 'model' ? models.get(part.unitId)! : supports.get(part.unitId)!,
      transform: byId.get(part.unitId)!.transform,
    })).filter((part) => part.mesh.indices.length > 0);
    // Backstop to planExport: a file with no triangles is never written.
    if (parts.length === 0) return [];
    const progress = throttled(post, (fraction) => 0.8 + 0.2 * (k + fraction) / task.files.length);
    return [{ fileName: file.fileName, buffer: encodeStl(parts, progress) }];
  });
  return transferable<MeshTaskResult>({ kind: 'files', files, units: results }, files.map((file) => file.buffer));
}

serveTask<MeshTask, MeshTaskResult>((task, { progress }) => {
  if (task.kind === 'forget') {
    sources.delete(task.unitId);
    sessions.forget(task.unitId);
    return { kind: 'forgotten' };
  }
  return runAfterGeometryReady(geometryReady, () => {
    const models = resolveSources(task.kind === 'build' ? [task.unit] : task.units);
    if (Array.isArray(models)) return { kind: 'need-source', unitIds: models };
    if (task.kind === 'export') return exportFiles(task, models, progress);
    const { unitId, sourceToken, policyToken, job, revision } = task.unit;
    const model = models.get(unitId)!;
    const mesh = runSupportJob({ ...job, mesh: model }, throttled(progress), revision, sessions.site(unitId, sourceToken, model, policyToken));
    return transferable<MeshTaskResult>({ kind: 'mesh', mesh }, [mesh.positions.buffer, mesh.indices.buffer]);
  });
});
