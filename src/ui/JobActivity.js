// Job activity panel — the ONE place every background (worker) job shows up
// (heavy-mesh spec §5). Renders JobActivity.viewModel(): nothing for jobs
// under 400 ms, an indeterminate bar with a plain label, a determinate bar
// with % + stage (+ time left once stable) when the worker reports progress,
// Cancel for cancellable jobs, and a plain-words failure with the next step.
// Non-blocking: a small panel above the status bar; the viewport stays live.
// Keyed DOM updates (no innerHTML per tick) so focus on Cancel survives.

import { JobActivity } from '../core/workers/JobActivity.js';
import { EVENTS } from '../core/events.js';
import { subscribe as subscribeState } from '../core/StateManager.js';
import { t } from '../i18n/index.js';

const TICK_MS = 250;

let _root = null;
let _list = null;
let _live = null;
let _timer = null;
let _raf = 0;
const _rows = new Map();          // job id → { el, label, meta, track, fill, cancel, dismiss, announced }
const _dismissed = new Set();

/** Translate a "job.*" key; plain text passes through. */
function _tr(key) {
  return typeof key === 'string' && /^job\./.test(key) ? t(key) : String(key ?? '');
}

function _fmtTime(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Background jobs the user did not start and cannot simply retry get their own
// next step instead of "Try again" (review M13).
const NEXT_STEP = {
  'job.pickIndex': 'activity.next.pickIndex',
  'job.checkMesh': 'activity.next.checkMesh',
  'job.hashFile': 'activity.next.hashFile',
};

/** Plain-words failure text with what to do next. Exported for tests. */
export function failureText(row) {
  const label = _tr(row.label);
  const nextKey = NEXT_STEP[row.label];
  if (nextKey) {
    const next = t(nextKey);
    if (row.error?.code === 'timeout') return t('activity.timeoutNext', { label, next });
    const message = String(row.error?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return t('activity.failedNext', { label, message, next });
  }
  if (row.error?.code === 'timeout') return t('activity.timeout', { label });
  if (row.error?.code === 'restarted') return t('activity.restarted', { label });
  const message = String(row.error?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return t('activity.failed', { label, message });
}

/** Row text: label (+ stage) and meta (percent, time left / elapsed). Exported for tests. */
export function rowText(row) {
  const label = _tr(row.label);
  if (row.state === 'failed') return { label: failureText(row), meta: '' };
  if (row.state === 'cancelled') return { label: t('activity.cancelled', { label }), meta: '' };
  if (row.cancelling) return { label, meta: t('activity.cancelling') };
  const stageKey = row.stage ? `job.stage.${row.stage}` : null;
  const stageText = stageKey ? (t(stageKey) === stageKey ? row.stage : t(stageKey)) : '';
  const meta = [];
  if (row.percent != null) meta.push(`${row.percent}%`);
  if (row.remainingMs != null) meta.push(t('activity.remaining', { time: _fmtTime(row.remainingMs) }));
  else if (row.showElapsed) meta.push(t('activity.elapsed', { time: _fmtTime(row.elapsedMs) }));
  return { label: stageText ? `${label} — ${stageText}` : `${label}…`, meta: meta.join(' · ') };
}

function _ensure() {
  if (_root) return;
  _root = document.createElement('section');
  _root.id = 'job-activity';
  _root.className = 'job-activity';
  _root.hidden = true;
  _root.setAttribute('aria-label', t('activity.region'));
  _list = document.createElement('ul');
  _list.className = 'ja-list';
  _live = document.createElement('div');
  _live.className = 'ja-live';
  _live.setAttribute('role', 'status');
  _live.setAttribute('aria-live', 'polite');
  _root.append(_list, _live);
  document.body.appendChild(_root);
}

function _makeRow(row) {
  const el = document.createElement('li');
  el.className = 'ja-row';
  el.dataset.jobId = String(row.id);
  const head = document.createElement('div');
  head.className = 'ja-head';
  const label = document.createElement('span');
  label.className = 'ja-label';
  const meta = document.createElement('span');
  meta.className = 'ja-meta';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ja-cancel';
  cancel.addEventListener('click', (e) => { e.stopPropagation(); JobActivity.cancelJob(row.id); });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'ja-dismiss';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', (e) => { e.stopPropagation(); _dismissed.add(row.id); _render(); });
  head.append(label, meta, cancel, dismiss);
  const track = document.createElement('div');
  track.className = 'progress-track ja-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'progress-fill ja-fill';
  track.appendChild(fill);
  el.append(head, track);
  return { el, label, meta, track, fill, cancel, dismiss, announced: null };
}

function _announce(text) {
  if (_live && text) _live.textContent = text;
}

function _render() {
  _raf = 0;
  _ensure();
  const rows = JobActivity.viewModel().filter(r => !_dismissed.has(r.id));
  const seen = new Set();
  for (const row of rows) {
    seen.add(row.id);
    let view = _rows.get(row.id);
    if (!view) {
      view = _makeRow(row);
      _rows.set(row.id, view);
      _list.appendChild(view.el);
    }
    const text = rowText(row);
    view.el.dataset.state = row.state;
    view.label.textContent = text.label;
    view.meta.textContent = text.meta;
    view.label.title = text.label;
    view.cancel.hidden = !(row.cancellable && !row.cancelling) || row.state === 'failed' || row.state === 'cancelled';
    view.cancel.textContent = t('activity.cancel');
    view.dismiss.hidden = row.state !== 'failed';
    view.dismiss.setAttribute('aria-label', t('activity.dismiss'));
    view.track.hidden = row.state === 'failed' || row.state === 'cancelled';
    view.track.setAttribute('aria-label', _tr(row.label));
    const determinate = row.state === 'determinate' || row.state === 'done';
    view.track.classList.toggle('ja-indeterminate', !determinate);
    if (determinate) {
      const pct = row.state === 'done' ? 100 : row.percent ?? 0;
      view.track.setAttribute('aria-valuenow', String(pct));
      view.fill.style.width = `${pct}%`;
    } else {
      view.track.removeAttribute('aria-valuenow');
      view.fill.style.width = '';
    }
    const announce = row.state === 'failed' || row.state === 'cancelled' ? text.label
      : view.announced == null ? `${_tr(row.label)}…` : null;
    if (announce && view.announced !== row.state) { _announce(announce); view.announced = row.state; }
  }
  for (const [id, view] of _rows) {
    if (!seen.has(id)) { view.el.remove(); _rows.delete(id); }
  }
  for (const id of _dismissed) if (!seen.has(id)) _dismissed.delete(id);
  _root.hidden = rows.length === 0;
  _syncTimer();
}

function _schedule() {
  if (_raf) return;
  _raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(_render)
    : setTimeout(_render, 16);
}

/** Tick while anything is registered: delays, lingering and elapsed time are time-driven. */
function _syncTimer() {
  const want = JobActivity.hasJobs();
  if (want && !_timer) _timer = setInterval(_schedule, TICK_MS);
  else if (!want && _timer) { clearInterval(_timer); _timer = null; }
}

/** Mount the panel and start listening. Call once after the DOM is ready. */
export function init() {
  _ensure();
  JobActivity.subscribe(() => { _schedule(); _syncTimer(); });
  subscribeState(EVENTS.LOCALE_CHANGED, () => {
    _root?.setAttribute('aria-label', t('activity.region'));
    _schedule();
  });
  _render();
}

export const JobActivityPanel = { init, rowText, failureText };
