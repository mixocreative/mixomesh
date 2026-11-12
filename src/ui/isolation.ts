import { logicalObjectPartIds } from '../core/LogicalObjects.js';

/*
 * Hide everything except the named objects, and put it back exactly.
 *
 * One job: the layer mask and its restore. Extracted from `SupportMode` because a SECOND caller is
 * coming -- the separator mode of `docs/plans/2026-11-12-parts-and-focus-mode.md` (U4/U5) needs the
 * same behaviour, and Fable's reading of that plan said so: "the mask is a closure and needs
 * extracting to reuse".
 *
 * Deliberately NOT the whole focus mode. The plan's module also owns the chrome dimming, the
 * instruction notice and the Esc handling -- and none of those has a caller yet, because the
 * separator mode is U5. A module built for a user that does not exist is the hub this repo's rules
 * exist to prevent, so they land with their first caller and this lands with its second.
 *
 * It passes the extraction test: in goes which objects stay lit; out comes everything else hidden
 * and a restore that is exact. Narrower out than in.
 */

/**
 * The layer a hidden mesh is moved to: no camera renders it.
 *
 * Re-exported from the leaf that already defined it rather than declared again here. It WAS declared
 * twice -- `SupportMode.ts` and `supportLayerTag.js` each had the literal -- and
 * `layers.test.ts` pinned them equal by reading one out of the other's SOURCE with a regex, because
 * importing SupportMode pulls the whole app graph in. Extracting the mask broke that regex, which is
 * how the duplication surfaced. One definition, in a module with no imports of its own, and the
 * pinning test has nothing left to guard.
 */
export { ISOLATION_LAYER_BIT as ISOLATION_LAYER } from '../supports/layers/supportLayerTag.js';
import { ISOLATION_LAYER_BIT } from '../supports/layers/supportLayerTag.js';

interface SceneLike {
  objects: Record<string, { isGhost?: boolean } | undefined>;
}

export interface IsolationDeps {
  scene(): SceneLike;
  /** Every Babylon mesh of one part id. */
  meshesOf(partId: string): { layerMask: number }[];
}

export interface Isolation {
  /**
   * Hide every object except `keepIds` and their parts. Calling it again re-reads the scene, so a
   * selection change inside the mode is applied without clearing first.
   */
  apply(keepIds: readonly string[]): void;
  /** Put every mask back to the value it had before `apply`. */
  clear(): void;
}

/**
 * `apply` / `clear` over `deps`.
 *
 * The saved value is per MESH, not per object, and only the first save for a mesh is kept -- a
 * second `apply` must not record the isolation layer as the thing to restore. That is the bug this
 * shape prevents, and it is why `clear` is exact rather than approximately right.
 *
 * A ghost object is left alone: it is already not drawn, and masking it would make `clear` restore
 * it into view.
 */
export function createIsolation(deps: IsolationDeps): Isolation {
  let masked = new Map<{ layerMask: number }, number>();

  return {
    apply(keepIds) {
      const scene = deps.scene();
      const keep = new Set(keepIds.flatMap((id) => logicalObjectPartIds(id, scene.objects)));
      for (const partId of Object.keys(scene.objects)) {
        if (keep.has(partId) || scene.objects[partId]?.isGhost) continue;
        for (const mesh of deps.meshesOf(partId)) {
          if (!masked.has(mesh)) masked.set(mesh, mesh.layerMask);
          mesh.layerMask = ISOLATION_LAYER_BIT;
        }
      }
    },
    clear() {
      for (const [mesh, original] of masked) mesh.layerMask = original;
      masked = new Map();
    },
  };
}
