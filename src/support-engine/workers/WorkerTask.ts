/**
 * WorkerTask: the one client-side job runner for this app's Web Workers, a TypeScript port of
 * mixomesh `src/core/workers/WorkerTask.js` (same contract, so the support core's workers move
 * to mixomesh unchanged). Worker side: `serveTask.ts`.
 *
 *   request  { id, type: 'run', payload, revision? }
 *   replies  { id, type: 'progress', ...fields }
 *            { id, type: 'done', result, revision? }
 *            { id, type: 'error', message, code?, vars? }   (code/vars: serveTask's extension)
 *
 * Each client is handed its own `create` factory (Vite needs the literal
 * `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` at the call site; those
 * live only in `factories.ts`), or null when Worker is unavailable.
 *
 * `revision` is an echo check only: it pairs a reply with the request that carried the same
 * revision. It cannot see state edited while the job ran; callers compare after the await.
 *
 * Failure isolation: a timeout or crash on a persistent worker terminates it; the failing job
 * rejects with its own reason, the other running jobs reject with code 'restarted' (a crash: all
 * get the crash message), and the next run() starts a fresh worker. Aborting the only job of a
 * persistent worker also replaces the worker, so leftover work never delays the next job.
 *
 * Progress UX (shared heavy-mesh spec §5): every job is reported to a JobActivity registry (the app's
 * `jobActivity` unless another is given) under its label, with the worker's progress forwarded. A
 * job run with a `signal` or `cancellable: true` gets a Cancel in the activity UI, which rejects it
 * with AbortError exactly like the caller's own signal would.
 */
import { jobActivity, type JobActivity, type JobLabel } from './jobActivity';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Abort reason for a job a newer one replaced: `controller.abort(REPLACED)`. */
export const REPLACED = 'replaced';

/** What WorkerTask needs of a Worker (a real one, or a stand-in in tests). */
export interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** Progress fields a worker posts, e.g. `{ fraction, stage }`. */
export type ProgressFields = Record<string, unknown>;

/** 'timeout' | 'restarted' | 'crashed' | 'stale' | 'unavailable' */
export type WorkerTaskErrorCode = 'timeout' | 'restarted' | 'crashed' | 'stale' | 'unavailable';

export interface WorkerTaskOptions<P, R> {
  /** Worker factory; null when there is no Worker. */
  create: (() => WorkerLike) | null;
  /** One long-lived worker (default), or a fresh worker per job that ends with the job. */
  mode?: 'persistent' | 'per-job';
  concurrency?: 'parallel' | 'serial';
  timeoutMs?: number;
  /** Main-thread implementation, used only when the worker cannot be created. */
  fallback?: (payload: P) => R | Promise<R>;
  /** Used in error messages. */
  name?: string;
  /** Default label in the activity UI (an i18n key); falls back to `name`. */
  label?: JobLabel;
  /** Registry the jobs are reported to (tests pass their own). */
  activity?: JobActivity;
}

