/**
 * Live support generation (plan P3.5; port of mixoDental `useRegenerate` / `runCheck`).
 *
 * One `JobScheduler` runs a job per object: debounced, latest request only, worker respawned past
 * 20 s (D15). A job is
 *   1. placement (analysis worker, only when the placement settings / geometry changed or Generate
 *      asked for one) landed as `RegenerateRekeyCommand` (hand work follows the new contacts; one undo
 *      step), or, after a project load, silently as the placement cache;
 *   2. the support mesh (mesh worker, from the record: settings, manual, removed, zones, overrides);
 *   3. the layers draw it and the support check (overhangs in the analysis worker, islands, left-out
 *      supports from the build) fills the problem list.
 * Every step is dropped when a newer request was made meanwhile (`job.current()`).
 *
 * The record is the only input: a settings change, an Add / Remove / zone stroke and an Undo are all
 * a `SUPPORTS_CHANGED`, so they take the same path.
 */
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { SupportMeshClient } from '@mixo-geocore/host/workers/meshClient';
import { REPLACED, WorkerTask, type WorkerLike } from '@mixo-geocore/host/workers/WorkerTask';
import { jobContacts } from '@mixo-geocore/host/supports/genericPolicy';
import { problemInZone } from '@mixo-geocore/host/supports/zoneCheck';
import { toPlacementSettings, type LiveSupportSettings } from '@mixo-geocore/host/core/supports/settings';
import type { ContactInputs } from '@mixo-geocore/host/core/jobs';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import type { SupportProblem } from '@mixo-geocore/host/core/analysis/supportCheck';
import { islandProblems } from '@mixo-geocore/editing/islandProblems';
import { omittedProblems } from '@mixo-geocore/editing/omittedProblem';
import { landedStatus } from '@mixo-geocore/editing/regenerate';
import workerUrl from '../../support-engine/meshWorker.entry.ts?worker&url';
import analysisUrl from '../../support-engine/analysisWorker.entry.js?worker&url';
import { geometryGlueUrl, meshWorkerUrl } from '../../support-engine/loadGeometry.js';
import type { AnalysisResult, AnalysisTask } from '../../support-engine/analysisProtocol';
import { getState, subscribe } from '../../core/StateManager.js';
import { EVENTS } from '../../core/events.js';
import { t } from '../../i18n/index.js';
import { supportUi, type PanelProblem } from '../../panels/supports/supportUi';
import { supportMode } from '../SupportMode';
import { emptySupports, isBuilt, readStamps, type ObjectSupports } from '../model';
import { readSupports, supportsOwner } from '../store';
import { cachePlacement, cacheSupportMesh, cachedPlacement } from '../supportCache';
import { objectModelStaged, type ObjectModel } from '../objectModel';
import { createSceneSource } from '../sceneSource';
import { scenePose } from '../sceneSource';
import { appSupportLayers } from '../layers/index';
import { commitSupportEdits, LiftForSupportsCommand, RegenerateRekeyCommand } from '../commands';
import { JobScheduler, type JobRequest } from './jobScheduler';
import { statusText } from './statusText';
import { buildJob, needsPlacement, placementChanged } from './jobInputs';
import { notify } from './notices';
import { fixSpotChecked } from './fixSpot';

/* eslint-disable @typescript-eslint/no-explicit-any -- worker globals */

const ORIGIN = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };

export interface LiveStats {
  /** Jobs the scheduler started. */
  started: number;
  /** Mesh results drawn. */
  rendered: number;
  /** Mesh results dropped as stale. */
  dropped: number;
  placements: number;
  respawns: number;
  /** Longest synchronous main-thread step per name, ms. */
  steps: Record<string, number>;
  last: { objectId: string; revision: number; tips: number; verdict: string; ms: { placement: number; build: number; check: number }; settings: LiveSupportSettings } | undefined;
}

export const liveStats: LiveStats = { started: 0, rendered: 0, dropped: 0, placements: 0, respawns: 0, last: undefined, steps: {} };

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * One synchronous main-thread step of a job, run in a task of its own (a yield before it) and timed:
 * the longest of each name is kept in `liveStats.steps` so a slow step is named, not guessed (D14:
 * the UI never blocks on generation).
 */
