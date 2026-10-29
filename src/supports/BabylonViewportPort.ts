/**
 * `ViewportPort` (mixo-geocore editing, D22) over the mixomesh Babylon camera and canvas
 * (plan 2026-10-29 P3.3). Screen points are CSS pixels inside the canvas; rays, hits and world
 * points are Babylon world space (BU, left-handed). The drawing buffer may be larger than the CSS
 * box (device pixel ratio, AdaptiveResolution's hardware scaling): every conversion goes through
 * normalised device coordinates, so it holds at any ratio.
 *
 * Picking never uses Babylon's own picking: a ray goes into the support frame of the mesh it is
 * cast at (frame.ts: engine mm, right-handed, object-local) and the engine session answers
 * (`GeometrySession.pick`, the port of mixosupports' `rustRaycast`). A session mesh is loaded once
 * per geometry version (`SessionPickMeshes`).
 *
 * Support frame of an object (model.ts): s = E(b) - center, E = frame.ts `pointToEngine`, at the
 * moment the anchor was taken. The lead may translate afterwards (translation never makes supports
 * stale), so a Babylon point is b = E^-1(s + center) + (leadNow - anchor.lead).
 */
import type { PointerRecord, SurfacePick, ViewportPort, ViewportSize, ViewRay } from '@mixo-geocore/editing/ViewportPort';
import type { BrushView, Point2 } from '@mixo-geocore/editing/screenBrush';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import type { Vector } from '@mixo-geocore/host/core/vec3';
import { ENGINE_MM_PER_BU, normalFromEngine, normalToEngine, pointFromEngine, pointToEngine, type Vec3 } from './frame';

// ── support frame anchor ─────────────────────────────────

/** Where a support frame sat when its mesh was made: its engine-frame centre and the lead's Babylon position then. */
export interface SupportAnchor {
  center: Vec3;
  lead: Vec3;
}

/** Babylon translation of the lead since the anchor was taken. */
export function anchorOffset(anchor: SupportAnchor, leadNow: Readonly<Vec3> | undefined): Vec3 {
  if (!leadNow) return [0, 0, 0];
  return [leadNow[0] - anchor.lead[0], leadNow[1] - anchor.lead[1], leadNow[2] - anchor.lead[2]];
}

/** Support-local point (engine mm) to Babylon world (BU). */
export function supportToBabylon(s: Readonly<Vec3>, anchor: SupportAnchor, offset: Readonly<Vec3>): Vec3 {
  const b = pointFromEngine([s[0] + anchor.center[0], s[1] + anchor.center[1], s[2] + anchor.center[2]]);
  return [b[0] + offset[0], b[1] + offset[1], b[2] + offset[2]];
}

/** Babylon world point (BU) to support-local (engine mm). */
export function babylonToSupport(b: Readonly<Vec3>, anchor: SupportAnchor, offset: Readonly<Vec3>): Vec3 {
  const e = pointToEngine([b[0] - offset[0], b[1] - offset[1], b[2] - offset[2]]);
  return [e[0] - anchor.center[0], e[1] - anchor.center[1], e[2] - anchor.center[2]];
}

/**
 * Support-local to Babylon world as a Babylon (row-vector) matrix, `m[12..14]` the translation;
 * read as column-major it is the same map for column vectors (BrushView's convention).
 */
export function supportToBabylonMatrix(anchor: SupportAnchor, offset: Readonly<Vec3>): Float64Array {
  const k = 1 / ENGINE_MM_PER_BU;
  const origin = supportToBabylon([0, 0, 0], anchor, offset);
  return Float64Array.of(
    k, 0, 0, 0,
    0, k, 0, 0,
    0, 0, -k, 0,
    origin[0], origin[1], origin[2], 1,
  );
}

// ── 4x4 helpers (Babylon row-vector layout: p' = p * M, m[row * 4 + col]) ──

type Mat = ArrayLike<number>;

export function multiply(a: Mat, b: Mat): Float64Array {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k]! * b[k * 4 + c]!;
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

export function invert(m: Mat): Float64Array | undefined {
  const a = Array.from({ length: 16 }, (_, i) => m[i]!);
  const inv = new Float64Array(16);
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return undefined;
  for (let i = 0; i < 16; i++) inv[i] = inv[i]! / det;
  return inv;
}

