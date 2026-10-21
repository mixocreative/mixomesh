'use strict';
// Background throttling off while automation works (owner ruling 2026-10-21).
// A request that needs a render (thumbnail, save, export) hung whenever the
// desktop window was occluded or the display asleep: Chromium stops producing
// frames for occluded windows. Batch-job mode already creates its window with
// backgroundThrottling:false; an API session turns it off for the window it
// drives while any request is pending, and restores it when the last settles.

/**
 * @param {{ keepOff?: boolean }} [opts]  keepOff: the window never throttles (job mode)
 */
function createApiThrottleGuard({ keepOff = false } = {}) {
  const pending = new Map();   // webContents -> count
  const set = (wc, on) => { try { if (!wc.isDestroyed?.()) wc.setBackgroundThrottling(on); } catch { /* gone */ } };
  return {
    begin(wc) {
      const n = (pending.get(wc) ?? 0) + 1;
      pending.set(wc, n);
      if (n === 1) set(wc, false);
    },
    end(wc) {
      const n = (pending.get(wc) ?? 0) - 1;
      if (n > 0) { pending.set(wc, n); return; }
      pending.delete(wc);
      if (!keepOff) set(wc, true);
    },
    pendingFor(wc) { return pending.get(wc) ?? 0; },
  };
}

module.exports = { createApiThrottleGuard };
