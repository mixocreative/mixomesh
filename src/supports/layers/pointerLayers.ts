/**
 * Pointer-following support layers (plan P3.3, D14): the ghost tip where a click adds a support,
 * the remove ring around the pointer, and the screen-space brush ring (a circle of N CSS px around
 * the pointer). Callers only store the latest pointer / hover; the meshes are placed by Babylon
 * before each frame (`update`), never through React or state.
 */
import type { Point2 } from '@mixo-geocore/editing/screenBrush';
import { ENGINE_MM_PER_BU, type Vec3 } from '../frame';
import type { BabylonViewportPort } from '../BabylonViewportPort';
import { overlayMaterial } from './materials';
import { tagSupportLayer } from './supportLayerTag.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */

/** Rendering group drawn after the scene with its own depth clear: rings stay on top of the model. */
export const ON_TOP_GROUP = 2;

export interface Hover {
  /** Babylon world point on the surface and the outward normal there. */
  point: Vec3;
  normal: Vec3;
}

function turnYTo(B: any, normal: Readonly<Vec3>): any {
  const n = new B.Vector3(normal[0], normal[1], normal[2]);
  if (n.lengthSquared() === 0) return B.Quaternion.Identity();
  n.normalize();
  const up = new B.Vector3(0, 1, 0);
  const d = B.Vector3.Dot(up, n);
  if (d > 1 - 1e-9) return B.Quaternion.Identity();
  if (d < -1 + 1e-9) return B.Quaternion.RotationAxis(new B.Vector3(1, 0, 0), Math.PI);
  const axis = B.Vector3.Cross(up, n).normalize();
  return B.Quaternion.RotationAxis(axis, Math.acos(d));
}

export class PointerLayers {
  readonly ghost: any;
  readonly ring: any;
  readonly brush: any;
  private ghostHover: (Hover & { lengthMm: number; diameterMm: number }) | undefined;
  private ringHover: (Hover & { radiusMm: number }) | undefined;
  private brushPx: number | undefined;
  private pointer: Point2 | undefined;

  constructor(private readonly B: any, scene: any, root: any) {
    // Unit cone along +Y, its point at y = -0.5 (the end that touches the surface).
    this.ghost = B.MeshBuilder.CreateCylinder('mx-support-ghost-tip', { height: 1, diameterTop: 1, diameterBottom: 0.15, tessellation: 16 }, scene);
    this.ghost.material = overlayMaterial(B, scene, 'ghost', '#4f9d69', 0.55);
    this.ring = B.MeshBuilder.CreateTorus('mx-support-remove-ring', { diameter: 2, thickness: 0.06, tessellation: 48 }, scene);
    this.ring.material = overlayMaterial(B, scene, 'remove-ring', '#c2410c', 0.9, true);
    this.ring.renderingGroupId = ON_TOP_GROUP;
    this.brush = B.MeshBuilder.CreateTorus('mx-support-brush-ring', { diameter: 2, thickness: 0.04, tessellation: 64 }, scene);
    this.brush.material = overlayMaterial(B, scene, 'brush-ring', '#2f6f9f', 0.95, true);
    this.brush.renderingGroupId = ON_TOP_GROUP;
    for (const [mesh, layer] of [[this.ghost, 'ghost'], [this.ring, 'remove-ring'], [this.brush, 'brush-ring']] as const) {
      mesh.parent = root;
      mesh.rotationQuaternion = B.Quaternion.Identity();
      tagSupportLayer(mesh, layer);
      mesh.setEnabled(false);
    }
  }

  /** Ghost tip at the pointer's surface point (sizes mm); undefined hides it. */
  setGhostTip(hover: (Hover & { lengthMm: number; diameterMm: number }) | undefined): void {
    this.ghostHover = hover;
  }

  /** Remove ring on the surface around the pointer (reach in mm); undefined hides it. */
  setRemoveRing(hover: (Hover & { radiusMm: number }) | undefined): void {
    this.ringHover = hover;
  }

  /** Brush ring radius in CSS px; undefined hides it. */
  setBrush(radiusPx: number | undefined, color?: string): void {
    this.brushPx = radiusPx && radiusPx > 0 ? radiusPx : undefined;
    if (color) this.brush.material.emissiveColor = this.B.Color3.FromHexString(color);
  }

