import type { Vector } from '../host/core/vec3';
import type { BrushView, Point2 } from './screenBrush';

/*
 * The only way editing/ reaches a 3D view (D22). Each app implements it over its own renderer
 * (Babylon in mixomesh, three.js in mixoDental); everything drawn (rings, ghost tips, overlays,
 * highlights) stays in the app. Editing code works in plain data: screen points are CSS pixels
 * inside the viewport, rays and hits are world space.
 */

/** Viewport size in CSS pixels and the device pixel ratio the drawing buffer uses. */
export interface ViewportSize {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** One pointer event, reduced to what editing needs; x and y are CSS pixels relative to the viewport. */
export interface PointerRecord {
  pointerId: number;
  x: number;
  y: number;
  button: 'left' | 'middle' | 'right';
  /** Bit mask of the buttons held, as in `PointerEvent.buttons`. */
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Milliseconds, any monotonic origin. */
  timeStamp: number;
}

/** A ray in world space; `direction` is unit length. */
export interface ViewRay {
  origin: Vector;
  direction: Vector;
}

/** A surface hit in world space; the triangle index is in the picked mesh's own index order. */
export interface SurfacePick {
  point: Vector;
  normal: Vector;
  triangle: number;
  /** Distance along the ray. */
  distance: number;
}

/**
 * What an app's viewport answers for editing code. Every method is synchronous and has no side
 * effect on the view; the brush, pick and hover helpers in this folder call it per pointer event or
 * per frame. tests/d22.test.ts checks that editing/ imports no renderer, framework or DOM module.
 */
export interface ViewportPort {
  /** Current viewport size and device pixel ratio. */
  size(): ViewportSize;
  /** The world-space ray through a screen point, or undefined when the camera cannot make one. */
  screenToRay(point: Point2): ViewRay | undefined;
  /** The screen point of a world point, or undefined when it is behind the camera. */
  worldToScreen(point: Vector): Point2 | undefined;
  /**
   * The nearest surface hit of a ray against a mesh the engine session holds (`handle` is the
   * session mesh handle). The app answers through the engine session, never through its renderer's
   * own picking, so both apps pick identically.
   */
  pick(handle: number, ray: ViewRay): SurfacePick | undefined;
  /** Clip matrix and eye for the support group, as `brushHits` takes them. */
  brushView(): BrushView;
}