async function step<T>(name: string, work: () => T): Promise<T> {
  await yieldToMain();
  const t0 = performance.now();
  try {
    return work();
  } finally {
    const ms = Math.round(performance.now() - t0);
    if (ms > (liveStats.steps[name] ?? 0)) liveStats.steps[name] = ms;
  }
}

// ── workers ──

const sceneSource = createSceneSource();
let meshClient: SupportMeshClient | undefined;
let analysisTask: WorkerTask<AnalysisTask, AnalysisResult> | undefined;
const analysisAborts = new Map<string, AbortController>();
let engineReady: Promise<unknown> | undefined;

function ensureEngine(): Promise<unknown> {
  if (!engineReady) {
    configureGeometry(geometryGlueUrl(document.baseURI));
    engineReady = geometryReady();
  }
  return engineReady;
}

function mesher(): SupportMeshClient {
  meshClient ??= new SupportMeshClient({
    create: typeof Worker === 'undefined' ? null
      : () => new Worker(meshWorkerUrl(new URL(workerUrl, document.baseURI), document.baseURI), { type: 'module' }) as unknown as WorkerLike,
    onProgress: ({ fraction, stage }) => {
      if (supportUi.get().job.running) supportUi.set({ job: { running: true, progress: fraction, stageKey: stage } });
    },
  });
  return meshClient;
}

function analyser(): WorkerTask<AnalysisTask, AnalysisResult> {
  analysisTask ??= new WorkerTask<AnalysisTask, AnalysisResult>({
    name: 'Support analysis',
    timeoutMs: 10 * 60_000,
    create: typeof Worker === 'undefined' ? null
      : () => new Worker(meshWorkerUrl(new URL(analysisUrl, document.baseURI), document.baseURI), { type: 'module' }) as unknown as WorkerLike,
  });
  return analysisTask;
}

function copyOf(mesh: TriangleMesh): TriangleMesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

/** Run an analysis task; resolves undefined when replaced / cancelled. */
async function analyse(id: string, task: AnalysisTask): Promise<AnalysisResult | undefined> {
  analysisAborts.get(id)?.abort(REPLACED);
  const controller = new AbortController();
  analysisAborts.set(id, controller);
  const mesh = task.job.mesh as TriangleMesh;
  const own = copyOf(mesh);
  const payload = { ...task, job: { ...task.job, mesh: own } } as AnalysisTask;
  try {
    return await analyser().run(payload, {
      transfer: [own.positions.buffer, own.indices.buffer],
      signal: controller.signal,
      label: { key: 'Support analysis' },
      context: task.kind === 'place' ? 'place' : 'check',
    } as any);
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    throw error;
  } finally {
    if (analysisAborts.get(id) === controller) analysisAborts.delete(id);
  }
}

// ── pure helpers (jobInputs.ts) ──

function contactInputs(id: string, record: ObjectSupports): ContactInputs {
  return { points: cachedPlacement(id) ?? [], manual: record.manual, deleted: record.deleted, zones: readStamps(record.stamps), contactSettings: record.overrides };
}

// ── state shared with the panels ──

const problemsByObject = new Map<string, PanelProblem[]>();
const verdicts = new Map<string, { status: 'clear' | 'blocked' | 'inconclusive'; dropped: number; islands: number }>();

function publishProblems(): void {
  const ids = supportMode.getObjectIds();
  supportUi.set({
    problems: ids.flatMap((id) => problemsByObject.get(id) ?? []),
    verdicts: Object.fromEntries(verdicts),
  });
}

function anyBusy(): boolean {
  return supportMode.getObjectIds().some((id) => scheduler.isBusy(id));
}

function syncBusy(): void {
  const running = anyBusy();
  const job = supportUi.get().job;
  supportUi.set({ job: running ? { running: true, ...(job.running ? job : {}) } : { running: false }, problemsStale: running });
}

// ── the job ──

let selfWrites = 0;

