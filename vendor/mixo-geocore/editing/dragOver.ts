import type { Brush, BrushScheduler } from './brushScheduler';
import type { Stroke } from './stroke';
import type { Point } from './strokeQueue';
import type { BrushMode } from './types';

/**
 * A pointer move: whether the left button is held, whether the pointer is over the canvas, and
 * whether it is over the model or a support (the places a stroke may start).
 */
export interface PointerState {
  held: boolean;
  onCanvas: boolean;
  onObject: boolean;
}

/**
 * Drag over's pointer rules (framework-free): what a press, a move and a leave mean for the stroke
 * and the frame loop. The host turns its events into canvas points, passes the brush as it is now,
 * and shows the circle where these say it shows.
 */
export interface DragOver {
  /**
   * A press: the left button starts a stroke (`onStrokeStart`) sampled first at `at`, when it
   * lands on the model or a support (`onObject`). False for other buttons and for a press on
   * empty space, which is left to the camera: it orbits. The stroke does what `brush.mode` says
   * at the press, whatever the brush says on its later moves (Shift pressed mid-stroke changes nothing).
   */
  down(button: number, at: Point, brush: Brush, onObject: boolean): boolean;
  /**
   * A move: samples the stroke while the left button is held, otherwise previews a hover. False
   * outside a stroke when the pointer is off the canvas or off the model and its supports, or the
   * button is held on an orbit (the hover is cleared and the circle hides). A stroke keeps going
   * off the canvas and off the model.
   */
  move(at: Point, pointer: PointerState, brush: Brush): boolean;
  /** The pointer left the canvas: outside a stroke the hover is cleared and the circle hides (false). */
  leave(): boolean;
}

/**
 * Wires the pointer rules to a `Stroke` (button state) and a `BrushScheduler` (hit tests).
 * `onStrokeStart` runs once per stroke, before its first sample (the host uses it to open one
 * undo step for the whole stroke, for example).
 */
export function createDragOver(stroke: Stroke, scheduler: BrushScheduler, onStrokeStart: () => void): DragOver {
  // The brush mode at the press; every sample of the stroke uses it, even if Shift changes later.
  let latched: BrushMode = 'select';
  return {
    down(button, at, brush, onObject) {
      // A press on empty space belongs to the camera; end any stroke left open so it cannot resume.
      if (!onObject) {
        stroke.end();
        return false;
      }
      if (!stroke.begin(button)) return false;
      latched = brush.mode;
      onStrokeStart();
      scheduler.press();
      scheduler.sample(at, brush);
      return true;
    },
    move(at, { held, onCanvas, onObject }, brush) {
      // Outside a stroke, a held button means the camera is orbiting: no hover circle then.
      if (!stroke.active && (!onCanvas || !onObject || held)) {
        scheduler.clearHover();
        return false;
      }
      const state = stroke.move(held);
      // The radius follows the slider live; only the mode is latched.
      if (state === 'sample') scheduler.sample(at, brush.mode === latched ? brush : { radius: brush.radius, mode: latched });
      else if (state === 'idle') scheduler.hover(at, brush);
      return true;
    },
    leave() {
      if (stroke.active) return true;
      scheduler.clearHover();
      return false;
    },
  };
}
