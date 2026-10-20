import { EVENTS } from '../events.js';
import { dispatch, getState, setState, subscribe } from '../StateManager.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import { getBabylonMesh } from '../assets/MeshRegistry.js';
import { mixoPrimitiveId } from '../import/ImportMetadata.js';
import { refinePartsInWorker } from '../MixoRefinementWorker.js';
import { createDerivedMeshes } from './DerivedMeshes.js';
import { MeshValidator } from '../MeshValidator.js';
import { refinementSetting } from '../commands/RefinementCommands.js';

const PHASES = { reading: 'Reading topology', refining: 'Refining', validating: 'Validating' };
let initialized = false;

/** Resolve source-change event payloads to the leads whose caches are unsafe. */
export function refinementAffectedIds(payload, objects) {
  const ids = [payload?.objectId, payload?.meshId, payload?.id, ...(payload?.meshIds ?? [])];
  if (payload?.assetId) {
    for (const object of Object.values(objects)) if (object?.assetId === payload.assetId) ids.push(object.id);
  }
  return [...new Set(ids.filter(id => id && objects[id]).map(id => canonicalObjectId(id, objects)))];
}

/** Explain whether every source part has final-primitive refinement metadata. */
export function refinementAvailability(id, sourceMeshes = leadId => logicalObjectPartIds(leadId, getState().scene.objects).map(getBabylonMesh)) {
  const object = getState().scene.objects[id];
  if (!object?.mixoProvenance) return { available: false, reason: 'This is not a Mixo 3D source.' };
  if (!Array.isArray(object.mixoRefinement) || !object.mixoRefinement.length) return { available: false, reason: 'Refinement metadata is missing. Re-export from Mixo3D Tools.' };
  const meshes = sourceMeshes(id);
  if (!meshes.length || meshes.some(mesh => !mesh)) return { available: false, reason: 'Source geometry is unavailable.' };
  const descriptors = new Map(object.mixoRefinement.map(d => [d.primitiveId, d]));
  for (const mesh of meshes) {
    const descriptor = descriptors.get(mixoPrimitiveId(mesh));
    if (!descriptor) return { available: false, reason: 'A source part lacks refinement metadata. Re-export from Mixo3D Tools.' };
    const count = mesh.getTotalVertices?.() ?? mesh.getVerticesData?.('position')?.length / 3;
    const creaseCount = descriptor.creaseByVertex?.length ?? Object.keys(descriptor.creaseByVertex ?? {}).length;
    if (!Number.isInteger(count) || count !== creaseCount) return { available: false, reason: 'Refinement metadata no longer matches the source mesh. Re-export from Mixo3D Tools.' };
  }
  return { available: true, reason: null };
}

function setTransient(id, patch, event = EVENTS.REFINEMENT_CHANGED) {
  setState(s => {
    const object = s.scene.objects[id];
    if (!object) return s;
    return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects,
      [id]: { ...object, printRefinement: { ...refinementSetting(object), ...patch } },
    } } };
  }, { silent: true });
  dispatch(event, { objectId: id, ...patch });
}

function inputOf(mesh, descriptor) {
  const positions = mesh.getVerticesData('position');
  const indices = mesh.getIndices();
  if (!positions?.length || !indices?.length) throw new Error('Source geometry is unavailable');
  const normals = mesh.getVerticesData('normal');
  const uvs = mesh.getVerticesData('uv');
  const values = value => Array.isArray(value) || ArrayBuffer.isView(value) ? value : Object.values(value ?? {});
  return {
    positions: Float32Array.from(positions), indices: Uint32Array.from(indices),
    ...(normals?.length ? { normals: Float32Array.from(normals) } : {}),
    ...(uvs?.length ? { uvs: Float32Array.from(uvs) } : {}),
    creaseByVertex: Float32Array.from(values(descriptor.creaseByVertex)),
    sharpEdges: Uint32Array.from(values(descriptor.sharpEdges)),
  };
}

function disposeEntry(entry) {
  entry?.abort?.abort();
  entry?.sources?.forEach((source, index) => {
    const id = entry.partIds?.[index];
    if (source) source.isVisible = getState().scene.objects[id]?.visible !== false && entry.originalVisible?.[index] !== false;
  });
  for (const mesh of entry?.meshes ?? []) mesh.dispose?.();
}