async function runJob(id: string, job: JobRequest): Promise<void> {
  liveStats.started++;
  const om = await objectModelStaged(id, yieldToMain);
  if (!om) return;
  await ensureEngine();
  const layers = await appSupportLayers();
  let record = readSupports(id) ?? emptySupports();
  const hash = await sceneSource.sourceHashStaged(id, yieldToMain);
  const pose = scenePose(id);
  const ms = { placement: 0, build: 0, check: 0 };

  if (job.placement || needsPlacement(record, hash, !!cachedPlacement(id))) {
    const t0 = performance.now();
    const placed = await analyse(id, { kind: 'place', job: { mesh: om.model.local, orientation: ORIGIN, settings: toPlacementSettings(record.settings) } });
    ms.placement = Math.round(performance.now() - t0);
    if (!placed || placed.kind !== 'placed' || !job.current()) { liveStats.dropped++; return; }
    liveStats.placements++;
    const restoring = !job.placement && !record.stale && isBuilt(record) && record.sourceHash === hash && !placementChanged(record);
    if (restoring) {
      // A loaded project: the placement is derived data, rebuilt without a history step.
      cachePlacement(id, placed.result.points);
    } else if (pose) {
      const command = new RegenerateRekeyCommand(id, { points: placed.result.points, sourceHash: hash ?? '', pose });
      selfWrites++;
      try { commitSupportEdits([command]); } finally { selfWrites--; }
      const report = command.report;
      if (report) {
        const name = (getState().scene.objects[id]?.name as string | undefined) ?? id;
        notify({ message: statusText(landedStatus([{ name, placed: placed.result.points.length, report }]), t) });
      }
    }
    record = readSupports(id) ?? record;
  }

  const inputs = contactInputs(id, record);
  const tb = performance.now();
  const built = await mesher().build(id, buildJob(om.model, record, inputs), { key: 'Support building' });
  ms.build = Math.round(performance.now() - tb);
  if (!built || !job.current()) { liveStats.dropped++; return; }

  // Draw. Revision of the record the mesh was built from.
  cacheSupportMesh(id, record.revision, built);
  layers.setPreviewMode(record.settings.previewMode);
  await step('drawSupports', () => layers.setSupports(id, built, om.anchor, { stale: !!record.stale }));
  const stamps = readStamps(record.stamps);
  if (stamps.length > 0) layers.setZones(id, om.model.local as any, om.anchor, om.version, stamps);
  else layers.removeZones(id);
  liveStats.rendered++;
  const tips = new Set(built.components.flatMap((c) => (c.contactId ? [c.contactId] : []))).size;
  liveStats.last = { objectId: id, revision: record.revision, tips, verdict: built.verdict?.status ?? 'none', ms, settings: record.settings };
  verdicts.set(id, { status: built.verdict?.status ?? 'clear', dropped: built.dropped.length, islands: built.islands?.status === 'ok' ? built.islands.islands.filter((i) => i.status === 'unresolved').length : 0 });
  if (built.dentalStructureFallback?.includes('brace-pruned')) notify({ message: t('supportLive.bracePruned') });

  // The check that fills the list; the verdict and the build are already on screen.
  const tc = performance.now();
  const problems = await checkProblems(id, om, record, inputs, built);
  ms.check = Math.round(performance.now() - tc);
  if (!job.current() || !problems) return;
  problemsByObject.set(id, problems);
  publishProblems();
  fixSpotChecked(id, problems);
}

async function checkProblems(id: string, om: ObjectModel, record: ObjectSupports, inputs: ContactInputs, built: GeneratedSupportMesh): Promise<PanelProblem[] | undefined> {
  const all = jobContacts(inputs);
  const dropped = new Set(built.dropped);
  const live = all.filter((c) => !dropped.has(c.id));
  const checked = await analyse(`${id}|check`, {
    kind: 'check',
    job: { mesh: om.model.local, orientation: ORIGIN, contacts: live.map((c) => [...c.position] as [number, number, number]), settings: { overhangAngleDegrees: record.settings.scatterAngle, spacing: record.settings.scatterSpacing } },
  });
  if (!checked || checked.kind !== 'checked') return undefined;
  const zones = readStamps(record.stamps);
  const found: SupportProblem[] = [
    ...checked.problems,
    ...islandProblems(built.islands, om.model.local.positions),
    ...omittedProblems(all, built),
  ];
  return found.map((p) => ({ ...p, unitId: id, inZone: p.kind === 'island' || p.kind === 'overhang' ? problemInZone(zones, p.position, [0, -1, 0]) : false }));
}

