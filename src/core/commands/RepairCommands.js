import { getState, setState } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { bump } from '../geometry/GeometryStore.js';
import { validateMesh } from '../MeshValidator.js';

const KINDS = ['position', 'normal', 'tangent', 'uv', 'uv2', 'uv3', 'uv4', 'color'];

const kindsOf = mesh => mesh.getVerticesDataKinds?.() ?? KINDS;

function captureOne(meshId) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return null;
  const buffers = [];
  for (const kind of kindsOf(mesh)) {
    const data = mesh.getVerticesData(kind);
    if (data) buffers.push([kind, Float32Array.from(data)]);
  }
  return {
    meshId, buffers,
    indices: Uint32Array.from(mesh.getIndices() ?? []),
    fixes: getState().scene.objects[meshId]?.geometryFixes,
  };
}

function restoreOne(snap) {
  const mesh = AssetLoader.getBabylonMesh(snap.meshId);
  if (mesh) {
    const kept = new Set(snap.buffers.map(([kind]) => kind));
    for (const kind of kindsOf(mesh)) {
      if (!kept.has(kind) && mesh.isVerticesDataPresent?.(kind)) mesh.removeVerticesData?.(kind);
    }
    for (const [kind, data] of snap.buffers) mesh.setVerticesData(kind, data, true);
    mesh.setIndices(snap.indices, null, true);
    mesh.refreshBoundingInfo?.();
  }
  setState(s => {
    const o = s.scene.objects[snap.meshId];
    if (!o) return s;
    const { geometryFixes: _drop, ...rest } = o;
    const next = snap.fixes ? { ...rest, geometryFixes: snap.fixes } : rest;
    return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [snap.meshId]: next } } };
  }, { silent: true });
  if (mesh) bump(mesh);
}

/**
 * Copy the live geometry and recorded `geometryFixes` of `partIds`, taken
 * right before a repair so {@link RepairCommand} can put it back.
 * @param {string[]} partIds
 */
export function captureRepairState(partIds) {
  return partIds.map(captureOne).filter(Boolean);
}

const triangles = snaps => (snaps ? snaps.reduce((n, s) => n + s.indices.length / 3, 0) : 0);

/**
 * Undo step for a Repair that already ran. Each side holds one geometry copy:
 * the undo side keeps the pre-repair copy, the redo side the repaired one,
 * captured from the live mesh at the moment it is replaced.
 */
export class RepairCommand {
  /** @param {Array<{objectId:string, before:ReturnType<typeof captureRepairState>}>} repaired */
  constructor(repaired) {
    this.label = 'Repair';
    this._objects = repaired.map(r => ({ objectId: r.objectId, partIds: r.before.map(s => s.meshId) }));
    this._undoSnaps = repaired.flatMap(r => r.before);
    this._redoSnaps = null;
  }

  execute() {
    if (!this._redoSnaps) return;   // first push: the repair has already been applied
    this._undoSnaps = this._swap(this._redoSnaps);
    this._redoSnaps = null;
  }

  undo() {
    this._redoSnaps = this._swap(this._undoSnaps);
    this._undoSnaps = null;
  }

  _swap(snaps) {
    const current = captureRepairState(this._objects.flatMap(o => o.partIds));
    for (const snap of snaps) restoreOne(snap);
    for (const { objectId, partIds } of this._objects) {
      const lead = AssetLoader.getBabylonMesh(objectId) ?? AssetLoader.getBabylonMesh(partIds[0]);
      if (lead) validateMesh(lead).catch(err => console.error('Re-validation after repair undo/redo failed:', err));
    }
    return current;
  }

  retainedTriangles(side) { return triangles(side === 'undo' ? this._undoSnaps : this._redoSnaps); }

  release(side) {
    if (side === 'undo') this._undoSnaps = null; else this._redoSnaps = null;
  }
}