/** Controller factory permits focused worker and scene tests. */
export function create({ sourceMeshes = id => logicalObjectPartIds(id, getState().scene.objects).map(getBabylonMesh), refine = refinePartsInWorker, derive = createDerivedMeshes, validate = MeshValidator.validateDerivedGroup } = {}) {
  const own = new Map();
  let generation = 0;
  const controller = {
    getDerivedMeshes(id) { return own.get(id)?.meshes ?? null; },
    getBuiltLevel(id) { return own.get(id)?.level ?? null; },
    getProgress(id) { return own.get(id)?.progress ?? null; },
    async build(id) {
      const object = getState().scene.objects[id];
      const setting = refinementSetting(object);
      if (!setting.requestedLevel) return false;
      const availability = refinementAvailability(id, sourceMeshes);
      if (!availability.available) {
        setTransient(id, { status: 'failed', error: { code: 'SOURCE_UNAVAILABLE', message: availability.reason } }, EVENTS.REFINEMENT_FAILED);
        return false;
      }
      controller.cancel(id, false);
      const revision = ++generation;
      const abort = new AbortController();
      const entry = { revision, abort, level: setting.requestedLevel, meshes: [], progress: null, sources: [], partIds: [], originalVisible: [] };
      own.set(id, entry);
      setTransient(id, { status: 'queued', error: null }, EVENTS.REFINEMENT_PROGRESS);
      try {
        const sources = sourceMeshes(id);
        if (!sources.length || sources.some(mesh => !mesh)) throw new Error('Refinement source parts are missing');
        entry.sources = sources;
        entry.partIds = logicalObjectPartIds(id, getState().scene.objects);
        entry.originalVisible = sources.map(source => source.isVisible !== false);
        const descriptors = new Map(object.mixoRefinement.map(d => [d.primitiveId, d]));
        const inputs = sources.map(source => {
          const descriptor = descriptors.get(mixoPrimitiveId(source)) ?? (descriptors.size === 1 ? object.mixoRefinement[0] : null);
          if (!descriptor) throw new Error('Refinement metadata is missing for a source part');
          return inputOf(source, descriptor);
        });
        entry.progress = { phase: PHASES.reading, completed: 0, total: 1, objectName: object.name };
        setTransient(id, { status: 'building' }, EVENTS.REFINEMENT_PROGRESS);
        const result = await refine(inputs, setting.requestedLevel, { signal: abort.signal, sourceRevision: revision, onProgress(progress) {
          if (own.get(id) !== entry) return;
          entry.progress = { ...progress, phase: PHASES[progress.phase] ?? progress.phase, objectName: object.name };
          dispatch(EVENTS.REFINEMENT_PROGRESS, { objectId: id, ...entry.progress });
        } });
        if (abort.signal.aborted || own.get(id) !== entry || refinementSetting(getState().scene.objects[id]).requestedLevel !== setting.requestedLevel) return false;
        entry.progress = { phase: PHASES.validating, completed: 0, total: 1, objectName: object.name };
        dispatch(EVENTS.REFINEMENT_PROGRESS, { objectId: id, ...entry.progress });
        entry.meshes = derive(sources, result.geometries ?? result, inputs, setting.requestedLevel);
        for (const derived of entry.meshes) derived.isVisible = false;
        const findings = await validate(entry.meshes, object.name);
        if (abort.signal.aborted || own.get(id) !== entry || refinementSetting(getState().scene.objects[id]).requestedLevel !== setting.requestedLevel) return false;
        if (findings?.some(finding => finding.severity === 'error')) throw new Error(findings.find(finding => finding.severity === 'error').message);
        if (own.get(id) !== entry) return false;
        setTransient(id, { status: 'ready', error: null }, EVENTS.REFINEMENT_READY);
        controller.syncPreview(id);
        return true;
      } catch (error) {
        if (own.get(id) !== entry) return false;
        for (const mesh of entry.meshes) mesh.dispose?.();
        entry.meshes = [];
        if (error?.name === 'AbortError' || abort.signal.aborted) {
          setTransient(id, { status: 'cancelled' }, EVENTS.REFINEMENT_CANCELLED);
        } else {
          const message = String(error?.message || error);
          const sizeLimited = message.includes('size limit');
          setTransient(id, { status: 'failed', error: {
            code: sizeLimited ? 'SIZE_LIMIT' : 'BUILD_FAILED',
            message: sizeLimited ? 'This mesh exceeds the safe subdivision size. Choose a lower level or use the original GLB.' : message,
          } }, EVENTS.REFINEMENT_FAILED);
        }
        return false;
      }
    },
    cancel(id, announce = true) {
      const entry = own.get(id);
      if (!entry) return;
      disposeEntry(entry);
      own.delete(id);
      if (announce) setTransient(id, { status: 'cancelled' }, EVENTS.REFINEMENT_CANCELLED);
    },
    invalidate(id) {
      const entry = own.get(id);
      if (entry) { disposeEntry(entry); own.delete(id); }
      const setting = refinementSetting(getState().scene.objects[id]);
      if (setting.requestedLevel) setTransient(id, { status: 'stale' }, EVENTS.REFINEMENT_STALE);
    },
    syncPreview(id) {
      const setting = refinementSetting(getState().scene.objects[id]);
      const entry = own.get(id);
      if (!entry?.meshes.length) return;
      const refined = setting.preview === 'refined' && setting.status === 'ready';
      entry.meshes.forEach((mesh, index) => {
        const visible = getState().scene.objects[entry.partIds[index]]?.visible !== false && entry.originalVisible[index] !== false;
        mesh.isVisible = refined && visible;
        entry.sources[index].isVisible = !refined && visible;
      });
    },
    dispose() { for (const entry of own.values()) disposeEntry(entry); own.clear(); },
  };
  return controller;
}