// ── scheduler ──

const scheduler = new JobScheduler({
  run: (id, job) => runJob(id, job).catch((error) => {
    console.error('support job failed', error);
    notify({ message: t('supportLive.failed', { message: String((error as Error)?.message ?? error) }) });
  }),
  respawn: (id) => {
    liveStats.respawns++;
    mesher().cancel(id);
    analysisAborts.get(id)?.abort(REPLACED);
    analysisAborts.get(`${id}|check`)?.abort(REPLACED);
  },
  onBusy: () => syncBusy(),
});

/** Ask for a job; `placement` forces a new automatic placement. */
export function requestJob(id: string, placement = false, immediate = false): void {
  scheduler.request(supportsOwner(id), { placement }, { immediate });
}

export function cancelJob(id: string): void {
  scheduler.cancel(id);
  verdicts.delete(id);
}

export function isJobBusy(id: string): boolean {
  return scheduler.isBusy(id);
}

// ── lift ──

/** Lift the object so its supports stand on the bed; one undo step (no step when it already stands there). */
export function liftObject(id: string, liftMm?: number): boolean {
  const record = readSupports(id) ?? emptySupports();
  const lift = new LiftForSupportsCommand(id, liftMm ?? record.settings.liftHeight);
  if (!lift.moves) return false;
  commitSupportEdits([lift]);
  return true;
}

// ── wiring ──

function generate(ids: readonly string[]): void {
  for (const raw of ids) {
    const id = supportsOwner(raw);
    liftObject(id);
    requestJob(id, true, true);
  }
}

function onSupportsChanged(detail: { objectId?: string } | undefined): void {
  if (!supportMode.isActive() || !detail?.objectId) return;
  const id = supportsOwner(detail.objectId);
  if (!supportMode.getObjectIds().includes(id)) return;
  void appSupportLayers().then((layers) => {
    const record = readSupports(id);
    if (!record || !isBuilt(record)) {
      layers.removeSupports(id);
      layers.removeZones(id);
      problemsByObject.delete(id);
      verdicts.delete(id);
      cachePlacement(id, record ? cachedPlacement(id) : undefined);
      publishProblems();
      return;
    }
    layers.setStale(id, !!record.stale);
  });
  if (selfWrites > 0) return;
  const record = readSupports(id);
  if (!record || !isBuilt(record) || record.stale) return;
  requestJob(id);
}

function onModeChanged(info: { active: boolean; objectIds: readonly string[] }): void {
  if (!info.active) {
    for (const id of [...problemsByObject.keys(), ...verdicts.keys()]) scheduler.cancel(id);
    problemsByObject.clear();
    verdicts.clear();
    supportUi.set({ job: { running: false }, problems: [], problemsStale: false, verdicts: {} });
    return;
  }
  for (const id of info.objectIds) {
    const record = readSupports(id);
    if (!record || !isBuilt(record)) continue;
    // Stale supports regenerate on mode entry with the hand work rekeyed; a loaded project redraws.
    requestJob(id, !!record.stale, true);
  }
}

let installed = false;

export function installLiveGeneration(): void {
  if (installed) return;
  installed = true;
  supportUi.register({ generate, cancelJob });
  subscribe(EVENTS.SUPPORTS_CHANGED, onSupportsChanged);
  supportMode.onChange(onModeChanged);
  if (supportMode.isActive()) onModeChanged({ active: true, objectIds: supportMode.getObjectIds() });
  (window as any).__mxSupportLive = { stats: liveStats, request: requestJob, cancel: cancelJob, busy: isJobBusy, lift: liftObject };
}
