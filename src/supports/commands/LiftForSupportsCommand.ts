/**
 * "Lift for supports" (P3 lift decision, 2026-10-29): supports are built down to the bed (plate =
 * bed, y = 0), so generating supports lifts the logical object until its lowest point stands
 * `liftMm` above the bed: one undoable transform step that moves every part by the same height.
 * Changing the lift re-runs it (the caller batches it with the settings change); lift 0 drops the
 * object back onto the bed. Only the height changes, so the supports never go stale (translation).
 */
import { dispatch, getState, markDirty } from '../../core/StateManager.js';
import { EVENTS } from '../../core/events.js';
import { AssetLoader } from '../../core/AssetLoader.js';
import { logicalObjectPartIds } from '../../core/LogicalObjects.js';
import { applyTransforms, captureWorld } from '../../core/commands/support.js';
import { withRestTransform } from '../../core/scene/ImportBounce.js';
import { MM_PER_BU } from '../../core/scene/SceneConstants.js';
import { t } from '../../i18n/index.js';
import { supportsOwner } from '../store';

export interface WorldTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scaling: { x: number; y: number; z: number };
}

/** The scene the command moves; the default is the Babylon scene. */
export interface LiftScene {
  /** Part ids of the logical object that have a mesh. */
  parts(objectId: string): string[];
  /** Lowest world Y (scene units) over the parts, at rest. */
  minY(partIds: readonly string[]): number;
  capture(partId: string): WorldTransform;
  apply(snapshot: Record<string, WorldTransform>): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon meshes are untyped */
export const babylonLiftScene: LiftScene = {
  parts(objectId) {
    const objects = getState().scene.objects;
    return logicalObjectPartIds(objectId, objects).filter((id: string) => !objects[id]?.isGhost && AssetLoader.getBabylonMesh(id));
  },
  minY(partIds) {
    return withRestTransform(() => {
      let min = Infinity;
      for (const id of partIds) {
        const mesh: any = AssetLoader.getBabylonMesh(id);
        mesh.computeWorldMatrix(true);
        mesh.refreshBoundingInfo?.();
        min = Math.min(min, mesh.getBoundingInfo().boundingBox.minimumWorld.y);
      }
      return min;
    });
  },
  capture: (partId) => captureWorld(AssetLoader.getBabylonMesh(partId)),
  apply: (snapshot) => applyTransforms(snapshot),
};

/** Height change (scene units) that puts the lowest point `liftMm` above the bed. */
export function liftDelta(minY: number, liftMm: number): number {
  return liftMm / MM_PER_BU - minY;
}

export class LiftForSupportsCommand {
  readonly supportsCommand = true;
  readonly label: string;
  readonly objectId: string;
  private readonly prev: Record<string, WorldTransform> = {};
  private readonly next: Record<string, WorldTransform> = {};
  private readonly scene: LiftScene;

  constructor(objectId: string, liftMm: number, scene: LiftScene = babylonLiftScene) {
    this.label = t('history.liftForSupports');
    this.objectId = supportsOwner(objectId);
    this.scene = scene;
    const parts = scene.parts(this.objectId);
    if (!parts.length) return;
    const dy = liftDelta(scene.minY(parts), liftMm);
    for (const id of parts) {
      const world = scene.capture(id);
      this.prev[id] = world;
      this.next[id] = { ...world, position: { ...world.position, y: world.position.y + dy } };
    }
  }

  /** Whether the step moves anything (the caller skips a no-op lift). */
  get moves(): boolean {
    return Object.keys(this.next).some((id) => Math.abs(this.next[id]!.position.y - this.prev[id]!.position.y) > 1e-9);
  }

  execute(): void {
    this.scene.apply(this.next);
    markDirty();
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this.next) });
  }

  undo(): void {
    this.scene.apply(this.prev);
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this.prev) });
  }
}