const singleton = create();

/** Wire one controller to typed lifecycle events; returns a testable teardown. */
export function installRefinementSubscriptions(controller) {
  const unsubscribers = [];
  unsubscribers.push(subscribe(EVENTS.REFINEMENT_CHANGED, ({ objectId }) => {
    const builtLevel = controller.getBuiltLevel(objectId);
    const setting = refinementSetting(getState().scene.objects[objectId]);
    if (builtLevel !== null && builtLevel !== setting.requestedLevel) controller.invalidate(objectId);
    else if (builtLevel === null && setting.status === 'ready') setTransient(objectId, { status: 'stale' }, EVENTS.REFINEMENT_STALE);
    else controller.syncPreview(objectId);
  }));
  for (const event of [EVENTS.OBJECT_UPDATED, EVENTS.TRANSFORM_COMMITTED, EVENTS.ASSET_RELINKED]) unsubscribers.push(subscribe(event, payload => {
    for (const id of refinementAffectedIds(payload, getState().scene.objects)) {
      if (controller.getDerivedMeshes(id)) controller.invalidate(id);
    }
  }));
  unsubscribers.push(subscribe(EVENTS.VISIBILITY_CHANGED, payload => {
    for (const id of refinementAffectedIds(payload, getState().scene.objects)) controller.syncPreview(id);
  }));
  unsubscribers.push(subscribe(EVENTS.OBJECT_REMOVED, payload => { const id = payload?.objectId ?? payload?.meshId ?? payload?.id; if (id) controller.cancel(id, false); }));
  for (const event of [EVENTS.PROJECT_NEW, EVENTS.PROJECT_LOADED]) unsubscribers.push(subscribe(event, () => controller.dispose()));
  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

/** Start lifecycle subscriptions; no import or load event starts a worker. */
export function init() {
  if (initialized) return;
  initialized = true;
  installRefinementSubscriptions(singleton);
}

export const RefinementController = { create, init, build: id => singleton.build(id), cancel: id => singleton.cancel(id), invalidate: id => singleton.invalidate(id), getDerivedMeshes: id => singleton.getDerivedMeshes(id), getProgress: id => singleton.getProgress(id), availability: refinementAvailability, syncPreview: id => singleton.syncPreview(id) };
export const getDerivedMeshes = id => singleton.getDerivedMeshes(id);