  /** Latest pointer position, CSS px in the canvas; undefined when the pointer left. */
  setPointer(point: Point2 | undefined): void {
    this.pointer = point;
  }

  /** Place everything for the coming frame. */
  update(port: BabylonViewportPort, camera: any): void {
    const B = this.B;
    const g = this.ghostHover;
    this.ghost.setEnabled(!!g);
    if (g) {
      const len = g.lengthMm / ENGINE_MM_PER_BU;
      const dia = g.diameterMm / ENGINE_MM_PER_BU;
      this.ghost.position.set(g.point[0] + g.normal[0] * len / 2, g.point[1] + g.normal[1] * len / 2, g.point[2] + g.normal[2] * len / 2);
      // The thin end (local -Y) sits on the surface; local +Y points along the outward normal.
      this.ghost.rotationQuaternion.copyFrom(turnYTo(B, g.normal));
      this.ghost.scaling.set(dia, len, dia);
    }
    const r = this.ringHover;
    this.ring.setEnabled(!!r);
    if (r) {
      const radius = r.radiusMm / ENGINE_MM_PER_BU;
      this.ring.position.set(r.point[0], r.point[1], r.point[2]);
      this.ring.rotationQuaternion.copyFrom(turnYTo(B, r.normal));
      this.ring.scaling.set(radius, radius, radius);
    }
    const showBrush = this.brushPx !== undefined && this.pointer !== undefined && !!camera;
    this.brush.setEnabled(showBrush);
    if (showBrush) this.placeBrush(port, camera, this.pointer!, this.brushPx!);
  }

  /**
   * A circle of `px` CSS pixels around the pointer: centred on the pointer ray a fixed distance in
   * front of the eye, facing the camera, its radius the world size of `px` at that depth.
   */
  private placeBrush(port: BabylonViewportPort, camera: any, pointer: Point2, px: number): void {
    const B = this.B;
    const center = port.screenToRay(pointer);
    const edge = port.screenToRay([pointer[0] + px, pointer[1]]);
    if (!center || !edge) {
      this.brush.setEnabled(false);
      return;
    }
    const forward = camera.getDirection(new B.Vector3(0, 0, 1)).normalize();
    const depth = Math.max(camera.minZ * 4, 1e-3);
    const along = (ray: { origin: Vec3; direction: Vec3 }) => {
      // Point of the ray on the plane `depth` in front of the eye, perpendicular to the view axis.
      const o = new B.Vector3(...ray.origin);
      const d = new B.Vector3(...ray.direction);
      const eye = camera.globalPosition;
      const planeT = (depth - B.Vector3.Dot(o.subtract(eye), forward)) / Math.max(1e-9, B.Vector3.Dot(d, forward));
      return o.add(d.scale(planeT));
    };
    const c = along(center as { origin: Vec3; direction: Vec3 });
    const e = along(edge as { origin: Vec3; direction: Vec3 });
    const radius = B.Vector3.Distance(c, e);
    this.brush.position.copyFrom(c);
    this.brush.rotationQuaternion.copyFrom(turnYTo(B, [forward.x, forward.y, forward.z]));
    this.brush.scaling.set(radius, radius, radius);
  }

  /** Brush ring centre and radius in CSS px as drawn (smoke check). */
  brushOnScreen(port: BabylonViewportPort): { center: Point2; radiusPx: number } | undefined {
    if (!this.brush.isEnabled()) return undefined;
    this.brush.computeWorldMatrix(true);
    const p = this.brush.getAbsolutePosition();
    const center = port.worldToScreen([p.x, p.y, p.z]);
    if (!center) return undefined;
    // A point on the ring: local +X (torus in the local XZ plane) scaled by the radius.
    const local = new this.B.Vector3(1, 0, 0);
    const world = this.B.Vector3.TransformCoordinates(local, this.brush.getWorldMatrix());
    const rim = port.worldToScreen([world.x, world.y, world.z]);
    return rim ? { center, radiusPx: Math.hypot(rim[0] - center[0], rim[1] - center[1]) } : undefined;
  }

  dispose(): void {
    this.ghost.dispose();
    this.ring.dispose();
    this.brush.dispose();
  }
}