export interface RunOptions {
  transfer?: Transferable[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (fields: ProgressFields) => void;
  revision?: number;
  /** This job's label in the activity UI. */
  label?: JobLabel;
  /** Offer Cancel in the activity UI (default: when the caller passes a signal). */
  cancellable?: boolean;
  /** The job replaces what the user would be editing (the UI blocks edits while it shows). */
  blocking?: boolean;
  /** What kind of job it is (an editing/errors context), so its failure is explained in the activity list. */
  context?: string;
  /**
   * Admission (a TriangleGate): the job is listed as "Queued" until this resolves with a release
   * function, which is called when the job settles. Aborting the job while it waits drops it.
   */
  admit?: (signal: AbortSignal) => Promise<() => void>;
}

interface Job {
  id: number;
  worker: WorkerLike;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  opts: RunOptions;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: (() => void) | undefined;
  done?: boolean;
}

type Reply = { id: number; type: 'progress' | 'done' | 'error'; result?: unknown; revision?: number; message?: string; code?: string; vars?: Record<string, string | number> } & ProgressFields;

/** An error the worker threw, with its own code and values when it had them. */
export class WorkerJobError extends Error {
  constructor(message: string, readonly code?: string, readonly vars?: Record<string, string | number>) {
    super(message);
  }
}

export class WorkerTaskError extends Error {
  constructor(message: string, readonly code: WorkerTaskErrorCode) {
    super(message);
  }
}

function abortError(name: string): Error {
  return new DOMException(`${name} aborted`, 'AbortError');
}

export class WorkerTask<P = unknown, R = unknown> {
  private readonly create: (() => WorkerLike) | null;
  private readonly mode: 'persistent' | 'per-job';
  private readonly serial: boolean;
  private readonly timeoutMs: number;
  private readonly fallback: ((payload: P) => R | Promise<R>) | undefined;
  readonly name: string;
  private readonly label: JobLabel;
  private readonly activity: JobActivity;
  private worker: WorkerLike | null = null;
  /** Running jobs of the persistent worker, by id. */
  private readonly jobs = new Map<number, Job>();
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor({ create, mode = 'persistent', concurrency = 'parallel', timeoutMs = DEFAULT_TIMEOUT_MS, fallback, name = 'worker task', label, activity = jobActivity }: WorkerTaskOptions<P, R>) {
    this.label = label ?? { key: name };
    this.activity = activity;
    this.create = create;
    this.mode = mode;
    this.serial = concurrency === 'serial';
    this.timeoutMs = timeoutMs;
    this.fallback = fallback;
    this.name = name;
  }

  /** Run one job; resolves with the worker's `result`. */
  run(payload: P, opts: RunOptions = {}): Promise<R> {
    if (opts.signal?.aborted) return Promise.reject(abortError(this.name));
    // One controller per job: the caller's signal and the activity Cancel both feed it.
    const controller = new AbortController();
    const outer = opts.signal;
    const onOuter = () => controller.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    const activity = this.activity.begin({
      label: opts.label ?? this.label,
      cancel: opts.cancellable ?? Boolean(outer) ? () => controller.abort() : null,
      blocking: opts.blocking ?? false,
      context: opts.context ?? null,
    });
    const inner: RunOptions = {
      ...opts,
      signal: controller.signal,
      onProgress: (fields) => {
        activity.progress(fields);
        opts.onProgress?.(fields);
      },
    };
    let job: Promise<R>;
    if (opts.admit) {
      activity.progress({ stage: 'Queued' });
      job = opts.admit(controller.signal).then((release) => {
        // Admitted: no longer queued, though the worker has not named its first stage yet.
        activity.progress({ stage: null });
        const started = this.start(payload, inner);
        started.then(release, release);
        return started;
      });
    } else if (!this.serial) {
      job = this.start(payload, inner);
    } else {
      job = this.chain.then(() => this.start(payload, inner));
      this.chain = job.catch(() => undefined);
    }
    // A job its caller replaced with a newer one (abort reason REPLACED) leaves quietly, not as "cancelled".
    job.then(() => activity.end(), (error: unknown) => activity.end(outer?.reason === REPLACED ? undefined : error)).finally(() => outer?.removeEventListener('abort', onOuter));
    return job;
  }

  /** Terminate the persistent worker (running jobs reject 'restarted'). */
  terminate(): void {
    this.restart(null, new WorkerTaskError(`${this.name} terminated`, 'restarted'));
  }

