/*
 * The separator mode (U5): what the operator sees while they are INSIDE an object, picking its
 * meshes.
 *
 * Not a mode of its own — it is the click-depth scope one level deeper (the plan's decision: extend
 * the scope, do not add a third mode). So there is no entry button and no state to keep: this module
 * watches `SCOPE_CHANGED` and, whenever the scope is an object, turns on the three things that make
 * the depth legible and the fourth that makes it useful:
 *
 *   1. ISOLATION — every other object hidden (`createIsolation`, shared with Support Mode), so the
 *      meshes being picked are the only thing in the viewport.
 *   2. DIMMED CHROME — the panels this depth cannot act on, named here and marked by
 *      `applyModeShell`, so the operator can see the app is focused.
 *   3. A NOTICE — one sentence saying what to do, because a viewport that suddenly holds one object
 *      and nothing else is a surprise unless something explains it.
 *   4. SEPARATE — the one action, enabled only when a strict subset is picked. Separating every mesh
 *      is "Separate by material" and separating none is not an edit, so the button says why it is
 *      off rather than being mysteriously dead.
 *
 * The notice is built here rather than in a panel because it belongs to the depth, not to a panel:
 * it must disappear the moment the scope does, and nothing else should have to remember that.
 */
import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { HistoryManager, SeparateSelectionCommand } from '../core/HistoryManager.js';
import { logicalObjectPartIds } from '../core/LogicalObjects.js';
import { createIsolation } from './isolation';
import { applyModeShell, type ModeShell } from './modeShell';
import { escapeHtml } from './renderSafe.js';
import { tr } from './lib/tr.js';

/** Panels this depth cannot act on. Named here because the mode owns the decision (`modeShell`). */
export const DIM_SELECTORS = ['#outliner', '#right-panel', '#asset-panel', '#viewport-toolbar', '.ws-switcher'] as const;

const NOTICE_ID = 'part-scope-notice';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon and the legacy JS modules are untyped */
const isolation = createIsolation({
  scene: () => getState().scene as any,
  meshesOf: (partId) => {
    const mesh = (AssetLoader as any).getBabylonMesh?.(partId);
    return mesh ? [mesh] : [];
  },
});

let shell: ModeShell | null = null;
let on = false;

/** Picked parts of the scoped object: what Separate would take. */
function pickedParts(scopeId: string): string[] {
  const objects = getState().scene.objects as Record<string, unknown>;
  const parts = new Set(logicalObjectPartIds(scopeId, objects));
  return Selection.getSelectedIds().filter((id: string) => parts.has(id));
}

/** Every pickable part of the scoped object (a ghost is not one). */
function allParts(scopeId: string): string[] {
  const objects = getState().scene.objects as Record<string, { isGhost?: boolean } | undefined>;
  return logicalObjectPartIds(scopeId, objects).filter((id: string) => !objects[id]?.isGhost);
}

function notice(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const viewport = document.getElementById('viewport');
  if (!viewport) return null;
  let el = document.getElementById(NOTICE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = NOTICE_ID;
    el.className = 'part-scope-notice';
    el.setAttribute('role', 'status');
    el.dataset.ui = 'part-scope-notice';
    viewport.appendChild(el);
    el.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-action]');
      if ((target as HTMLElement | null)?.dataset.action === 'separate') separate();
      if ((target as HTMLElement | null)?.dataset.action === 'exit') Selection.exitScope();
    });
  }
  return el;
}

/** Run the separate on what is picked now, and leave the new object selected and the depth. */
export function separate(): boolean {
  const scope = Selection.getScope();
  if (scope == null || !Selection.inPartScope()) return false;
  const picked = pickedParts(scope);
  if (picked.length === 0 || picked.length === allParts(scope).length) return false;
  const command = new SeparateSelectionCommand(picked);
  const newId = command.newObjectId;
  if (!newId) return false;
  // Out of the depth FIRST: the object it is a depth of is about to lose these parts, so staying
  // inside would leave the operator in a scope describing something that no longer exists.
  Selection.exitScope();
  (HistoryManager as unknown as { execute(c: unknown): void }).execute(command);
  Selection.set([newId], newId);
  return true;
}

function render(): void {
  const scope = Selection.getScope();
  const inParts = scope != null && Selection.inPartScope();
  if (!inParts) {
    if (on) {
      isolation.clear();
      shell?.clear();
      shell = null;
      const el = typeof document === 'undefined' ? null : document.getElementById(NOTICE_ID);
      el?.remove();
      on = false;
    }
    return;
  }
  if (!on) {
    shell = applyModeShell('parts', DIM_SELECTORS);
    on = true;
  }
  // Re-applied on every change: a selection change inside the depth must not drop the isolation,
  // and `apply` re-reads the scene so a part added meanwhile is handled.
  isolation.apply([scope]);

  const el = notice();
  if (!el) return;
  const picked = pickedParts(scope);
  const total = allParts(scope).length;
  const name = (getState().scene.objects as Record<string, { name?: string } | undefined>)[scope]?.name ?? scope;
  // Why the action is off, rather than a dead button: picking nothing and picking everything are
  // both reasonable things to have done, and each has a different answer.
  const why = picked.length === 0
    ? tr('partScope.pickSome', 'Click the meshes to separate')
    : picked.length === total
      ? tr('partScope.pickedAll', 'That is every mesh — use Separate by material instead')
      : '';
  el.innerHTML = `
    <span class="psn-text">${escapeHtml(tr('partScope.title', 'Inside {name}').replace('{name}', String(name)))}
      <small>${escapeHtml(why || tr('partScope.ready', '{n} of {total} meshes picked').replace('{n}', String(picked.length)).replace('{total}', String(total)))}</small>
    </span>
    <button type="button" class="psn-action" data-action="separate"${why ? ' disabled' : ''}>${escapeHtml(tr('partScope.separate', 'Separate selection'))}</button>
    <button type="button" class="psn-exit" data-action="exit">${escapeHtml(tr('partScope.done', 'Done'))}</button>`;
}

/** Watch the scope. Safe to call once at boot; it does nothing until an object is entered. */
export function init(): void {
  for (const event of [EVENTS.SCOPE_CHANGED, EVENTS.SELECTION_CHANGED, EVENTS.LOCALE_CHANGED,
    EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE]) {
    subscribe(event, render);
  }
  render();
}

export const PartScopeMode = { init, separate, DIM_SELECTORS };
