// JobActivity — the ONE registry of running background jobs (heavy-mesh spec
// §5). WorkerTask reports every job here (begin / progress / end); the UI
// (src/ui/JobActivity.js) subscribes once and renders `viewModel(now)`. Pure:
// no DOM, no timers — the timing rules (NN/g response-time limits) live in
// `viewModel` so they are unit-testable with a fake clock.

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
 * @param {{ label: string, cancel?: (() => void) | null, hidden?: boolean }} opts
 *   `label` = an i18n key ("job.*") or plain text; `cancel` present = cancellable;
 *   `hidden` = the caller shows its own progress (the import overlay) — the job
 *   is tracked but never rendered, so there is ONE progress surface.
 * @returns {{ id: number, progress(fields: object): void, end(error?: any): void }}
 */
export function beginJob({ label, cancel = null, hidden = false }) {
  const id = ++_seq;
  const job = {
    id, label: String(label || 'job.working'), stage: null, fraction: null, hidden: !!hidden,
    startedAt: _clock(), firstProgressAt: null, shownAt: null,
    endedAt: null, outcome: null, error: null, cancel,
  };
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
    if (job.hidden) {
      if (job.endedAt != null) _jobs.delete(job.id);
      continue;
    }
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

/** True while any job is registered (running or lingering). */
export function hasJobs() { return _jobs.size > 0; }

/** Test seam: forget everything. */
export function resetJobs() { _jobs.clear(); _seq = 0; _notify(); }

export const JobActivity = { beginJob, cancelJob, subscribe, viewModel, hasJobs, setClock, resetJobs };
