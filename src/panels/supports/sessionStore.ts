/**
 * The Support Mode editing session (plan P3.4): the shared reducer of `@mixo-geocore/editing`
 * (mode, tool, select style, brush, zone brush, selected tips) held in one small store. View state
 * only, never in the undo history (D21); the panels read it with `useSession`, the viewport layers
 * (P3.3 / P3.5) read the same object, so a tool and a ring can never disagree.
 *
 * `bindSupportSession` ties it to the Support Mode controller: it opens Edit when the mode opens,
 * registers the two Esc stages (selection, then tool; leaving the mode is the controller's third)
 * and the plain tool keys of the mode's input context.
 */
import { useSyncExternalStore } from 'react';
import { initialSession, reduceSession, type EditSession, type SessionEvent } from '@mixo-geocore/editing/session';
import type { SupportModeController } from '../../supports/SupportMode';

export interface SessionStore {
  get(): EditSession;
  send(event: SessionEvent): void;
  subscribe(fn: () => void): () => void;
  /** Back to the empty session (the mode ended). */
  reset(): void;
}

export function createSessionStore(): SessionStore {
  let state: EditSession = initialSession;
  const listeners = new Set<() => void>();
  const set = (next: EditSession) => {
    if (next === state) return;
    state = next;
    listeners.forEach((fn) => fn());
  };
  return {
    get: () => state,
    send: (event) => set(reduceSession(state, event)),
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    reset: () => set(initialSession),
  };
}

export const supportSession: SessionStore = createSessionStore();

export function useSession(store: SessionStore = supportSession): EditSession {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The mode's tool keys (plain keys, free inside the mode's input context). */
export const TOOL_KEYS = { add: 'A', select: 'S', paint: 'P', erase: 'E' } as const;

/** Edit with the Add tool, from wherever the session is (zones included). */
export function chooseTool(store: SessionStore, tool: 'add' | 'select'): void {
  if (store.get().mode === 'zones') store.send({ type: 'exit' });
  if (store.get().mode === 'off') store.send({ type: 'enterEdit' });
  store.send({ type: 'setTool', tool });
}

/** Paint or Erase of the support area: enters the zones mode when the session is elsewhere. */
export function chooseZoneKind(store: SessionStore, kind: 'paint' | 'erase'): void {
  if (store.get().mode === 'edit') store.send({ type: 'exit' });
  if (store.get().mode === 'off') store.send({ type: 'enterZones' });
  store.send({ type: 'setZoneKind', kind });
}

export interface SessionBindDeps {
  mode: Pick<SupportModeController, 'onChange' | 'addEscapeHook' | 'isActive' | 'getObjectIds'>;
  input: { register(key: string, context: string, fn: () => void): void; unregister(key: string, context: string): void };
  store?: SessionStore;
  /** The object the session belongs to (the panel's target, default the first of the mode). */
  target?(ids: readonly string[]): string | undefined;
  /** Delete key: remove the selected supports (the panel's Delete button does the same). */
  deleteSelection?(): void;
}

/** Wire the session to the mode controller. Returns the unbind call. */
export function bindSupportSession({ mode, input, store = supportSession, target = (ids) => ids[0], deleteSelection }: SessionBindDeps): () => void {
  const offs: Array<() => void> = [];
  const keys: Array<[string, () => void]> = [
    [TOOL_KEYS.add, () => chooseTool(store, 'add')],
    [TOOL_KEYS.select, () => chooseTool(store, 'select')],
    [TOOL_KEYS.paint, () => chooseZoneKind(store, 'paint')],
    [TOOL_KEYS.erase, () => chooseZoneKind(store, 'erase')],
    ['Delete', () => deleteSelection?.()],
  ];

  // Esc stage 1: the selected supports.
  offs.push(mode.addEscapeHook('selection', () => {
    if (store.get().selection.size === 0) return false;
    store.send({ type: 'clearSelection' });
    return true;
  }));
  // Esc stage 2: the active tool goes back to the resting one (Add, a click adds; zones back to Edit).
  offs.push(mode.addEscapeHook('tool', () => {
    const s = store.get();
    if (s.mode === 'zones') {
      store.send({ type: 'exit' });
      store.send({ type: 'enterEdit' });
      return true;
    }
    if (s.mode === 'edit' && (s.tool !== 'add' || s.addAction !== 'add')) {
      store.send({ type: 'setTool', tool: 'add' });
      store.send({ type: 'setAddAction', action: 'add' });
      return true;
    }
    return false;
  }));

  let wasActive = false;
  const follow = () => {
    const active = mode.isActive();
    if (active && !wasActive) {
      for (const [key, fn] of keys) input.register(key, 'supports', fn);
      store.send({ type: 'activeUnitChanged', id: target(mode.getObjectIds()) });
      store.send({ type: 'enterEdit' });
    } else if (!active && wasActive) {
      for (const [key] of keys) input.unregister(key, 'supports');
      store.reset();
    } else if (active) {
      store.send({ type: 'activeUnitChanged', id: target(mode.getObjectIds()) });
    }
    wasActive = active;
  };
  offs.push(mode.onChange(follow));
  follow();
  return () => {
    offs.forEach((off) => off());
    if (wasActive) for (const [key] of keys) input.unregister(key, 'supports');
    wasActive = false;
    store.reset();
  };
}
