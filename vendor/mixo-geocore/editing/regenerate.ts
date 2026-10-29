/**
 * @file Regeneration bookkeeping for the status line: the report of what happened to an object's
 * hand work, the status messages, and the debounce queue that batches placement-setting edits.
 *
 * How hand edits survive a regenerate (the rekey). Done before this module sees anything, by
 * host/supports/contactEdits.ts `rekeyHandWork` over the wasm `rekey_hand_work`
 * (crates/geometry-core/src/supports/edits.rs):
 * - An automatic contact id encodes its position on a 0.01 mm grid (`auto-...`), so a stored id
 *   still says where its support stood after the support itself is gone.
 * - Manual (hand-added) supports are not regenerated: they and their per-support settings stay.
 * - Each stored removal, then each automatic per-support setting, is matched in that order to the
 *   new placement: the same id if a new contact has it, else the nearest new contact within the
 *   match radius (mm) of the encoded spot that nothing earlier claimed. One new contact is claimed
 *   by at most one stored id, so two removals never collapse onto one support.
 * - A stored id with no match is dropped and counted as reset.
 * The counts come back as `RekeyedHandWork` and `regenReport` turns them into a `RegenReport`.
 */
import type { RekeyedHandWork } from '../host/core/analysis/types';
import type { StatusMessage } from './types';

/**
 * What a regeneration did to an object's hand work: the supports the user added always stay;
 * a removal stays when its support is placed again (`kept`) or moves to the nearest new support
 * (`moved`), and is reset (`reset`) when no support is near its spot any more.
 */
export interface RegenReport {
  /** Supports the user added, kept. */
  added: number;
  /** Removals that still hide the support they named, or its nearest neighbour. */
  removed: number;
  /** Removals no new support matches: reset, they hide nothing. */
  reset: number;
  /** Supports with their own settings, kept. */
  customisedKept: number;
  /** Per-support settings whose support is gone: reset, dropped. */
  customisedReset: number;
}

/** The report for one placement landing on an object with `manual` added supports, from what the placement made of its hand work. */
export function regenReport(manual: number, handWork: Pick<RekeyedHandWork<unknown>, 'removals' | 'customised'>): RegenReport {
  return { added: manual, removed: handWork.removals.kept, reset: handWork.removals.reset, customisedKept: handWork.customised.kept, customisedReset: handWork.customised.reset };
}

const hasEdits = (report: RegenReport): boolean => report.added + report.removed + report.reset > 0;
const hasCustomised = (report: RegenReport): boolean => report.customisedKept + report.customisedReset > 0;

/** Hand work worth a report: nothing is said when there was none to keep or reset. */
export const hasHandWork = (report: RegenReport): boolean => hasEdits(report) || hasCustomised(report);

/** The sentence about per-support settings, added to a regeneration's report when there were any. */
function customisedSentence(report: RegenReport): StatusMessage | undefined {
  return hasCustomised(report) ? { key: '{n} customised kept, {m} reset.', vars: { n: report.customisedKept, m: report.customisedReset } } : undefined;
}

function withCustomised(message: StatusMessage, report: RegenReport): StatusMessage {
  const sentence = customisedSentence(report);
  return sentence ? { ...message, then: sentence } : message;
}

/** The status line while a regeneration runs, for what changed it (`placement`: a placement setting) and its scope. */
export function regeneratingStatus(scope: { n: number; name: string }, cause: 'button' | 'placement'): StatusMessage {
  return cause === 'placement'
    ? { key: 'Placement changed: regenerating {name}.', other: 'Placement changed: regenerating {n} objects.', vars: scope }
    : { key: 'Regenerating {name}.', other: 'Regenerating {n} objects.', vars: scope };
}

/** The status line after placements landed together: one object reads as `regeneratedStatus` (or its first Generate), several as one summary. */
export function landedStatus(landed: readonly { name: string; placed: number; report?: RegenReport }[]): StatusMessage {
  const [only] = landed;
  if (landed.length === 1 && only) return only.report ? regeneratedStatus(only.name, only.placed, only.report) : { key: '{name}: {n} automatic contacts generated.', vars: { name: only.name, n: only.placed } };
  const reports = landed.flatMap((entry) => (entry.report ? [entry.report] : []));
  if (reports.length < landed.length) return { key: 'Generated supports for {n} objects.', vars: { n: landed.length } };
  const total = reports.reduce((sum, report): RegenReport => ({
    added: sum.added + report.added,
    removed: sum.removed + report.removed,
    reset: sum.reset + report.reset,
    customisedKept: sum.customisedKept + report.customisedKept,
    customisedReset: sum.customisedReset + report.customisedReset,
  }), { added: 0, removed: 0, reset: 0, customisedKept: 0, customisedReset: 0 });
  if (!hasHandWork(total)) return { key: 'Regenerated {n} objects.', vars: { n: landed.length } };
  if (!hasEdits(total)) return withCustomised({ key: 'Regenerated {n} objects.', vars: { n: landed.length } }, total);
  return withCustomised({ key: 'Regenerated {n} objects. Hand edits kept: {added} added, {removed} removed. Removals reset: {reset}.', vars: { n: landed.length, added: total.added, removed: total.removed, reset: total.reset } }, total);
}

/** The status line (and the Undo toast) after a regeneration landed on an object. */
export function regeneratedStatus(name: string, placed: number, report: RegenReport): StatusMessage {
  if (!hasEdits(report)) return withCustomised({ key: '{name}: {n} automatic contacts generated.', vars: { name, n: placed } }, report);
  return withCustomised({ key: 'Regenerated {name}: {n} supports placed. Hand edits kept: {added} added, {removed} removed. Removals reset: {reset}.', vars: { name, n: placed, added: report.added, removed: report.removed, reset: report.reset } }, report);
}

/** Settings edits come in bursts (typing a value): a placement change regenerates once it has been quiet this long. */
export const REGENERATE_DELAY_MS = 350;

/**
 * Units whose placement setting changed, waiting out the burst before they regenerate together.
 * `cancel` drops them (a mode took the supports over): the unit's placement then shows as pending
 * (`placementPending`) until the user regenerates.
 */
export class RegenerateQueue {
  private readonly ids = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly run: (ids: string[]) => void,
    private readonly onQueued: (queued: boolean) => void = () => {},
    private readonly delay = REGENERATE_DELAY_MS,
  ) {}

  /** Adds `ids` to the waiting set and restarts the quiet timer; an empty list does nothing. */
  schedule(ids: readonly string[]): void {
    if (ids.length === 0) return;
    ids.forEach((id) => this.ids.add(id));
    // Trailing-edge debounce: every new id restarts the wait, and all ids run in one call.
    clearTimeout(this.timer);
    this.onQueued(true);
    this.timer = setTimeout(() => {
      const due = [...this.ids];
      this.ids.clear();
      this.timer = undefined;
      this.onQueued(false);
      if (due.length > 0) this.run(due);
    }, this.delay);
  }

  /** Drops every waiting id without running them; does nothing when nothing waits. */
  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ids.clear();
    this.onQueued(false);
  }
}
