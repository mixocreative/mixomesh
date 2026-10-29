/**
 * Admission for heavy jobs (placement, support mesh builds, exports): a job starts only while the
 * triangles of the running jobs plus its own stay within `limit` (the runtime's refusal limit, 6M),
 * so however many heavy objects the plate holds, the peak is about one limit's worth of jobs
 * (measured: ~5 GB renderer at 6M). First in, first out, so a big job is never starved by small ones;
 * a job alone always starts, even over the limit (each object is already within it at import).
 */

interface Waiter {
  triangles: number;
  start: (release: () => void) => void;
}

/**
 * FIFO admission gate by triangle count (see the file header). `acquire` resolves with a
 * release function; call it exactly once when the job settles (extra calls are ignored).
 * Used by `workers/meshClient` (`RunOptions.admit`) and the app's placement jobs.
 */
export class TriangleGate {
  private total = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly limit: number) {}

  /** Triangles of the jobs running now. */
  get running(): number {
    return this.total;
  }

  /** Jobs waiting to start. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Resolves with a release function once the job may start; rejects with AbortError if `signal` aborts first. */
  acquire(triangles: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        triangles,
        start: (release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(abortError());
        this.pump();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  // Starts waiters from the front while they fit. Never skips the head (FIFO, no starvation of a
  // big job); `total > 0` lets a single job over the limit start alone.
  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (this.total > 0 && this.total + next.triangles > this.limit) return;
      this.queue.shift();
      this.total += next.triangles;
      let released = false;
      next.start(() => {
        if (released) return;
        released = true;
        this.total -= next.triangles;
        this.pump();
      });
    }
  }
}

function abortError(): Error {
  const error = new Error('The job was cancelled while it waited to start.');
  error.name = 'AbortError';
  return error;
}
