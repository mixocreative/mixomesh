import type { BrushMode } from './types';

export type Point = readonly [number, number];

/** One Drag over hit test to run: the circle swept from → to, from support index `next`. */
export interface BrushJob {
  from: Point | undefined;
  to: Point;
  next: number;
  /** The brush as it was when the job was made, not when it is tested. */
  mode: BrushMode;
  radius: number;
}

/** One press-to-release stroke: its pointer steps waiting for hit tests and the ids it painted. */
interface QueuedStroke {
  steps: BrushJob[];
  painted: Set<string>;
  /** The stroke's previous pointer point, where its next step starts. */
  last: Point | undefined;
}

/**
 * Drag over's work queue (framework-free; the brush scheduler owns one and keeps it across
 * support-mesh rebuilds). Pointer moves only `push`; each frame `drain`s as much as the hit test
 * allows and carries the rest over, also after the release, so a stroke always completes.
 */
export interface StrokeQueue {
  readonly pending: boolean;
  /** A new stroke: no previous point, a fresh painted set. Queued steps of the last stroke still drain, with their own set. */
  begin(): void;
  push(to: Point, mode: BrushMode, radius: number): void;
  /** The supports went away (brush off, another object, or an empty mesh): queued steps are dropped. */
  clear(): void;
  /** The supports were rebuilt (support indices changed): every queued step starts over on the new ones. */
  rebase(): void;
  /**
   * Tests queued steps in order until one stops before `total` (out of time: it goes on next
   * frame). Hits are committed once per run of steps with the same mode. `want` is what a step
   * may change: not yet painted by its stroke, and selected (by `isSelected`, the host's
   * selection, overlaid by what earlier steps of this drain hit) when it unselects, unselected
   * when it selects.
   */
  drain(
    total: number,
    test: (step: BrushJob, want: (id: string) => boolean) => { hits: readonly string[]; next: number },
    commit: (ids: readonly string[], mode: BrushMode) => void,
    isSelected: (id: string) => boolean,
  ): void;
}

const newStroke = (): QueuedStroke => ({ steps: [], painted: new Set(), last: undefined });

export function createStrokeQueue(): StrokeQueue {
  /** Strokes with steps left, oldest first. */
  const queue: QueuedStroke[] = [];
  /** The stroke pointer moves add to; queued again whenever it gets a step after draining. */
  let current = newStroke();
  return {
    get pending() { return queue.length > 0; },
    begin() {
      current = newStroke();
    },
    push(to, mode, radius) {
      current.steps.push({ from: current.last, to, next: 0, mode, radius });
      current.last = to;
      if (queue[queue.length - 1] !== current) queue.push(current);
    },
    clear() {
      queue.length = 0;
      current = newStroke();
    },
    rebase() {
      for (const stroke of queue) for (const step of stroke.steps) step.next = 0;
    },
    drain(total, test, commit, isSelected) {
      /** Hits not yet committed, all made in `mode`. */
      let batch: string[] = [];
      let mode: BrushMode | undefined;
      /** What this drain's hits did to the selection (the host's selection lags until it renders). */
      const hit = new Map<string, BrushMode>();
      const selectedNow = (id: string) => (hit.has(id) ? hit.get(id) === 'select' : isSelected(id));
      while (queue.length > 0) {
        const stroke = queue[0]!;
        const step = stroke.steps[0]!;
        if (batch.length > 0 && mode !== step.mode) {
          commit(batch, mode!);
          batch = [];
        }
        mode = step.mode;
        const adding = step.mode === 'select';
        const part = test(step, (id) => !stroke.painted.has(id) && selectedNow(id) !== adding);
        for (const id of part.hits) {
          batch.push(id);
          stroke.painted.add(id);
          hit.set(id, step.mode);
        }
        if (part.next < total) {
          step.next = part.next;
          break;
        }
        stroke.steps.shift();
        if (stroke.steps.length === 0) queue.shift();
      }
      if (batch.length > 0) commit(batch, mode!);
    },
  };
}
