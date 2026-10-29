import type { Vector } from '../host/core/vec3';

/** Viewing direction used when the camera sits on its target (the app's start view). */
const START_DIRECTION: Vector = [70, 60, 90];
/** Smallest horizontal share of the direction, so the orbit's up axis (+Y) stays defined. */
const MIN_HORIZONTAL = 1e-3;

/**
 * Unit direction from the framed centre to the camera for Fit view: the current one (target to
 * camera), the start view when there is none, and a hair off vertical when it looks straight
 * down or up, with the front of the plate at the bottom (as Bottom view does).
 */
export function fitDirection(direction: Vector): Vector {
  let [x, y, z] = direction;
  let length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) {
    [x, y, z] = START_DIRECTION;
    length = Math.hypot(x, y, z);
  }
  if (Math.hypot(x, z) < length * MIN_HORIZONTAL) {
    x = 0;
    z = Math.abs(y) * MIN_HORIZONTAL;
    length = Math.hypot(y, z);
  }
  return [x / length, y / length, z / length];
}

/** Framing margin: the framed sphere fills the view up to 1 / 1.15 of its height. */
export const FRAME_MARGIN = 1.15;
/** Smallest framed radius (mm), so a tiny object is not framed from inside its own tips. */
const MIN_FRAME_RADIUS = 1;
/** Smallest radius (mm) Show me frames around a check finding. */
export const MIN_SPOT_RADIUS = 5;

/** Orbit camera placement: camera position and the point it orbits around (looks at). */
export interface CameraView {
  position: Vector;
  target: Vector;
}

/** The bounding sphere of a box (its centre and half its diagonal), as the view frames it. */
export function boundsSphere(box: { min: Vector; max: Vector }): { center: Vector; radius: number } {
  const { min, max } = box;
  const [sx, sy, sz] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    center: [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5],
    radius: Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5,
  };
}

/**
 * Frames a sphere (the selection, or every object) for a perspective camera with vertical field
 * of view `fovDeg`: `bottom` looks straight up at it from below (a hair off vertical keeps the
 * orbit's up axis defined, front of the plate at the bottom); `fit` keeps the current viewing
 * direction (see `fitDirection`).
 */
export function frameView(bounds: { center: Vector; radius: number }, fovDeg: number, kind: 'bottom' | 'fit', current?: CameraView): CameraView {
  const { center } = bounds;
  const distance = Math.max(bounds.radius, MIN_FRAME_RADIUS) / Math.sin(fovDeg * (Math.PI / 180) / 2) * FRAME_MARGIN;
  if (kind === 'bottom') return { position: [center[0], center[1] - distance, center[2] + distance * MIN_HORIZONTAL], target: [...center] };
  const from = current ?? { position: START_DIRECTION, target: [0, 0, 0] };
  const [x, y, z] = fitDirection([from.position[0] - from.target[0], from.position[1] - from.target[1], from.position[2] - from.target[2]]);
  return { position: [center[0] + x * distance, center[1] + y * distance, center[2] + z * distance], target: [...center] };
}

/**
 * Show me on a support check finding: frames the spot from the current direction, as Fit view
 * frames objects. The spot counts as a sphere of radius √area (mm), at least 5 mm (an island has no
 * area), so a large uncovered overhang is framed whole.
 */
export function spotView(point: Vector, area: number, fovDeg: number, current: CameraView): CameraView {
  return frameView({ center: point, radius: Math.max(MIN_SPOT_RADIUS, Math.sqrt(Math.max(area, 0))) }, fovDeg, 'fit', current);
}

/** The camera is below the build plate (y = 0). */
export function belowPlate(cameraY: number): boolean {
  return cameraY < 0;
}

/**
 * Tips only: `above` is the user's choice while the camera is above the plate (off at start);
 * `belowChoice` is a choice made while below it (null: tips show, as the view from underneath
 * needs); `below` is the plate side the camera was last seen on. Going under the plate turns the
 * tips view on by itself; coming back up restores the above-plate choice untouched.
 */
export interface TipsState {
  above: boolean;
  belowChoice: boolean | null;
  below: boolean;
}

/** Start: camera above the plate, full supports. */
export const TIPS_START: TipsState = { above: false, belowChoice: null, below: false };

/** What Tips only depends on besides its state: painting zones. */
export interface TipsContext {
  /** Painting no-support zones forces the tips view. */
  zones: boolean;
}

/** The Tips only button as shown; `hint` is an i18n key. */
export interface TipsButton {
  /** Only contact tips show. */
  shown: boolean;
  /** Painting zones forces the tips view: the button reads as on and a press does nothing. */
  forced: boolean;
  hint: string;
}

/**
 * Only contact tips show: always while painting no-support zones (the tips at both ends of every
 * support sit on the surface to paint, and pillars would hide the blue layer); below the plate
 * unless switched off there; above it, the user's own choice. Zones never change the state, so
 * leaving them brings the previous view back.
 */
export function tipsButton(state: TipsState, { zones }: TipsContext): TipsButton {
  const shown = zones || (state.below ? state.belowChoice ?? true : state.above);
  const hint = zones
    ? 'While painting no-support zones only the contact tips show, so the surface stays visible.'
    : shown
      ? 'Only contact tips show. Turns on by itself below the plate; click to switch off. Export stays full.'
      : 'Show only the contact tips: no pillars, braces or raft. Turns on by itself below the plate. Export stays full.';
  return { shown, forced: zones, hint };
}

/** The camera is on the given side of the plate: going under shows the tips, coming up restores the above-plate choice. */
export function tipsCamera(state: TipsState, below: boolean): TipsState {
  return below === state.below ? state : { ...state, belowChoice: null, below };
}

/** A press on the Tips only button: flips what shows now, on the side of the plate the camera is on; nothing while forced. */
export function tipsPress(state: TipsState, context: TipsContext): TipsState {
  const button = tipsButton(state, context);
  if (button.forced) return state;
  return state.below ? { ...state, belowChoice: !button.shown } : { ...state, above: !button.shown };
}
