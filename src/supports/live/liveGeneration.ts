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
import { supportUi, type PanelProblem, type VerdictInfo } from '../../panels/supports/supportUi';
import { supportMode } from '../SupportMode';
import { emptySupports, isBuilt, readStamps, samePose, type ObjectSupports } from '../model';
import { readSupports, supportsOwner } from '../store';
import { cachePlacement, cacheSupportFigures, cacheSupportMesh, cachedPlacement, cachedSupportFigures, dropSupportMesh } from '../supportCache';
import { setSupportFiguresRequester } from '../../core/scene/SupportMeshSource.js';
import { signedVolume } from '../../core/print/PrintSpace.js';
import { forgetObjectModel, leadPosition, objectModelStaged, type ObjectModel } from '../objectModel';
import { positionsFromEngine, type Vec3 } from '../frame';
import { anchorOffset, supportToBabylon } from '../BabylonViewportPort';
import { withRestTransform } from '../../core/scene/ImportBounce.js';
import { createSceneSource } from '../sceneSource';
import { scenePose } from '../sceneSource';
import { appSupportLayers } from '../layers/index';
import { commitSupportEdits, LiftForSupportsCommand, RegenerateRekeyCommand } from '../commands';
import { JobScheduler, type JobRequest } from './jobScheduler';
import { statusText } from './statusText';
import { buildJob, needsPlacement, placementChanged, scaledJobInputs } from './jobInputs';
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
  /**
   * `points` is what PLACEMENT produced and `dropped` what the safety repair then left out, so a
   * test can assert `tips + dropped === points` instead of pinning an absolute tip count that the
   * repair budget legitimately changes. `points` counts the AUTOMATIC points only, which is what
   * geocore's golden `placement.points` is; with hand edits in play the identity does not hold and
   * no test should assert it.
   */
  last: { objectId: string; revision: number; points: number; tips: number; dropped: number; verdict: string; ms: { placement: number; build: number; check: number }; settings: LiveSupportSettings } | undefined;
}

export const liveStats: LiveStats = { started: 0, rendered: 0, dropped: 0, placements: 0, respawns: 0, last: undefined, steps: {} };

/**
 * Test hook (inert unless a test sets `slowMs`): holds every job for that long before it starts, ended
 * early when its worker is respawned, so the 20 s respawn can be exercised without a 20 s model.
 */
export const testHooks = { slowMs: 0 };
const respawnWaiters = new Map<string, () => void>();
function slowJob(id: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); respawnWaiters.delete(id); resolve(); };
    const timer = setTimeout(done, testHooks.slowMs);
    respawnWaiters.set(id, done);
  });
}

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
const verdicts = new Map<string, VerdictInfo>();

const objectName = (id: string): string => String((getState().scene.objects[id] as { name?: unknown } | undefined)?.name ?? '');

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
  if (testHooks.slowMs > 0) { await slowJob(id); if (!job.current()) { liveStats.dropped++; return; } }
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
  const built = await mesher().build(id, buildJob(om.model, record, inputs, objectName(id)), { key: 'Support building' });
  ms.build = Math.round(performance.now() - tb);
  if (!job.current()) { liveStats.dropped++; return; }
  if (!built) {
    // The engine built nothing (every support is removed): none stays drawn, the old verdict goes,
    // and the check still lists what the model leaves uncovered.
    layers.removeSupports(id);
    dropSupportMesh(id);
    verdicts.delete(id);
    const bare = await checkProblems(id, om, record, inputs, undefined);
    if (!job.current() || !bare) return;
    problemsByObject.set(id, bare);
    publishProblems();
    return;
  }

  // Draw. Revision of the record the mesh was built from.
  cacheSupportMesh(id, record.revision, built);
  layers.setPreviewMode(record.settings.previewMode);
  await step('drawSupports', () => layers.setSupports(id, built, om.anchor, { stale: !!record.stale }));
  const stamps = readStamps(record.stamps);
  if (stamps.length > 0) layers.setZones(id, om.model.local as any, om.anchor, om.version, stamps);
  else layers.removeZones(id);
  liveStats.rendered++;
  const tips = new Set(built.components.flatMap((c) => (c.contactId ? [c.contactId] : []))).size;
  liveStats.last = { objectId: id, revision: record.revision, points: inputs.points.length, tips, dropped: built.dropped.length, verdict: built.verdict?.status ?? 'none', ms, settings: record.settings };
  // An EMPTY build is not `clear`: the engine's Clear means "no body intersection found" and
  // disclaims being a print-stability claim, so with no supports it is vacuously true and the
  // operator reads "Supports clear the model" about supports that do not exist. And a MISSING
  // verdict is not clear either - nothing was checked - so the fallback is `inconclusive`.
  const emptyBuild = built.indices.length === 0;
  verdicts.set(id, { status: emptyBuild ? 'nothing-built' : built.verdict?.status ?? 'inconclusive', dropped: built.dropped.length, islands: built.islands?.status === 'ok' ? built.islands.islands.filter((i) => i.status === 'unresolved').length : 0, ...(built.fallbacks?.length ? { fallbacks: built.fallbacks } : {}) });
  if (built.fallbacks?.includes('brace-pruned') || built.dentalStructureFallback?.includes('brace-pruned')) notify({ message: t('supportLive.bracePruned') });

  // The check that fills the list; the verdict and the build are already on screen.
  const tc = performance.now();
  const problems = await checkProblems(id, om, record, inputs, built);
  ms.check = Math.round(performance.now() - tc);
  if (!job.current() || !problems) return;
  problemsByObject.set(id, problems);
  publishProblems();
  fixSpotChecked(id, problems);
}