/** [x, y, z, 1] * M as homogeneous [x, y, z, w]. */
export function transform4(p: Readonly<Vec3>, m: Mat): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) out[c] = p[0] * m[c]! + p[1] * m[4 + c]! + p[2] * m[8 + c]! + m[12 + c]!;
  return out;
}

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v: Readonly<Vec3>): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

// ── session pick meshes ──────────────────────────────────

/** What `GeometrySession` offers the port (the vendored engine's session, or a test double). */
export interface PickSession {
  load_mesh(positions: Float32Array, indices: Uint32Array): number;
  release_mesh(handle: number): void;
  pick(handle: number, rays: Float64Array, near: number, far: number, side: number): Float64Array;
}

/** A session mesh in a support frame, with what the port needs to answer picks on it. */
export interface PickTarget {
  /** The object (logical lead) whose support frame the mesh is in. */
  objectId: string;
  anchor: SupportAnchor;
  /** Support-local engine geometry, the copy loaded in the session (normals of hits come from it). */
  mesh: TriangleMesh;
  /** 0 front, 1 back, 2 double sided. */
  side: number;
}

/**
 * Meshes loaded into the engine session for picking, one per (key, version): a mesh is loaded
 * (and its pick index built, lazily by the engine on its first pick) once per geometry version and
 * released when the version changes or the key is dropped.
 */
export class SessionPickMeshes {
  private readonly byKey = new Map<string, { version: string; handle: number }>();
  private readonly targets = new Map<number, PickTarget>();

  constructor(readonly session: () => PickSession | undefined) {}

  /** The handle of `key` at `version`; `make` runs only when the version changed. Undefined without a session. */
  handle(key: string, version: string, make: () => PickTarget | undefined): number | undefined {
    const hit = this.byKey.get(key);
    if (hit && hit.version === version) return hit.handle;
    const session = this.session();
    if (!session) return undefined;
    this.release(key);
    const target = make();
    if (!target || target.mesh.indices.length === 0) return undefined;
    const handle = session.load_mesh(Float32Array.from(target.mesh.positions), Uint32Array.from(target.mesh.indices));
    this.byKey.set(key, { version, handle });
    this.targets.set(handle, target);
    return handle;
  }

  target(handle: number): PickTarget | undefined {
    return this.targets.get(handle);
  }

  /** Re-anchor a loaded mesh (its geometry unchanged). */
  setAnchor(handle: number, anchor: SupportAnchor): void {
    const target = this.targets.get(handle);
    if (target) target.anchor = anchor;
  }

  release(key: string): void {
    const hit = this.byKey.get(key);
    if (!hit) return;
    this.byKey.delete(key);
    this.targets.delete(hit.handle);
    try { this.session()?.release_mesh(hit.handle); } catch { /* session already gone */ }
  }

  clear(): void {
    for (const key of [...this.byKey.keys()]) this.release(key);
  }

  get size(): number {
    return this.byKey.size;
  }
}

// ── the port ─────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon objects come untyped from the window global */
export interface BabylonViewportPortOptions {
  /** The camera rays come from (default: the scene's active camera, read per call). */
  camera: () => any;
  /** The canvas CSS box; default `canvas.getBoundingClientRect()` of the engine's canvas. */
  cssSize?: () => { width: number; height: number };
  /** Babylon world position of a lead now (support layers follow its translation). */
  leadPosition: (objectId: string) => Vec3 | undefined;
  picks: SessionPickMeshes;
  /** The support frame `brushView` maps (the object being edited). */
  brushFrame?: () => { anchor: SupportAnchor; objectId: string } | undefined;
}

export class BabylonViewportPort implements ViewportPort {
  constructor(private readonly options: BabylonViewportPortOptions) {}

  private camera(): any {
    return this.options.camera();
  }

  private engine(): any {
    return this.camera()?.getScene?.()?.getEngine?.();
  }

  size(): ViewportSize {
    const engine = this.engine();
    const renderWidth = engine?.getRenderWidth?.() ?? 0;
    const renderHeight = engine?.getRenderHeight?.() ?? 0;
    const css = this.options.cssSize?.() ?? engine?.getRenderingCanvas?.()?.getBoundingClientRect?.();
    const width = css?.width || renderWidth;
    const height = css?.height || renderHeight;
    return { width, height, devicePixelRatio: width > 0 && renderWidth > 0 ? renderWidth / width : 1 };
  }

