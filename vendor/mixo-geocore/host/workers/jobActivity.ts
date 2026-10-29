/**
 * The one registry of running background jobs (shared heavy-mesh spec §5; TypeScript port of
 * mixomesh `src/core/workers/JobActivity.js`). WorkerTask reports every job here (begin, progress,
 * end); the UI subscribes and renders `view(now)`. Framework-free and timer-free: the NN/g
 * response-time rules live in `view`, so they are unit-tested with a fake clock.
 */

/** A job only appears after this long, so fast jobs never flash a loader. */
export const SHOW_DELAY_MS = 400;
/** Once shown, a job stays at least this long. */
export const MIN_VISIBLE_MS = 500;
/** After this long a job without progress shows its elapsed time. */
export const LONG_JOB_MS = 10_000;
/** A failure stays listed until it is dismissed; a cancel is acknowledged this long. */
export const CANCEL_LINGER_MS = 1_500;
/** Time left only once the rate is known (at least 3 s of progress and 10 % done). */
export const ETA_MIN_MS = 3_000;
/** See `ETA_MIN_MS`: the fraction a job must have reached before it shows time left. */
export const ETA_MIN_FRACTION = 0.1;

/** What a job is, as an i18n key with values ("Importing {name}"). */
export interface JobLabel {
  key: string;
  vars?: Record<string, string | number>;
}

/** A failed job's error as the UI shows it: the shared error code (null if none) and its message. */
export interface JobError {
  code: string | null;
  message: string;
  /** The values its message needs (numbers of a refusal), when the error carried them. */
  vars?: Record<string, string | number>;
}

/** A row's state: running without / with a fraction, or finished (done, failed, cancelled). */
export type JobState = 'indeterminate' | 'determinate' | 'done' | 'failed' | 'cancelled';

/**
 * One row of `JobActivity.view`: a visible job with its progress (`fraction` 0..1, `percent`
 * 0..100), times in ms, and what the UI may offer (Cancel) or must do (block edits).
 */
export interface JobRow {
  id: number;
  label: JobLabel;
  stage: string | null;
  state: JobState;
  fraction: number | null;
  percent: number | null;
  elapsedMs: number;
  showElapsed: boolean;
  remainingMs: number | null;
  cancellable: boolean;
  cancelling: boolean;
  /** The job replaces what the user would be editing: the UI blocks edits while it shows. */
  blocking: boolean;
  /** What kind of job it is (import, place, build, check, export), for its failure message. */
  context: string | null;
  error: JobError | null;
}

/** What `JobActivity.begin` returns: report progress fields, then `end()` (with the error if it failed). Calls after `end` are ignored. */
export interface JobHandle {
  id: number;
  progress(fields: Record<string, unknown>): void;
  end(error?: unknown): void;
}

interface Entry {
  id: number;
  label: JobLabel;
  stage: string | null;
  fraction: number | null;
  startedAt: number;
  firstProgress: { at: number; fraction: number } | null;
  shownAt: number | null;
  endedAt: number | null;
  outcome: 'done' | 'failed' | 'cancelled' | null;
  error: JobError | null;
  cancel: (() => void) | null;
  cancelling: boolean;
  blocking: boolean;
  context: string | null;
}