  private start(payload: P, opts: RunOptions): Promise<R> {
    if (opts.signal?.aborted) return Promise.reject(abortError(this.name));
    let worker: WorkerLike;
    try {
      if (!this.create) throw new WorkerTaskError(`${this.name} requires a Web Worker`, 'unavailable');
      worker = this.mode === 'per-job' ? this.create() : (this.worker ??= this.wire(this.create()));
    } catch (error) {
      if (this.fallback) return Promise.resolve().then(() => this.fallback!(payload));
      return Promise.reject(error instanceof WorkerTaskError ? error : new WorkerTaskError(`${this.name} requires a Web Worker (${(error as Error).message})`, 'unavailable'));
    }
    return new Promise<R>((resolve, reject) => {
      const id = ++this.seq;
      const job: Job = { id, worker, resolve: resolve as (result: unknown) => void, reject, opts, timer: undefined, abort: undefined };
      job.timer = setTimeout(() => this.timeout(job), opts.timeoutMs ?? this.timeoutMs);
      if (opts.signal) {
        job.abort = () => {
          this.settle(job, abortError(this.name));
          // The worker keeps grinding on the aborted job; when nothing else uses the persistent
          // worker, drop it so the next job starts fresh instead of queueing behind that work.
          if (this.mode !== 'per-job' && this.worker === worker && this.jobs.size === 0) this.restart(null, null);
        };
        opts.signal.addEventListener('abort', job.abort, { once: true });
      }
      if (this.mode === 'per-job') {
        worker.onmessage = (event) => this.onMessage(event.data as Reply, job);
        worker.onerror = (event) => {
          event?.preventDefault?.();
          this.settle(job, new WorkerTaskError(event?.message || `${this.name} crashed`, 'crashed'));
        };
      } else {
        this.jobs.set(id, job);
      }
      try {
        worker.postMessage({ id, type: 'run', payload, ...(opts.revision != null ? { revision: opts.revision } : {}) }, opts.transfer ?? []);
      } catch (error) {
        this.settle(job, error);
      }
    });
  }

  private wire(worker: WorkerLike): WorkerLike {
    worker.onmessage = (event) => {
      const message = event.data as Reply | null;
      if (!message || typeof message !== 'object') return;
      const job = this.jobs.get(message.id);
      if (job) this.onMessage(message, job);
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      this.restart(null, new WorkerTaskError(event?.message || `${this.name} crashed`, 'crashed'));
    };
    return worker;
  }

  private onMessage(message: Reply | null, job: Job): void {
    if (!message || typeof message !== 'object' || message.id !== job.id) return;
    if (message.type === 'progress') {
      const { id: _id, type: _type, ...fields } = message;
      try {
        job.opts.onProgress?.(fields);
      } catch (error) {
        this.settle(job, error);
      }
      return;
    }
    if (message.type === 'done') {
      if (job.opts.revision != null && message.revision !== job.opts.revision) this.settle(job, new WorkerTaskError(`stale ${this.name} result`, 'stale'));
      else this.settle(job, null, message.result);
      return;
    }
    if (message.type === 'error') this.settle(job, new WorkerJobError(message.message || `${this.name} failed`, message.code, message.vars));
  }

  private timeout(job: Job): void {
    const ms = job.opts.timeoutMs ?? this.timeoutMs;
    const error = new WorkerTaskError(`${this.name} timed out after ${ms} ms`, 'timeout');
    if (this.mode === 'per-job') this.settle(job, error);
    else this.restart(job, error);
  }

  /**
   * The persistent worker failed: kill it, reject `job` with `error` and the rest with
   * 'restarted' (or every job with `error` when `job` is null: a crash affects all of them).
   */
  private restart(job: Job | null, error: Error | null): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    if (!error) return; // idle restart (abort): no jobs left to fail
    for (const other of [...this.jobs.values()]) {
      const reason = !job || other === job ? error : new WorkerTaskError(`${this.name} restarted: ${error.message}`, 'restarted');
      this.settle(other, reason);
    }
  }

  private settle(job: Job, error: unknown, result?: unknown): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (job.abort) job.opts.signal?.removeEventListener('abort', job.abort);
    this.jobs.delete(job.id);
    if (this.mode === 'per-job') {
      job.worker.onmessage = null;
      job.worker.onerror = null;
      job.worker.terminate();
    }
    if (error) job.reject(error);
    else job.resolve(result);
  }
}
