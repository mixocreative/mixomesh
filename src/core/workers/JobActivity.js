// JobActivity — the ONE registry of running jobs (heavy-mesh spec §5).
// WorkerTask reports every worker job here (begin / progress / end); a user
// operation that must block the UI (an import) registers itself as a
// `blocking` job. Two renderers subscribe: src/ui/JobActivity.js draws
// `viewModel(now)` (the non-blocking rows) and src/ui/ProgressOverlay.js draws
// `blockingJob()`. Pure: no DOM, no timers — the timing rules (NN/g
// response-time limits) live in `viewModel` so they are unit-testable with a
// fake clock.
//
// Scope by cancel signal: a blocking job owns an AbortSignal; a worker job
// started with that same signal is a STEP of it (the import's hash, parse,
// weld) and never a row of its own. Membership is derived from "what cancels
// together", so no caller threads a visibility flag through its layers.

/** A job only appears after this long, so fast jobs never flash a loader. */
export const SHOW_DELAY_MS = 400;
/** Once shown, a job stays at least this long. */
export const MIN_VISIBLE_MS = 500;
/** After this long a job without progress shows its elapsed time. */
export const LONG_JOB_MS = 10_000;
/** A failure stays readable this long; a cancel is acknowledged this long. */
export const ERROR_LINGER_MS = 8_000;
export const CANCEL_LINGER_MS = 1_500;
/** Time remaining only once the rate is known (≥ 3 s of progress, ≥ 10 % done). */
export const ETA_MIN_MS = 3_000;
export const ETA_MIN_FRACTION = 0.1;

const _jobs = new Map();
const _subs = new Set();
const _scopeBySignal = new WeakMap();   // AbortSignal → the blocking job it cancels
let _seq = 0;
let _clock = () => Date.now();

function _notify() {
  for (const fn of [..._subs]) {
    try { fn(); } catch (err) { console.error('JobActivity subscriber threw:', err); }
  }
}

/** Test seam: replace the clock. */
export function setClock(fn) { _clock = fn ?? (() => Date.now()); }

/** Subscribe to any change. @returns {() => void} unsubscribe */
export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/**
 * Register a running job.
 * @param {{ label: string, cancel?: (() => void) | null, signal?: AbortSignal | null,
 *           blocking?: boolean, detail?: string }} opts
 *   `label` = an i18n key ("job.*") or plain text; `cancel` present = cancellable;
 *   `signal` = the AbortSignal this job stops on. A `blocking` job (shown in the
 *   overlay, never a row) registers its signal as a scope; any later job on that
 *   signal is one of its steps. `detail` = free text the overlay shows (a filename).
 * @returns {{ id: number, progress(fields: object): void, end(error?: any): void }}
 */
export function beginJob({ label, cancel = null, signal = null, blocking = false, detail = '' }) {
  const id = ++_seq;
  const scope = !blocking && signal ? _scopeBySignal.get(signal) : null;
  const job = {
    id, label: String(label || 'job.working'), detail: String(detail ?? ''), stage: null, fraction: null,
    blocking: !!blocking, parentId: scope && scope.endedAt == null ? scope.id : null,
    startedAt: _clock(), firstProgressAt: null, shownAt: null,
    endedAt: null, outcome: null, error: null, cancel,
  };
  if (blocking && signal) _scopeBySignal.set(signal, job);
  _jobs.set(id, job);
  _notify();
  return {
    id,
    /** @param {import('./serveTask.js').ProgressFields} fields */
    progress(fields) {
      if (job.endedAt != null) return;
      if (Number.isFinite(fields?.fraction)) {
        const f = Math.max(0, Math.min(1, fields.fraction));
        if (job.firstProgressAt == null) job.firstProgressAt = { at: _clock(), fraction: f };
        job.fraction = f;
      }
      if (typeof fields?.stage === 'string') job.stage = fields.stage;
      _notify();
    },
    end(error) {
      if (job.endedAt != null) return;
      job.endedAt = _clock();
      if (!error) job.outcome = 'done';
      else if (error?.name === 'AbortError') job.outcome = 'cancelled';
      else { job.outcome = 'failed'; job.error = { code: error?.code ?? null, message: String(error?.message ?? error) }; }
      job.cancel = null;
      // A blocking job's outcome reaches the user through its caller (modal /
      // toast), and a step's through its blocking job: neither lingers here.
      if (job.blocking || job.parentId != null) _jobs.delete(id);
      _notify();
    },
  };
}

