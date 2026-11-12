/*
 * The app shell of a focus mode: which chrome is dimmed and made inert while the mode is on, and
 * putting it all back exactly.
 *
 * One job, two callers: Support Mode (P3.2) and the parts scope (U5), each naming its OWN panels.
 * That is the point — the owner asked for the UI to choose what to dim, and before this the list
 * lived twice, once in `SupportMode.INERT_SELECTORS` and once as a `:is(...)` list in layout.css.
 * Two copies of one decision, in two languages, is how a mode ends up dimming a panel it still
 * needs. Now the mode names its selectors once, this marks them `data-dimmed`, and the CSS has a
 * single generic rule.
 *
 * `inert` is restored per element to the value it had, not to `false`: a panel that was already
 * inert for its own reasons must stay that way when the mode ends.
 */

export interface ModeShell {
  /** Mode off: every dimmed panel un-dimmed, `inert` back to what it was, `data-mode` removed. */
  clear(): void;
}

/**
 * Turn `mode` on: mark the panels matching `dim` and make them inert, and put `data-mode` (plus
 * `data-modeCount`, which the header reads) on `#app`.
 *
 * Returns the restore. Calling it twice without clearing is safe: the first saved `inert` value per
 * element wins, so a second call cannot record this mode's own value as the thing to restore.
 */
export function applyModeShell(mode: string, dim: readonly string[], count?: number): ModeShell {
  if (typeof document === 'undefined') return { clear() { /* no DOM: nothing to dim */ } };
  const app = document.getElementById('app');
  if (app) {
    app.dataset.mode = mode;
    if (count !== undefined) app.dataset.modeCount = String(count);
  }
  const was = new Map<HTMLElement, boolean>();
  if (dim.length > 0) {
    for (const el of document.querySelectorAll<HTMLElement>(dim.join(','))) {
      if (!was.has(el)) was.set(el, el.inert);
      el.inert = true;
      el.dataset.dimmed = mode;
    }
  }
  // Focus inside a panel that just went inert would otherwise keep swallowing keys.
  const focused = document.activeElement as HTMLElement | null;
  if (focused && focused !== document.body && focused.closest('[inert]')) focused.blur();

  return {
    clear() {
      for (const [el, before] of was) {
        el.inert = before;
        delete el.dataset.dimmed;
      }
      was.clear();
      if (app && app.dataset.mode === mode) {
        delete app.dataset.mode;
        delete app.dataset.modeCount;
      }
    },
  };
}
