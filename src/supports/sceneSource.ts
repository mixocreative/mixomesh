/**
 * The Babylon scene as a `SupportSceneSource` (plan P3.1): the lead's pose (rotation + scale of its
 * world matrix, at rest — ImportBounce) and the `sourceHash` of the logical object's parts in the
 * lead's local frame, cached per geometry version (the parts' GeometryStore revisions and the
 * refinement level), so a translation, rotation or scale never re-hashes.
 */
import { getState } from '../core/StateManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { logicalObjectPartIds } from '../core/LogicalObjects.js';
import { extract, revisionOf } from '../core/geometry/GeometryStore.js';
import { frontFaceIsClockwise } from '../core/print/PrintSpace.js';
import { withRestTransform } from '../core/scene/ImportBounce.js';
import type { BabylonPart } from './frame';
import type { SupportPose } from './model';
import { SourceHashCache } from './sourceHash';
import type { SupportSceneSource } from './stale';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */
const BABYLON = (globalThis as any).BABYLON;

function liveParts(objectId: string): { id: string; mesh: any }[] {
  const objects = getState().scene.objects;
  return logicalObjectPartIds(objectId, objects).flatMap((id: string) => {
    if (objects[id]?.isGhost) return [];
    const mesh = AssetLoader.getBabylonMesh?.(id);
    return mesh ? [{ id, mesh }] : [];
  });
}

/** Lead rotation and scale from its world matrix at rest; null when the object has no mesh. */
export function scenePose(objectId: string): SupportPose | null {
  const lead = liveParts(objectId)[0]?.mesh;
  if (!lead) return null;
  return withRestTransform(() => {
    const world = lead.computeWorldMatrix(true);
    const s = new BABYLON.Vector3(1, 1, 1);
    const q = new BABYLON.Quaternion(0, 0, 0, 1);
    const p = new BABYLON.Vector3(0, 0, 0);
    if (!world.decompose(s, q, p)) return null;
    return { rotation: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] } satisfies SupportPose;
  });
}

/** The parts in the lead's local frame (Babylon units), each with its effective front face there. */
export function leadLocalParts(objectId: string): BabylonPart[] {
  const parts = liveParts(objectId);
  if (!parts.length) return [];
  return withRestTransform(() => {
    const leadInverse = parts[0]!.mesh.computeWorldMatrix(true).clone().invert();
    return parts.flatMap(({ mesh }) => {
      const { positions, indices } = extract(mesh, { space: 'local' });
      if (!positions.length || !indices.length) return [];
      const rel = mesh.computeWorldMatrix(true).multiply(leadInverse);
      const m = rel.m;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
        positions[i] = x * m[0] + y * m[4] + z * m[8] + m[12];
        positions[i + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
        positions[i + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
      }
      return [{ positions, indices, clockwise: frontFaceIsClockwise(mesh) !== (rel.determinant() < 0) }];
    });
  });
}

function refinementLevel(objectId: string): number {
  return getState().scene.objects[objectId]?.printRefinement?.requestedLevel ?? 0;
}

function versionKey(objectId: string, parts: readonly { id: string }[]): string {
  return `${parts.map(({ id }) => `${id}@${revisionOf(id)}`).join(',')}|r${refinementLevel(objectId)}`;
}

/**
 * The scene source the app installs. The refinement level is part of the hash (refined print
 * geometry is another surface for the contacts), the parts are read only on a cache miss.
 */
export function createSceneSource(): SupportSceneSource {
  const hashes = new SourceHashCache();
  return {
    pose: scenePose,
    sourceHash(objectId) {
      const parts = liveParts(objectId);
      if (!parts.length) return null;
      const level = refinementLevel(objectId);
      const hash = hashes.get(objectId, versionKey(objectId, parts), () => leadLocalParts(objectId));
      return level ? `${hash}-r${level}` : hash;
    },
    forgetHash: (objectId) => hashes.forget(objectId),
  };
}