  /** The camera's world -> clip matrix (view * projection), or undefined without a camera. */
  private viewProjection(): ArrayLike<number> | undefined {
    const camera = this.camera();
    if (!camera) return undefined;
    // Fresh view and projection (the cached transformation matrix is only refreshed by a render).
    return multiply(camera.getViewMatrix(true).m, camera.getProjectionMatrix(true).m);
  }

  screenToRay(point: Point2): ViewRay | undefined {
    const camera = this.camera();
    const vp = this.viewProjection();
    const { width, height } = this.size();
    if (!camera || !vp || !(width > 0) || !(height > 0)) return undefined;
    const inverse = invert(vp);
    if (!inverse) return undefined;
    const x = (2 * point[0]) / width - 1;
    const y = 1 - (2 * point[1]) / height;
    const near = this.engine()?.isNDCHalfZRange ? 0 : -1;
    const unproject = (z: number): Vec3 | undefined => {
      const h = transform4([x, y, z], inverse);
      return h[3] !== 0 && Number.isFinite(h[3]) ? [h[0] / h[3], h[1] / h[3], h[2] / h[3]] : undefined;
    };
    const a = unproject(near);
    const b = unproject(1);
    if (!a || !b) return undefined;
    const direction = unit(sub(b, a));
    if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) return undefined;
    // Perspective rays start at the eye; orthographic ones on the camera plane through the eye.
    const eye: Vec3 = [camera.globalPosition.x, camera.globalPosition.y, camera.globalPosition.z];
    const t = dot3(sub(eye, a), direction);
    return { origin: [a[0] + direction[0] * t, a[1] + direction[1] * t, a[2] + direction[2] * t], direction };
  }

  worldToScreen(point: Vector): Point2 | undefined {
    const vp = this.viewProjection();
    const { width, height } = this.size();
    if (!vp) return undefined;
    const [x, y, , w] = transform4(point, vp);
    if (!(w > 0)) return undefined;
    return [((x / w + 1) / 2) * width, ((1 - y / w) / 2) * height];
  }

  pick(handle: number, ray: ViewRay): SurfacePick | undefined {
    const target = this.options.picks.target(handle);
    const session = target && this.options.picks.session();
    if (!target || !session) return undefined;
    const offset = anchorOffset(target.anchor, this.options.leadPosition(target.objectId));
    const origin = babylonToSupport(ray.origin as Vec3, target.anchor, offset);
    const direction = unit(normalToEngine(ray.direction as Vec3));
    const out = session.pick(handle, Float64Array.of(...origin, ...direction), 0, Infinity, target.side);
    const face = out[0]!;
    if (!(face >= 0)) return undefined;
    const hit: Vec3 = [out[2]!, out[3]!, out[4]!];
    return {
      point: supportToBabylon(hit, target.anchor, offset),
      normal: normalFromEngine(faceNormal(target.mesh, face)),
      triangle: face,
      distance: out[1]! / ENGINE_MM_PER_BU,
    };
  }

  brushView(): BrushView {
    const { width, height } = this.size();
    const frame = this.options.brushFrame?.();
    const camera = this.camera();
    const vp = this.viewProjection();
    if (!frame || !camera || !vp) return { clip: new Float64Array(16), eye: [0, 0, 0], width, height };
    const offset = anchorOffset(frame.anchor, this.options.leadPosition(frame.objectId));
    const clip = multiply(supportToBabylonMatrix(frame.anchor, offset), vp);
    const g = camera.globalPosition;
    const eye = babylonToSupport([g.x, g.y, g.z], frame.anchor, offset);
    return { clip, eye, width, height };
  }

  /** A DOM pointer event as editing's record, CSS px relative to the canvas. */
  pointerRecord(event: PointerEvent, canvas: { getBoundingClientRect(): { left: number; top: number } }): PointerRecord {
    const r = canvas.getBoundingClientRect();
    return {
      pointerId: event.pointerId,
      x: event.clientX - r.left,
      y: event.clientY - r.top,
      button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
      buttons: event.buttons,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      timeStamp: event.timeStamp,
    };
  }
}

/** Unit outward normal of face `face` of an engine-frame mesh (counter-clockwise outward, right-handed). */
export function faceNormal(mesh: TriangleMesh, face: number): Vec3 {
  const p = mesh.positions;
  const i = mesh.indices;
  const at = (v: number): Vec3 => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
  const a = at(i[face * 3]!);
  const b = at(i[face * 3 + 1]!);
  const c = at(i[face * 3 + 2]!);
  const u = sub(b, a);
  const v = sub(c, a);
  return unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
}
