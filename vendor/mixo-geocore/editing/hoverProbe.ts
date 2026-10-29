/**
 * An answer that costs rays (is the pointer over the object?) asked for at pointer-move rate but
 * worked out at most once per animation frame, for the latest pointer only. The host asks on every
 * move, reads `answer` (the last worked out) at once, and hears `onAnswer` after each frame's run.
 */
export interface HoverProbe<A extends unknown[]> {
  /** The answer of the latest run; false until one has run. */
  readonly answer: boolean;
  /** Remembers the arguments and schedules a run for the next frame unless one is waiting. */
  ask(...args: A): void;
  /** Drops the wait and forgets the answer (the pointer left, or the mode ended). */
  reset(): void;
}

/**
 * Builds a probe over `port`: `test` is the costly check, run with the latest `ask` arguments;
 * `requestFrame` / `cancelFrame` are the host's animation-frame calls; `onAnswer` hears each result.
 */
export function createHoverProbe<A extends unknown[]>(port: {
  test: (...args: A) => boolean;
  requestFrame: (run: () => void) => number;
  cancelFrame: (handle: number) => void;
  onAnswer: (answer: boolean) => void;
}): HoverProbe<A> {
  let latest: A | undefined;
  let handle: number | undefined;
  let answer = false;
  const run = () => {
    handle = undefined;
    if (!latest) return;
    answer = port.test(...latest);
    port.onAnswer(answer);
  };
  return {
    get answer() {
      return answer;
    },
    ask(...args) {
      // Only the latest arguments are kept: a frame tests where the pointer is now, not where it was.
      latest = args;
      if (handle === undefined) handle = port.requestFrame(run);
    },
    reset() {
      if (handle !== undefined) port.cancelFrame(handle);
      handle = undefined;
      latest = undefined;
      answer = false;
    },
  };
}
