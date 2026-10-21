// Heavy-mesh picking (heavy-mesh spec §4, §7.5). Babylon's default mesh pick
// builds a Vector3 per vertex on first use (`_generatePointsArray`, ~3 GB of
// heap at 10M triangles) and then tests every triangle. For meshes at or above
// HEAVY_PICK_TRIANGLES this module builds a flat BVH in a worker and installs an
// instance `intersects` override returning Babylon's own PickingInfo shape, so
// EVERY scene.pick caller (click, hover, context menu, cursor placement)
// benefits without changes. Until the index is ready — or whenever it is stale
// (geometry revision / buffer identity changed) — an allocation-free scan of
// the live typed arrays answers instead (same hit rules); Babylon's default
// only runs for predicates, bounding-only picks and interleaved buffers.

import { WorkerTask } from '../workers/WorkerTask.js';
import { raycastBvh, raycastAll } from '../geometry/triangleBvh.js';
import { revisionOf, extract } from '../geometry/GeometryStore.js';
import { EVENTS } from '../events.js';
import { subscribe } from '../StateManager.js';

const BABYLON = window.BABYLON;

export const HEAVY_PICK_TRIANGLES = 200_000;
const BUILD_DELAY_MS = 600;
const BVH_TIMEOUT_MS = 300_000;
const POSITION = 'position';

const _state = new WeakMap();   // mesh → { bvh, revision, posRef, idxRef, indexCount, timer, building }
const _tracked = new Set();
let _pending = 0;
let _builder = null;            // test seam: (positions, indices) → Promise<bvh>

const _task = new WorkerTask({
  name: 'pick index',
  label: 'job.pickIndex',
  mode: 'per-job',
  concurrency: 'serial',
  timeoutMs: BVH_TIMEOUT_MS,
  create: typeof Worker === 'function'
    ? () => new Worker(new URL('../workers/TriangleBvh.worker.js', import.meta.url), { type: 'module' })
    : null,
});

/** Test seam: replace the worker build. */
export function setBvhBuilder(fn) { _builder = fn; }

/** Builds queued or running (the perf harness waits on this). */
export function pendingCount() { return _pending; }

function _triangles(mesh) {
  return (mesh?.getTotalIndices?.() ?? 0) / 3;
}

function _isTiny(mesh) {
  return _triangles(mesh) < HEAVY_PICK_TRIANGLES;
}

/** Live, non-interleaved position array (or null when Babylon would have to copy it). */
function _livePositions(mesh) {
  const vb = mesh?.getVertexBuffer?.(POSITION);
  if (!vb) return null;
  const data = vb.getData?.();
  if (!data || !ArrayBuffer.isView(data)) return null;
  if ((vb.byteStride ?? 12) !== 12 || (vb.byteOffset ?? 0) !== 0) return null;
  return data;
}

function _isStale(mesh, st) {
  return !st?.bvh
    || st.revision !== revisionOf(mesh)
    || st.indexCount !== (mesh.getTotalIndices?.() ?? -1)
    || st.posRef !== _livePositions(mesh)
    || st.idxRef !== mesh.getIndices?.();
}

/** Index usable for this mesh right now? */
export function hasFreshIndex(mesh) {
  return !_isStale(mesh, _state.get(mesh));
}

function _schedule(mesh) {
  const st = _state.get(mesh);
  if (!st || mesh.isDisposed?.()) return;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.timer = null; _build(mesh); }, BUILD_DELAY_MS);
}

async function _build(mesh) {
  const st = _state.get(mesh);
  if (!st || mesh.isDisposed?.() || st.building) return;
  const posRef = _livePositions(mesh);
  const idxRef = mesh.getIndices?.();
  if (!posRef || !idxRef || _isTiny(mesh)) return;
  const revision = revisionOf(mesh);
  const indexCount = idxRef.length;
  st.building = true;
  _pending++;
  try {
    let bvh;
    if (_builder) {
      bvh = await _builder(posRef, idxRef);
    } else {
      const { positions, indices } = extract(mesh, { space: 'local' });
      bvh = await _task.run({ positions, indices }, { transfer: [positions.buffer, indices.buffer] });
    }
    // Only keep it if nothing changed while it was building.
    if (!mesh.isDisposed?.() && revisionOf(mesh) === revision && _livePositions(mesh) === posRef && mesh.getIndices?.() === idxRef) {
      Object.assign(st, { bvh, revision, posRef, idxRef, indexCount });
    } else if (!mesh.isDisposed?.()) {
      _schedule(mesh);
    }
  } catch (err) {
    // The activity panel already shows the failure; picking keeps Babylon's default.
    console.error('Pick index build failed:', err);
  } finally {
    st.building = false;
    _pending--;
  }
}

