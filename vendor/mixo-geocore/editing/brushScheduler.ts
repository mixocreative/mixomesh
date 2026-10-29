import { createStrokeQueue, type BrushJob, type Point } from './strokeQueue';
import type { BrushMode } from './types';

/** The Drag over brush as one sample sees it: circle size and whether it selects or unselects. */
export interface Brush {
  /** Circle radius in screen px. */
  radius: number;
  mode: BrushMode;
}

/** One frame's hit test, bound by the host to the current projection and visibility (`brushHitsFrom`). */
export type FrameTest = (job: BrushJob, want: (id: string) => boolean, stop: () => boolean) => { hits: readonly string[]; next: number };

/** What the scheduler needs from its host (the viewport): the hit test, the selection, time and frames. */
export interface BrushPort {
  /** This frame's hit test; undefined while there is nothing to project the supports onto. */
  frame(): FrameTest | undefined;
  isSelected(id: string): boolean;
  commit(ids: readonly string[], mode: BrushMode): void;
  /** The supports a hover would change, as found so far. */
  preview(ids: readonly string[]): void;
  now(): number;
  requestFrame(run: () => void): number;
  cancelFrame(handle: number): void;
  /** After each frame of hit tests, with the time it started (dev timing). */
  measure?(started: number): void;
}

/**
 * Drag over's frame loop (framework-free). Pointer events only queue work: a stroke's samples go
 * to the `StrokeQueue`, a hover replaces the one pending hover test. Each animation frame runs at
 * most `frameBudget` ms of hit tests and carries the rest over, so a dense plate stays smooth; a
 * stroke's queue is finished in later frames even after the release.
 */
export interface BrushScheduler {
  /** A stroke starts: its samples get a fresh painted set; the hover preview is dropped. */
  press(): void;
  /** A pointer sample of the stroke, tested with `brush` as it is now. */
  sample(at: Point, brush: Brush): void;
  /** The circle rests at `at` outside a stroke: preview what `brush` would change there. */
  hover(at: Point, brush: Brush): void;
  /** The circle left the canvas. */
  clearHover(): void;
  /**
   * The supports Drag over works on: their count, or undefined when there are none or the brush
   * is off. A new count (a rebuild) restarts queued samples on the new supports; 0 (Remove
   * supports leaves an empty mesh) or undefined drops them, so they never run on the next
   * generated supports.
   */
  setSupports(count: number | undefined): void;
}

/** Fewest ms of hit tests per frame. */
const MIN_BUDGET = 8;
/** Most ms of hit tests per frame. */
const MAX_BUDGET = 100;
/** A 60 Hz frame (ms). */
const FRAME_MS = 1000 / 60;
/** Render time assumed before frames have been measured (ms). */
const FIRST_RENDER_MS = 8;

/**
 * Hit-test time for the next frame, given what rendering a frame costs now (ms): what is left of a
 * 60 Hz frame when rendering is cheap, and a quarter of the render time when frames are long
 * anyway (software GL), so the queue keeps up without changing the frame rate much; 8 to 100 ms.
 */
export function frameBudget(renderMs: number): number {
  if (!Number.isFinite(renderMs) || renderMs < 0) return MIN_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, FRAME_MS - renderMs, renderMs / 4));
}

/**
 * Builds a scheduler bound to `port`. It starts with no supports: call `setSupports` before
 * samples can be tested. At most one animation frame is requested at a time.
 */
export function createBrushScheduler(port: BrushPort): BrushScheduler {
  const queue = createStrokeQueue();
  let total = 0;
  /** The hover circle being tested (from support index `job.next`) and what it found so far. */
  let hover: { job: BrushJob; found: string[] } | undefined;
  let shown: readonly string[] = [];
  let frame = 0;
  /** When the last frame's hit tests ended, and the smoothed render time between frames (ms). */
  let lastEnd = 0;
  let renderMs = FIRST_RENDER_MS;

  // Tell the host only when the preview list really changed (same ids in the same order = no call).
  const show = (ids: readonly string[]) => {
    if (ids.length === shown.length && ids.every((id, index) => id === shown[index])) return;
    shown = ids;
    port.preview(ids);
  };
  const schedule = () => {
    if (!frame) frame = port.requestFrame(flush);
  };
  function flush() {
    frame = 0;
    if (!queue.pending && !hover) return;
    const started = port.now();
    // Time since the hit tests of the last frame is what rendering took (when frames run back to back).
    // Exponential smoothing (0.7 old / 0.3 new) so one slow frame does not swing the budget; a gap
    // over 1 s means the loop was idle, not that rendering was slow, so it is not counted.
    if (lastEnd > 0 && started - lastEnd < 1000) renderMs = renderMs * 0.7 + (started - lastEnd) * 0.3;
    const budget = frameBudget(renderMs);
    const stop = () => port.now() - started > budget;
    const test = port.frame();
    // A queued stroke has priority over the hover preview: the hover waits until the queue is empty.
    if (test && queue.pending) {
      // A stroke: the circle sweeps every queued sample. One selection commit per frame (per
      // brush mode), however many samples were tested in it.
      queue.drain(total, (step, want) => test(step, want, stop), port.commit, port.isSelected);
    } else if (test && hover) {
      const { job, found } = hover;
      const adding = job.mode === 'select';
      // The hover only previews supports the brush would change: unselected ones for Select,
      // selected ones for Unselect. It resumes from `job.next` when the budget ran out.
      const part = test(job, (id) => port.isSelected(id) !== adding, stop);
      found.push(...part.hits);
      job.next = part.next;
      show([...found]);
      if (part.next >= total) hover = undefined;
    }
    port.measure?.(started);
    lastEnd = port.now();
    if (queue.pending || hover) schedule();
  }

  return {
    press() {
      queue.begin();
      hover = undefined;
      show([]);
    },
    sample(at, brush) {
      queue.push(at, brush.mode, brush.radius);
      schedule();
    },
    hover(at, brush) {
      hover = { job: { from: undefined, to: at, next: 0, mode: brush.mode, radius: brush.radius }, found: [] };
      schedule();
    },
    clearHover() {
      hover = undefined;
      show([]);
    },
    setSupports(count) {
      // New supports start a fresh frame loop: no hover, no preview, render time unmeasured.
      if (frame) port.cancelFrame(frame);
      frame = 0;
      hover = undefined;
      show([]);
      lastEnd = 0;
      renderMs = FIRST_RENDER_MS;
      total = count ?? 0;
      if (!count) return queue.clear();
      queue.rebase();
      if (queue.pending) schedule();
    },
  };
}
