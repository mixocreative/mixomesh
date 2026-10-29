import { nextStamp, stampsAlong } from '../host/core/supports/zones';
import type { Vector } from '../host/core/vec3';

/**
 * Brush centres for one pointer hit, given the last centre laid in this stroke (undefined at its
 * start). The last centre returned becomes the reference for the next hit.
 */
export type StrokeFill = (last: Vector | undefined, point: Vector) => Vector[];

/**
 * One brush stroke (Drag over select, zone painting): from a left press until the button is
 * released anywhere, the pointer is cancelled, the window loses focus, or a move arrives with no
 * button held (a release the window never saw). The host wires its pointer and window events to
 * `begin` / `move` / `end` and turns its camera orbit off for the stroke; `onEnd` runs once per
 * stroke, when it ends.
 */
export interface Stroke {
  readonly active: boolean;
  /** A press: only the left button (0) strokes. A stroke still open ends first. */
  begin(button: number): boolean;
  /** A pointer move: `sample` while the left button is held, `end` when it no longer is, `idle` outside a stroke. */
  move(leftHeld: boolean): 'sample' | 'end' | 'idle';
  /** Ends the stroke; false when none was open (end is idempotent). */
  end(): boolean;
  /** Brush centres for a hit at `point` (none outside a stroke), the gap since the last one filled by `fill`. */
  samples(point: Vector, fill: StrokeFill): Vector[];
}

/** Builds a closed stroke; `onEnd` runs once each time an open stroke ends. */
export function createStroke(onEnd?: () => void): Stroke {
  let active = false;
  let last: Vector | undefined;
  const stroke: Stroke = {
    get active() { return active; },
    begin(button) {
      if (button !== 0) return false;
      stroke.end();
      active = true;
      return true;
    },
    move(leftHeld) {
      if (!active) return 'idle';
      if (leftHeld) return 'sample';
      stroke.end();
      return 'end';
    },
    end() {
      if (!active) return false;
      active = false;
      last = undefined;
      onEnd?.();
      return true;
    },
    samples(point, fill) {
      if (!active) return [];
      const centres = fill(last, point);
      if (centres.length > 0) last = centres[centres.length - 1];
      return centres;
    },
  };
  return stroke;
}

/** Zone brush: a stamp once the brush moved half a radius from the last one, the gap filled. */
export function zoneFill(radius: number): StrokeFill {
  return (last, point) => {
    if (!nextStamp(last, point, radius)) return [];
    return last ? [...stampsAlong(last, point, radius), point] : [point];
  };
}
