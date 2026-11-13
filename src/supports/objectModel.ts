/**
 * The support-frame model of a logical object (plan P3.3): its parts in world space at rest, moved
 * through frame.ts into the engine frame, welded, then made object-local (`supportJob.toLocal`),
 * with the anchor that maps the support frame back to Babylon (BabylonViewportPort
 * `supportToBabylon`). Generation (spike / P3.5), engine picks on the model and the zone overlay
 * all read this one model, so a contact, a pick hit and a stamp share one frame.
 *
 * Cached per geometry version: the parts' GeometryStore revisions, the refinement level and the
 * lead's rotation and scale (they are baked into the support frame). Translation is not in the key:
 * it moves the anchor, never the local model.
 */
import { getState } from '../core/StateManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { logicalObjectPartIds } from '../core/LogicalObjects.js';
import { revisionOf } from '../core/geometry/GeometryStore.js';
import { frontFaceIsClockwise } from '../core/print/PrintSpace.js';
import { withRestTransform } from '../core/scene/ImportBounce.js';
import { partsToEngine, type BabylonPart, type EngineModel, type Vec3 } from './frame';
import { toLocal, type LocalModel } from './supportJob';
import { noiseShellVolumes, shellsOf } from './noiseShells';
import { scenePose } from './sceneSource';
import type { SupportAnchor } from './BabylonViewportPort';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */
const BABYLON = (globalThis as any).BABYLON;

export interface ObjectModel {
  objectId: string;
  version: string;
  engine: EngineModel;
  model: LocalModel;
  anchor: SupportAnchor;
  parts: number;
  /**
   * Volumes (mm3) of the tiny separate shells in this object — scan noise or stray fragments the
   * generic policy will support and the printer will print (C4). Largest first; empty for a
   * single-shell object.
   *
   * HERE because this is the one place that already walks the welded mesh and is CACHED PER GEOMETRY
   * VERSION. A noise shell only appears when the geometry changes, so computing it with the model
   * costs nothing per build — and a per-build scan is the long-task mistake this file's own staging
   * exists to avoid.
   */
  noiseShells: number[];
}

function liveParts(objectId: string): { id: string; mesh: any }[] {
  const objects = getState().scene.objects;
  return logicalObjectPartIds(objectId, objects).flatMap((id: string) => {
    if (objects[id]?.isGhost) return [];
    const mesh = AssetLoader.getBabylonMesh?.(id);
    return mesh ? [{ id, mesh }] : [];
  });
}

/** Babylon world position of the lead (the first live part), at rest. */
export function leadPosition(objectId: string): Vec3 | undefined {
  const lead = liveParts(objectId)[0]?.mesh;
  if (!lead) return undefined;
  const p = lead.getAbsolutePosition?.();
  return p ? [p.x, p.y, p.z] : undefined;
}

/** World-space parts of one logical object, read at rest (ImportBounce), with each part's effective front face. */
export function worldParts(objectId: string): BabylonPart[] {
  return withRestTransform(() => liveParts(objectId).flatMap(({ mesh }) => {
    const local = mesh.getVerticesData?.(BABYLON.VertexBuffer.PositionKind);
    const indices = mesh.getIndices?.();
    if (!local?.length || !indices?.length) return [];
    const world = mesh.computeWorldMatrix(true);
    const positions = new Float32Array(local.length);
    const v = new BABYLON.Vector3();
    for (let i = 0; i < local.length; i += 3) {
      BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(local[i], local[i + 1], local[i + 2], world, v);
      positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
    }
    // Babylon flips culling for a mirrored world matrix, so the outward order flips with it.
    const clockwise = frontFaceIsClockwise(mesh) !== (world.determinant() < 0);
    return [{ positions, indices, clockwise }];
  }));
}

/** Geometry version of the support frame of `objectId` (see the module comment). */
export function modelVersion(objectId: string): string {
  const objects = getState().scene.objects;
  const parts = liveParts(objectId);
  const level = objects[objectId]?.printRefinement?.requestedLevel ?? 0;
  const pose = scenePose(objectId);
  const round = (v: number) => Math.round(v * 1e9) / 1e9;
  const poseKey = pose ? [...pose.rotation, ...pose.scale].map(round).join(',') : 'none';
  return `${parts.map(({ id }) => `${id}@${revisionOf(id)}`).join(',')}|r${level}|${poseKey}`;
}

const cache = new Map<string, ObjectModel>();

/** The object's support-frame model, rebuilt only when its version changed; undefined without geometry. */
export function objectModel(objectId: string): ObjectModel | undefined {
  const version = modelVersion(objectId);
  const hit = cache.get(objectId);
  // Same shape: a move since is the anchor's offset (centre and lead were taken together).
  if (hit && hit.version === version) return hit;
  const parts = worldParts(objectId);
  if (!parts.length) {
    cache.delete(objectId);
    return undefined;
  }
  const engine = partsToEngine(parts);
  const model = toLocal(engine.mesh);
  const lead = withRestTransform(() => leadPosition(objectId)) ?? [0, 0, 0];
  const built: ObjectModel = { objectId, version, engine, model, anchor: { center: model.center, lead }, parts: parts.length,
    noiseShells: noiseShellVolumes(model.local, shellsOf(model.local)) };
  cache.set(objectId, built);
  return built;
}

/**
 * `objectModel` with its costly steps (read the parts, weld, make object-local) each in a task of
 * their own: `between` yields to the event loop. A cached model returns at once.
 */
export async function objectModelStaged(objectId: string, between: () => Promise<void>): Promise<ObjectModel | undefined> {
  const version = modelVersion(objectId);
  const hit = cache.get(objectId);
  if (hit && hit.version === version) return hit;
  await between();
  const parts = worldParts(objectId);
  if (!parts.length) {
    cache.delete(objectId);
    return undefined;
  }
  await between();
  const engine = partsToEngine(parts);
  await between();
  const model = toLocal(engine.mesh);
  await between();
  // Its own staged step: a union-find over a million triangles belongs behind a yield, like the
  // weld above it.
  const noiseShells = noiseShellVolumes(model.local, shellsOf(model.local));
  const lead = withRestTransform(() => leadPosition(objectId)) ?? [0, 0, 0];
  const built: ObjectModel = { objectId, version, engine, model, anchor: { center: model.center, lead }, parts: parts.length, noiseShells };
  cache.set(objectId, built);
  return built;
}

export function forgetObjectModel(objectId?: string): void {
  if (objectId === undefined) cache.clear();
  else cache.delete(objectId);
}