/** Fraction 0..1 from a worker progress message, or null when it carries none. */
export function fractionOf(fields: Record<string, unknown> | null | undefined): number | null {
  if (!fields) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const { fraction, loaded, done, completed, total } = fields as Record<string, number>;
  if (Number.isFinite(fraction)) return clamp(fraction!);
  if (Number.isFinite(total) && total! > 0) {
    if (Number.isFinite(loaded)) return clamp(loaded! / total!);
    const count = Number.isFinite(done) ? done : completed;
    if (Number.isFinite(count)) return clamp(count! / total!);
  }
  return null;
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

/**
 * Registry of running jobs. `clock` is injectable for tests. Listeners from `subscribe` run on
 * every change; the UI re-reads `view(now)` (which also drops rows whose linger time is up).
 */
export class JobActivity {
  private readonly entries = new Map<number, Entry>();
  private readonly subscribers = new Set<() => void>();
  private seq = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Adds a change listener; returns its unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Register a running job; `cancel` present = cancellable. */
  begin({ label, cancel = null, blocking = false, context = null }: { label: JobLabel; cancel?: (() => void) | null; blocking?: boolean; context?: string | null }): JobHandle {
    const id = ++this.seq;
    const entry: Entry = { id, label, stage: null, fraction: null, startedAt: this.clock(), firstProgress: null, shownAt: null, endedAt: null, outcome: null, error: null, cancel, cancelling: false, blocking, context };
    this.entries.set(id, entry);
    this.notify();
    return {
      id,
      progress: (fields) => {
        if (entry.endedAt !== null) return;
        const fraction = fractionOf(fields);
        // A stage that starts at 0 % stays indeterminate until it moves (no bar frozen at 0).
        if (fraction !== null && (fraction > 0 || entry.fraction !== null)) {
          entry.firstProgress ??= { at: this.clock(), fraction };
          entry.fraction = fraction;
        }
        // A stage names what runs now; null clears it (a queued job that was admitted).
        if (typeof fields.stage === 'string' || fields.stage === null) entry.stage = fields.stage;
        this.notify();
      },
      end: (error) => {
        if (entry.endedAt !== null) return;
        entry.endedAt = this.clock();
        if (!error) entry.outcome = 'done';
        else if (isAbort(error)) entry.outcome = 'cancelled';
        else {
          entry.outcome = 'failed';
          const { code, vars } = error as { code?: unknown; vars?: unknown };
          entry.error = {
            code: typeof code === 'string' ? code : null,
            message: error instanceof Error ? error.message : String(error),
            ...(vars && typeof vars === 'object' ? { vars: vars as Record<string, string | number> } : {}),
          };
        }
        entry.cancel = null;
        this.notify();
      },
    };
  }

  /** Ask a running cancellable job to stop; false when it cannot (or already was asked). */
  cancel(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry?.cancel) return false;
    const cancel = entry.cancel;
    entry.cancel = null;
    entry.cancelling = true;
    this.notify();
    cancel();
    return true;
  }

  /** Hide a finished row now (a failure the user has read). */
  dismiss(id: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.endedAt === null) return;
    this.entries.delete(id);
    this.notify();
  }

  /** Whether any job (running or still listed) is registered. */
  hasJobs(): boolean {
    return this.entries.size > 0;
  }

  /** What to show at `now`, dropping rows whose time is up. */
  view(now = this.clock()): JobRow[] {
    const rows: JobRow[] = [];
    for (const entry of [...this.entries.values()]) {
      const age = now - entry.startedAt;
      if (entry.endedAt !== null) {
        const wasShown = entry.shownAt !== null;
        // A failure always surfaces, even one that ended before the show delay.
        if (entry.outcome === 'failed' && entry.shownAt === null) entry.shownAt = entry.endedAt;
        const linger = entry.outcome === 'cancelled' && wasShown ? CANCEL_LINGER_MS
          : wasShown ? Math.max(0, MIN_VISIBLE_MS - (entry.endedAt - entry.shownAt!)) : 0;
        if (entry.outcome !== 'failed' && (now - entry.endedAt >= linger || !wasShown)) {
          this.entries.delete(entry.id);
          continue;
        }
      } else if (age < SHOW_DELAY_MS) {
        continue;
      }
      entry.shownAt ??= now;
      const state: JobState = entry.outcome ?? (entry.fraction !== null ? 'determinate' : 'indeterminate');
      let remainingMs: number | null = null;
      if (state === 'determinate' && entry.firstProgress && entry.fraction! >= ETA_MIN_FRACTION) {
        const span = now - entry.firstProgress.at;
        const gained = entry.fraction! - entry.firstProgress.fraction;
        if (span >= ETA_MIN_MS && gained > 0) remainingMs = Math.round((span / gained) * (1 - entry.fraction!));
      }
      rows.push({
        id: entry.id,
        label: entry.label,
        stage: entry.stage,
        state,
        fraction: entry.fraction,
        percent: entry.fraction !== null ? Math.round(entry.fraction * 100) : null,
        elapsedMs: age,
        showElapsed: state === 'indeterminate' && age >= LONG_JOB_MS,
        remainingMs,
        cancellable: entry.cancel !== null,
        cancelling: entry.cancelling,
        blocking: entry.blocking,
        context: entry.context,
        error: entry.error,
      });
    }
    return rows;
  }

  private notify(): void {
    for (const listener of [...this.subscribers]) listener();
  }
}

/** The app's registry: every WorkerTask job reports here. */
export const jobActivity = new JobActivity();