/**
 * Babylon AbstractMesh.intersects with the BVH for the triangle stage. Same
 * bounding checks, same PickingInfo fields (world point, distance, bu/bv,
 * faceId, subMeshFaceId, subMeshId). Falls back to the prototype for
 * triangle predicates, bounding-only picks and stale or missing indices.
 */
function _intersects(ray, fastCheck, trianglePredicate, onlyBoundingInfo = false, worldToUse, skipBoundingInfo = false) {
  const st = _state.get(this);
  const proto = Object.getPrototypeOf(this).intersects;
  const stale = _isStale(this, st);
  const pos = stale ? _livePositions(this) : st.posRef;
  const idx = stale ? this.getIndices?.() : st.idxRef;
  if (trianglePredicate || onlyBoundingInfo || !this.subMeshes || !pos || !idx) {
    return proto.call(this, ray, fastCheck, trianglePredicate, onlyBoundingInfo, worldToUse, skipBoundingInfo);
  }
  if (stale && st && !st.building && !st.timer) _schedule(this);
  const info = new BABYLON.PickingInfo();
  const boundingInfo = this.getBoundingInfo();
  if (!skipBoundingInfo && (!ray.intersectsSphere(boundingInfo.boundingSphere, 0) || !ray.intersectsBox(boundingInfo.boundingBox, 0))) {
    return info;
  }
  const opts = { length: ray.length, epsilon: ray.epsilon ?? 0, fastCheck: !!fastCheck };
  const hit = stale
    ? raycastAll(pos, idx, ray.origin, ray.direction, opts)
    : raycastBvh(st.bvh, pos, idx, ray.origin, ray.direction, opts);
  if (!hit) return info;
  const world = worldToUse ?? this.getWorldMatrix();
  const worldOrigin = BABYLON.Vector3.TransformCoordinates(ray.origin, world);
  const direction = ray.direction.scale(hit.distance);
  const pickedPoint = BABYLON.Vector3.TransformNormal(direction, world).addInPlace(worldOrigin);
  let subMesh = this.subMeshes[0];
  for (const sm of this.subMeshes) {
    if (hit.faceId * 3 >= sm.indexStart && hit.faceId * 3 < sm.indexStart + sm.indexCount) { subMesh = sm; break; }
  }
  info.hit = true;
  info.distance = BABYLON.Vector3.Distance(worldOrigin, pickedPoint);
  info.pickedPoint = pickedPoint;
  info.pickedMesh = this;
  info.bu = hit.bu || 0;
  info.bv = hit.bv || 0;
  info.faceId = hit.faceId;
  info.subMeshFaceId = hit.faceId - (subMesh?.indexStart ?? 0) / 3;
  info.subMeshId = subMesh?._id ?? 0;
  return info;
}

/** Start tracking a mesh: heavy ones get a background pick index + the override. */
export function track(mesh) {
  if (!mesh || _state.has(mesh) || mesh.isDisposed?.() || _isTiny(mesh)) return false;
  if (mesh.getClassName?.() !== 'Mesh') return false;   // instances / lines keep Babylon's pick
  _state.set(mesh, { bvh: null, revision: -1, posRef: null, idxRef: null, indexCount: -1, timer: null, building: false });
  _tracked.add(mesh);
  mesh.intersects = _intersects;
  mesh.onDisposeObservable?.add(() => untrack(mesh));
  _schedule(mesh);
  return true;
}

/** Stop tracking; restores Babylon's own intersects. */
export function untrack(mesh) {
  const st = _state.get(mesh);
  if (!st) return;
  clearTimeout(st.timer);
  _state.delete(mesh);
  _tracked.delete(mesh);
  delete mesh.intersects;
}

/** Build now (tests / harness) instead of after the debounce. */
export function buildNow(mesh) {
  const st = _state.get(mesh);
  if (st) clearTimeout(st.timer);
  return _build(mesh);
}

/** Wire into a scene: every heavy mesh added later is tracked; geometry edits rebuild. */
export function init(scene) {
  for (const m of scene.meshes) track(m);
  scene.onNewMeshAddedObservable.add((m) => {
    // Geometry is bound after the add (VertexData.applyToMesh / addAllToScene): check next tick.
    setTimeout(() => track(m), 0);
  });
  subscribe(EVENTS.GEOMETRY_CHANGED, ({ meshId } = {}) => {
    for (const m of _tracked) if (m.metadata?.meshId === meshId) _schedule(m);
  });
}

export const HeavyPick = { init, track, untrack, buildNow, hasFreshIndex, pendingCount, setBvhBuilder, HEAVY_PICK_TRIANGLES };