/** Ask a running cancellable job to stop. */
export function cancelJob(id) {
  const job = _jobs.get(id);
  if (!job?.cancel) return false;
  const fn = job.cancel;
  job.cancel = null;
  job.cancelling = true;
  _notify();
  try { fn(); } catch (err) { console.error('JobActivity cancel threw:', err); }
  return true;
}

/**
 * What the UI should show at `now`, after dropping expired entries.
 * Each row: { id, label, stage, state: 'indeterminate'|'determinate'|'failed'|'cancelled'|'done',
 *             fraction, percent, elapsedMs, remainingMs, cancellable, cancelling, error }
 * @param {number} [now]
 */
export function viewModel(now = _clock()) {
  const rows = [];
  for (const job of [..._jobs.values()]) {
    if (job.blocking || job.parentId != null) continue;
    const age = now - job.startedAt;
    if (job.endedAt != null) {
      const wasShown = job.shownAt != null;
      const linger = job.outcome === 'failed' ? ERROR_LINGER_MS
        : job.outcome === 'cancelled' && wasShown ? CANCEL_LINGER_MS
        : wasShown ? Math.max(0, MIN_VISIBLE_MS - (job.endedAt - job.shownAt)) : 0;
      // Failures always surface (never silent), even for a job that ended before the show delay.
      if (job.outcome === 'failed' && job.shownAt == null) job.shownAt = job.endedAt;
      if (now - job.endedAt >= linger || (!wasShown && job.outcome !== 'failed')) {
        _jobs.delete(job.id);
        continue;
      }
    } else if (age < SHOW_DELAY_MS) {
      continue;
    }
    if (job.shownAt == null) job.shownAt = now;
    const state = job.outcome ?? (job.fraction != null ? 'determinate' : 'indeterminate');
    let remainingMs = null;
    if (state === 'determinate' && job.firstProgressAt && job.fraction >= ETA_MIN_FRACTION) {
      const span = now - job.firstProgressAt.at;
      const gained = job.fraction - job.firstProgressAt.fraction;
      if (span >= ETA_MIN_MS && gained > 0) remainingMs = Math.round((span / gained) * (1 - job.fraction));
    }
    rows.push({
      id: job.id,
      label: job.label,
      stage: job.stage,
      state,
      fraction: job.fraction,
      percent: job.fraction != null ? Math.round(job.fraction * 100) : null,
      elapsedMs: age,
      showElapsed: state === 'indeterminate' && age >= LONG_JOB_MS,
      remainingMs,
      cancellable: !!job.cancel,
      cancelling: !!job.cancelling,
      error: job.error,
    });
  }
  return rows;
}

/**
 * The blocking job the overlay should show: the newest one still running, or
 * null. Its steps' progress reaches it through the caller's own progress
 * callback, so `stage` / `fraction` are what the owner last reported.
 * @returns {{ id: number, label: string, detail: string, stage: string|null,
 *             fraction: number|null, cancellable: boolean, cancelling: boolean } | null}
 */
export function blockingJob() {
  let top = null;
  for (const job of _jobs.values()) {
    if (job.blocking && job.endedAt == null && (!top || job.startedAt >= top.startedAt)) top = job;
  }
  if (!top) return null;
  return {
    id: top.id, label: top.label, detail: top.detail, stage: top.stage, fraction: top.fraction,
    cancellable: !!top.cancel, cancelling: !!top.cancelling,
  };
}

/** True while a job with this label is running (steps included). */
export function isRunning(label) {
  for (const job of _jobs.values()) if (job.label === label && job.endedAt == null) return true;
  return false;
}

/** True while any job is registered (running or lingering). */
export function hasJobs() { return _jobs.size > 0; }

/** Test seam: forget everything. */
export function resetJobs() { _jobs.clear(); _seq = 0; _notify(); }

export const JobActivity = { beginJob, cancelJob, subscribe, viewModel, blockingJob, isRunning, hasJobs, setClock, resetJobs };
