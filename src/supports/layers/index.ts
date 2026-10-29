/**
 * Support layers of the mixomesh viewport (plan 2026-10-29 P3.3): one root per scene, under it the
 * support mesh per object (materials per part kind, stale grey, tips only, selection / removal
 * highlight), the zone stamp overlay per object, and the pointer layers (ghost tip, remove ring,
 * screen-space brush ring). Every node is D20-tagged (supportLayerTag.js) and the root is what PNG /
 * video renders disable. Per-frame placement (lead follow, pointer layers) runs in one
 * `onBeforeRenderObservable` observer (D14); callers only hand over the latest values.
 *
 * Multi-part logical objects: a layer follows the LEAD's translation only. The parts' positions
 * relative to the lead are part of the source hash (sceneSource `leadLocalParts`), so a part that
 * moves on its own makes the supports stale instead of needing a layer of its own (model.ts).
 */
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import type { ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import type { Point2 } from '@mixo-geocore/editing/screenBrush';
import { contactToRemove } from '@mixo-geocore/editing/removal';
import { sharedSession } from '@mixo-geocore/host/workers/geometryClient';
import type { Vec3 } from '../frame';
import { BabylonViewportPort, SessionPickMeshes, anchorOffset, babylonToSupport, type PickSession, type SupportAnchor } from '../BabylonViewportPort';
import { PointerLayers, type Hover } from './pointerLayers';
import { SupportMeshLayer, type PreviewMode } from './supportMeshLayer';
import { ZoneOverlayLayer } from './zoneOverlay';
import { supportMaterials } from './materials';
import { registerSupportLayerRoot, tagSupportLayer } from './supportLayerTag.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */

export { isSupportLayerMesh, withoutSupportLayers, hideSupportLayers } from './supportLayerTag.js';
export type { PreviewMode } from './supportMeshLayer';

export interface SupportLayersOptions {
  /** Babylon namespace (default the window global). */
  babylon?: any;
  /** Babylon world position of a lead now. */
  leadPosition: (objectId: string) => Vec3 | undefined;
  /** Engine session for picks (default the shared main-thread session). */
  session?: () => PickSession | undefined;
  cssSize?: () => { width: number; height: number };
}

export class SupportLayers {
  readonly root: any;
  readonly port: BabylonViewportPort;
  readonly picks: SessionPickMeshes;
  private readonly B: any;
  private readonly supports = new Map<string, SupportMeshLayer>();
  private readonly zones = new Map<string, ZoneOverlayLayer>();
  private readonly pointer: PointerLayers;
  private readonly observer: any;
  private previewMode: PreviewMode = 'FULL';
  private editing: string | undefined;
  private supportVersion = new Map<string, number>();
  private detachPointer: (() => void) | undefined;

  constructor(readonly scene: any, private readonly options: SupportLayersOptions) {
    const B = (this.B = options.babylon ?? (globalThis as any).BABYLON);
    this.root = new B.TransformNode('mx-support-layers', scene);
    tagSupportLayer(this.root, 'root');
    registerSupportLayerRoot(this.root);
    this.picks = new SessionPickMeshes(options.session ?? (() => sharedSession() as unknown as PickSession | undefined));
    this.port = new BabylonViewportPort({
      camera: () => scene.activeCamera,
      leadPosition: options.leadPosition,
      picks: this.picks,
      ...(options.cssSize ? { cssSize: options.cssSize } : {}),
      brushFrame: () => {
        const id = this.editing;
        const anchor = id ? this.supports.get(id)?.anchor ?? this.zones.get(id)?.anchor : undefined;
        return id && anchor ? { objectId: id, anchor } : undefined;
      },
    });
    this.pointer = new PointerLayers(B, scene, this.root);
    supportMaterials(B, scene);
    this.observer = scene.onBeforeRenderObservable.add(() => this.beforeRender());
  }

  /** The object whose support frame the brush view maps (Support Mode's current object). */
  setEditingObject(objectId: string | undefined): void {
    this.editing = objectId;
  }

  // ── support mesh ──

  /** Draw (or replace) the supports of `objectId`: support-local mesh and the anchor it was built at. */
  setSupports(objectId: string, built: GeneratedSupportMesh, anchor: SupportAnchor, { stale = false }: { stale?: boolean } = {}): SupportMeshLayer {
    let layer = this.supports.get(objectId);
    if (!layer) this.supports.set(objectId, (layer = new SupportMeshLayer(this.B, this.scene, this.root, objectId)));
    layer.setStale(stale);
    layer.setPreviewMode(this.previewMode);
    layer.set(built, anchor);
    this.supportVersion.set(objectId, (this.supportVersion.get(objectId) ?? 0) + 1);
    this.picks.release(`supports:${objectId}`);
    layer.follow(anchorOffset(anchor, this.options.leadPosition(objectId)));
    return layer;
  }

  removeSupports(objectId: string): void {
    this.supports.get(objectId)?.dispose();
    this.supports.delete(objectId);
    this.picks.release(`supports:${objectId}`);
  }

  setStale(objectId: string, stale: boolean): void {
    this.supports.get(objectId)?.setStale(stale);
  }

  setPreviewMode(mode: PreviewMode): void {
    this.previewMode = mode;
    for (const layer of this.supports.values()) layer.setPreviewMode(mode);
  }

  /** Selected supports (contact ids) of an object, highlighted in place. */
  setSelection(objectId: string, ids: Iterable<string>): void {
    const layer = this.supports.get(objectId);
    layer?.setHighlight(ids, layer.removingIds());
  }

  supportLayer(objectId: string): SupportMeshLayer | undefined {
    return this.supports.get(objectId);
  }

  /** Session handle of the drawn support mesh of an object (loaded once per build). */
  supportPickHandle(objectId: string): number | undefined {
    const layer = this.supports.get(objectId);
    if (!layer?.built || !layer.anchor) return undefined;
    const built = layer.built;
    const anchor = layer.anchor;
    return this.picks.handle(`supports:${objectId}`, String(this.supportVersion.get(objectId) ?? 0), () => ({
      objectId, anchor, mesh: { positions: built.positions, indices: built.indices }, side: 2,
    }));
  }

  // ── zones ──

  /** The no-support zones of an object over its support-frame model. */
  setZones(objectId: string, model: { positions: Float32Array; indices: Uint32Array }, anchor: SupportAnchor, version: string, stamps: readonly ZoneStamp[]): ZoneOverlayLayer {
    let layer = this.zones.get(objectId);
    if (!layer) this.zones.set(objectId, (layer = new ZoneOverlayLayer(this.B, this.scene, this.root, objectId)));
    layer.setModel(model, anchor, version);
    layer.setStamps(stamps);
    layer.follow(anchorOffset(anchor, this.options.leadPosition(objectId)));
    return layer;
  }

  zoneLayer(objectId: string): ZoneOverlayLayer | undefined {
    return this.zones.get(objectId);
  }

  removeZones(objectId: string): void {
    this.zones.get(objectId)?.dispose();
    this.zones.delete(objectId);
  }

  // ── pointer layers (latest values only; placed before the next frame) ──

  setPointer(point: Point2 | undefined): void {
    this.pointer.setPointer(point);
  }

  /**
   * Feed the pointer layers from the canvas's own pointer events (CSS px in the canvas). The
   * listeners only store the position; the brush ring is placed before the next frame (D14).
   */
  attachPointer(canvas: HTMLElement | null | undefined): void {
    this.detachPointer?.();
    this.detachPointer = undefined;
    if (!canvas?.addEventListener) return;
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.setPointer([e.clientX - r.left, e.clientY - r.top]);
    };
    const leave = () => this.pointer.setPointer(undefined);
    canvas.addEventListener('pointermove', move, { passive: true });
    canvas.addEventListener('pointerleave', leave, { passive: true });
    this.detachPointer = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
    };
  }

  setBrush(radiusPx: number | undefined, color?: string): void {
    this.pointer.setBrush(radiusPx, color);
  }

  setGhostTip(hover: (Hover & { lengthMm: number; diameterMm: number }) | undefined): void {
    this.pointer.setGhostTip(hover);
  }

  /**
   * The remove ring at a surface point of `objectId` and the support a click there would take
   * (`contactToRemove` within `radiusMm`, support frame) highlighted; returns that contact id.
   */
  setRemoveRing(objectId: string, hover: (Hover & { radiusMm: number }) | undefined, contacts: readonly { id: string; position: readonly number[] }[] = []): string | undefined {
    this.pointer.setRemoveRing(hover);
    const layer = this.supports.get(objectId);
    if (!layer) return undefined;
    let doomed: string | undefined;
    if (hover && layer.anchor) {
      const local = babylonToSupport(hover.point, layer.anchor, anchorOffset(layer.anchor, this.options.leadPosition(objectId)));
      doomed = contactToRemove(contacts, local, hover.radiusMm)?.id;
    }
    layer.setHighlight(layer.selectedIds(), doomed ? [doomed] : []);
    return doomed;
  }

  /** Brush ring as drawn this frame, CSS px (smoke). */
  brushOnScreen(): { center: Point2; radiusPx: number } | undefined {
    return this.pointer.brushOnScreen(this.port);
  }

  pointerMeshes(): { ghost: any; ring: any; brush: any } {
    return { ghost: this.pointer.ghost, ring: this.pointer.ring, brush: this.pointer.brush };
  }

  /** Every mesh under the root (tests, culling toggles). */
  meshes(): any[] {
    return this.root.getChildMeshes(false);
  }

  setCulling(on: boolean): void {
    for (const m of supportMaterials(this.B, this.scene).all) m.backFaceCulling = on;
  }

  private beforeRender(): void {
    for (const [id, layer] of this.supports) if (layer.anchor) layer.follow(anchorOffset(layer.anchor, this.options.leadPosition(id)));
    for (const [id, layer] of this.zones) if (layer.anchor) layer.follow(anchorOffset(layer.anchor, this.options.leadPosition(id)));
    this.pointer.update(this.port, this.scene.activeCamera);
  }

  dispose(): void {
    this.detachPointer?.();
    this.scene.onBeforeRenderObservable.remove(this.observer);
    this.picks.clear();
    for (const id of [...this.supports.keys()]) this.removeSupports(id);
    for (const id of [...this.zones.keys()]) this.removeZones(id);
    this.pointer.dispose();
    this.root.dispose();
  }
}

let instance: SupportLayers | undefined;

/** The app's support layers on the SceneManager scene (made on first use). */
export async function appSupportLayers(): Promise<SupportLayers> {
  const [{ SceneManager }, { leadPosition }] = await Promise.all([import('../../core/SceneManager.js'), import('../objectModel')]);
  const scene = SceneManager.getScene();
  if (!instance || instance.scene !== scene || instance.root.isDisposed?.()) {
    instance = new SupportLayers(scene, { leadPosition });
    instance.attachPointer(scene.getEngine().getRenderingCanvas());
  }
  return instance;
}