async function checkProblems(id: string, om: ObjectModel, record: ObjectSupports, inputs: ContactInputs, built: GeneratedSupportMesh | undefined): Promise<PanelProblem[] | undefined> {
  const all = jobContacts(inputs);
  const dropped = new Set(built?.dropped ?? []);
  const live = all.filter((c) => !dropped.has(c.id));
  const checked = await analyse(`${id}|check`, {
    kind: 'check',
    job: { mesh: om.model.local, orientation: ORIGIN, contacts: live.map((c) => [...c.position] as [number, number, number]), settings: { overhangAngleDegrees: record.settings.scatterAngle, spacing: record.settings.scatterSpacing } },
  });
  if (!checked || checked.kind !== 'checked') return undefined;
  const zones = readStamps(record.stamps);
  const found: SupportProblem[] = [
    ...checked.problems,
    ...islandProblems(built?.islands, om.model.local.positions),
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
    respawnWaiters.get(id)?.();
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

// ── export build (P4.2) ──

/** Supports of one object as an export reads them: the export-mode build (engine mode 1), not the preview. */
export interface SupportExportBuild {
  /** Vertices relative to `origin`, Babylon axes, scene units, already at the export size. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Babylon world position (scene units, as shown) of the support-frame origin (the object's box centre). */
  origin: Vec3;
  /** Distinct contacts the build carries (one per tip). */
  contactIds: string[];
}

/** Why supports cannot be exported now: stale (they no longer fit their object). */
export function supportsStaleError(objectId: string, reason: string): Error {
  return Object.assign(new Error(`Supports of "${objectId}" are out of date (${reason}); open Support Mode to rebuild them before exporting.`), {
    code: 'EXPORT_SUPPORTS_STALE', objectId, reason,
  });
}

/** Last export build per object (tests and the walk compare it with the drawn supports). */
export const exportStats: { last: Record<string, { scale: number; contactIds: string[]; tris: number }> } = { last: {} };

/**
 * Build the supports of `id` for an export at `scale` x the shown size (1 = as shown). The record is
 * the only input, as for the preview; at another scale the model and the contact positions are
 * scaled and the supports built anew at that size (ratio rule: tips are never scaled). Stale
 * supports (flag, or a geometry hash / pose that no longer matches the build) throw
 * `EXPORT_SUPPORTS_STALE`. Resolves null when the object has no built supports or the engine builds
 * none (every support removed).
 */
export async function buildSupportsForExport(id: string, scale = 1): Promise<SupportExportBuild | null> {
  const made = await exportBuild(id, scale, 'export');
  if (!made) return null;
  const { owner, om, built } = made;
  const offset = anchorOffset(om.anchor, withRestTransform(() => leadPosition(owner)));
  const contactIds = [...new Set(built.components.flatMap((c) => (c.contactId ? [c.contactId] : [])))];
  exportStats.last[owner] = { scale, contactIds, tris: built.indices.length / 3 };
  return {
    positions: positionsFromEngine(built.positions),
    indices: Uint32Array.from(built.indices),
    origin: supportToBabylon([0, 0, 0], om.anchor, offset),
    contactIds,
  };
}

/**
 * The export-mode build (engine mode 1) of one object's supports, raw (engine frame). `tag` names the
 * worker unit when it must not be the preview's own: the cost measurement ('measure') never shares a
 * unit with the preview build or an export, so one cannot replace the other in the mesh worker.
 */
async function exportBuild(id: string, scale: number, tag: 'export' | 'measure'): Promise<{ owner: string; om: ObjectModel; built: GeneratedSupportMesh } | null> {
  const owner = supportsOwner(id);
  const record = readSupports(owner);
  if (!record || !isBuilt(record)) return null;
  if (record.stale) throw supportsStaleError(owner, record.stale);
  const om = await objectModelStaged(owner, yieldToMain);
  if (!om) return null;
  const hash = await sceneSource.sourceHashStaged(owner, yieldToMain);
  if (hash !== null && hash !== record.sourceHash) throw supportsStaleError(owner, 'geometry');
  const pose = scenePose(owner);
  if (pose && record.pose && !samePose(pose, record.pose)) throw supportsStaleError(owner, 'pose');
  await ensureEngine();
  let points = cachedPlacement(owner);
  if (!points) {
    // A loaded project before Support Mode was opened: the placement is derived data (same geometry
    // and settings give the same contacts), rebuilt here exactly as the restoring path does.
    const placed = await analyse(`${owner}|${tag}`, { kind: 'place', job: { mesh: om.model.local, orientation: ORIGIN, settings: toPlacementSettings(record.settings) } });
    if (!placed || placed.kind !== 'placed') throw new Error(`Support placement for the export of "${owner}" did not finish`);
    points = placed.result.points;
    cachePlacement(owner, points);
  }
  const inputs = { ...contactInputs(owner, record), points };
  const sized = scale === 1 ? { model: om.model, inputs } : scaledJobInputs(om.model, inputs, scale);
  // As shown, the preview's own model is reused (the worker keeps it); another size is a unit of its own, freed after.
  const unitId = scale === 1 && tag === 'export' ? owner : `${owner}#${tag}`;
  const built = await mesher().build(unitId, { ...buildJob(sized.model, record, sized.inputs, objectName(owner)), mode: 'export' }, { key: 'Support building' });
  if (unitId !== owner) mesher().forget(unitId);
  if (!built || built.indices.length === 0) return null;
  return { owner, om, built };
}

// ── export-build figures for the cost quote (P4.3b) ──

/**
 * Volume and triangle count of the export-mode build of one object's supports, as the export writes
 * them (volume is the abs signed volume of the closed mesh; engine mm = mm-physical). The mesh itself
 * is dropped at once (D24). Null when nothing builds.
 */
export async function measureSupportsForExport(id: string, scale = 1): Promise<{ volumeMM3: number; triangles: number } | null> {
  const made = await exportBuild(id, scale, 'measure');
  if (!made) return null;
  const { built } = made;
  return { volumeMM3: Math.abs(signedVolume(built.positions, built.indices)), triangles: built.indices.length / 3 };
}

const measuring = new Set<string>();

/**
 * Measure the export build of `id` for its current revision and cache the figures (one entry per
 * object). Latest wins: a revision that moved on meanwhile discards the result and measures anew.
 * A build that cannot be made (stale supports) is cached as `failed`, never retried for that revision.
 * No-op while a measurement of the object runs or when the figures are already cached.
 */
export function requestSupportFigures(id: string): void {
  const owner = supportsOwner(id);
  if (measuring.has(owner)) return;
  const record = readSupports(owner);
  if (!record || !isBuilt(record) || record.stale) return;
  const revision = record.revision;
  if (cachedSupportFigures(owner, revision, 1)) return;
  measuring.add(owner);
  void (async () => {
    try {
      const figures = await measureSupportsForExport(owner, 1);
      const now = readSupports(owner);
      if (!now || now.revision !== revision) return;   // moved on: the re-request below measures the new revision
      cacheSupportFigures(owner, figures ? { revision, scale: 1, ...figures } : { revision, scale: 1, failed: true });
    } catch (error) {
      const now = readSupports(owner);
      if (now && now.revision === revision) cacheSupportFigures(owner, { revision, scale: 1, failed: true });
      console.warn('support figures for the cost quote failed', error);
    } finally {
      measuring.delete(owner);
      const now = readSupports(owner);
      if (now && isBuilt(now) && !now.stale && !cachedSupportFigures(owner, now.revision, 1)) requestSupportFigures(owner);
    }
  })();
}

// ── wiring ──

/** Generate / Regenerate: lift to the bed, then a job with a fresh placement. Also the first build when a hand-added support comes before any Generate. */
export function generate(ids: readonly string[]): void {
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
  // Picking (Add, Select, the ghost tip) runs on the engine session, so the engine loads on entry, not at the first Generate.
  void ensureEngine().catch((error) => console.error('support engine failed to load', error));
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
  setSupportFiguresRequester(requestSupportFigures);
  supportUi.register({ generate, cancelJob });
  subscribe(EVENTS.SUPPORTS_CHANGED, onSupportsChanged);
  // A project load / new reuses saved mesh ids with GeometryStore revisions back at 0, so the version key
  // alone cannot tell the new geometry from the old: the cached support-frame model goes (P4.1).
  subscribe(EVENTS.PROJECT_NEW, () => forgetObjectModel());
  subscribe(EVENTS.PROJECT_LOADED, () => forgetObjectModel());
  supportMode.onChange(onModeChanged);
  if (supportMode.isActive()) onModeChanged({ active: true, objectIds: supportMode.getObjectIds() });
  (window as any).__mxSupportLive = { stats: liveStats, exportStats, request: requestJob, cancel: cancelJob, busy: isJobBusy, lift: liftObject, generate, test: testHooks };
}
