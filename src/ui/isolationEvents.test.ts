import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/*
 * The two isolation modes must agree on what invalidates an isolated viewport.
 *
 * Support Mode and the separator depth both call `createIsolation`, which hides every object but
 * the ones it is given. That makes them share a hazard: when the SCENE changes underneath, the
 * isolation is stale, and stale isolation is invisible by construction -- the viewport looks like a
 * deliberate, tidy, almost-empty scene either way.
 *
 * Support Mode subscribes to OBJECT_REMOVED, OBJECT_RESTORED and ASSET_INSTANTIATED for that
 * reason. The separator depth subscribed to none of them (found 2026-11-13), so the object being
 * picked inside could be removed by something that is not a keypress -- the automation API, a
 * command pushed elsewhere -- and the isolation stayed on, the panels stayed dimmed, and the notice
 * went on naming an object that no longer existed, until the operator happened to click. A newly
 * instantiated object leaked into the isolated viewport the same way.
 *
 * Asserted over the SOURCE rather than by driving the mode: importing `PartScopeMode` pulls Babylon
 * and `location` into a node test (see `partScopeKeys.test.ts` for the same reason), and what is
 * worth pinning here is not a behaviour inside one mode but the AGREEMENT between the two -- which
 * is a fact about the subscribe lists, and reads as one.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Event constants the file subscribes to, as `EVENTS.NAME` occurrences. */
function eventsIn(source: string): Set<string> {
  return new Set([...source.matchAll(/EVENTS\.([A-Z_]+)/g)].map((m) => m[1]!));
}

/** The scene changing under an isolated viewport; stale isolation looks exactly like a tidy one. */
const SCENE_CHANGE = ['OBJECT_REMOVED', 'OBJECT_RESTORED', 'ASSET_INSTANTIATED'] as const;

describe('the two isolation modes', () => {
  it('both react to the scene changing under them', () => {
    const support = eventsIn(read('../supports/SupportMode.ts'));
    const parts = eventsIn(read('./PartScopeMode.ts'));
    for (const event of SCENE_CHANGE) {
      // Support Mode is the authority: if IT stops caring about one of these, this list is what
      // needs revisiting, and the failure says so rather than quietly dropping the check.
      expect(support.has(event), `SupportMode no longer subscribes to ${event} -- revisit this list`).toBe(true);
      expect(parts.has(event), `PartScopeMode must subscribe to ${event}: an isolated viewport goes stale silently`).toBe(true);
    }
  });

  it('keeps the separator depth listening for the things that end it', () => {
    // Entering and leaving, and the two that replace the whole scene: without these the dimmed
    // chrome and the notice outlive the depth they describe.
    const parts = eventsIn(read('./PartScopeMode.ts'));
    for (const event of ['SCOPE_CHANGED', 'SELECTION_CHANGED', 'PROJECT_LOADED', 'PROJECT_NEW']) {
      expect(parts.has(event), `PartScopeMode must subscribe to ${event}`).toBe(true);
    }
  });
});
