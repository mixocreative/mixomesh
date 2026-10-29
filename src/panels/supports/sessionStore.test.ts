// Plan P3.4: the edit session follows Support Mode, the plain tool keys are registered in the
// mode's input context only, and Esc runs support selection, then the active tool, then leaves.
import '../../supports/testEnv';
import { describe, expect, it } from 'vitest';
import '../../core/HistoryManager.js';   // load order of the legacy core (as SupportMode.test)
import { createSupportMode, type SupportModeDeps } from '../../supports/SupportMode';
import { bindSupportSession, createSessionStore, TOOL_KEYS } from './sessionStore';

function harness(deleteSelection?: () => void) {
  const handlers = new Map<string, () => void>();
  const objects = { a: { id: 'a', name: 'A', visible: true, logicalObjectId: 'a' } };
  let selection = { ids: ['a'], activeId: 'a' as string | null };
  const deps: SupportModeDeps = {
    scene: () => ({ objects, groups: {} }),
    selection: () => selection,
    setSelection: (ids, activeId) => { selection = { ids, activeId }; },
    meshesOf: () => [],
    setGizmoOff: () => {},
    readOnly: () => false,
    input: {
      setMode: () => {},
      register: (key, ctx, fn) => { handlers.set(`${key}::${ctx}`, fn); },
      unregister: (key, ctx) => { handlers.delete(`${key}::${ctx}`); },
    },
    history: { setScope: () => {} },
    shell: { apply: () => {} },
    toast: () => {},
    subscribe: () => () => {},
    emit: () => {},
    t: (key) => key,
  };
  const mode = createSupportMode(deps);
  const store = createSessionStore();
  const unbind = bindSupportSession({ mode, input: deps.input, store, ...(deleteSelection ? { deleteSelection } : {}) });
  return { mode, store, handlers, unbind };
}

describe('bindSupportSession', () => {
  it('opens Edit with the Add tool on the first object when the mode opens, and resets on exit', () => {
    const h = harness();
    expect(h.store.get().mode).toBe('off');
    h.mode.enter();
    expect(h.store.get()).toMatchObject({ mode: 'edit', tool: 'add', activeUnitId: 'a', brushRadius: 24, zoneRadius: 2 });
    h.mode.exit();
    expect(h.store.get().mode).toBe('off');
    expect(h.store.get().activeUnitId).toBeUndefined();
  });

  it('registers the tool keys A S P E in the mode context only', () => {
    const h = harness();
    for (const key of Object.values(TOOL_KEYS)) expect(h.handlers.has(`${key}::supports`)).toBe(false);
    h.mode.enter();
    for (const key of Object.values(TOOL_KEYS)) expect(h.handlers.has(`${key}::supports`)).toBe(true);
    h.handlers.get('S::supports')!();
    expect(h.store.get()).toMatchObject({ mode: 'edit', tool: 'select' });
    h.handlers.get('P::supports')!();
    expect(h.store.get()).toMatchObject({ mode: 'zones', zoneKind: 'paint' });
    h.handlers.get('E::supports')!();
    expect(h.store.get()).toMatchObject({ mode: 'zones', zoneKind: 'erase' });
    h.handlers.get('A::supports')!();
    expect(h.store.get()).toMatchObject({ mode: 'edit', tool: 'add' });
    h.mode.exit();
    for (const key of Object.values(TOOL_KEYS)) expect(h.handlers.has(`${key}::supports`)).toBe(false);
  });

  it('Delete runs the delete-selection hook in the mode context only', () => {
    const calls: string[] = [];
    const h = harness(() => calls.push('delete'));
    expect(h.handlers.has('Delete::supports')).toBe(false);
    h.mode.enter();
    h.handlers.get('Delete::supports')!();
    expect(calls).toEqual(['delete']);
    h.mode.exit();
    expect(h.handlers.has('Delete::supports')).toBe(false);
  });

  it('Esc: the support selection first, then the active tool, then it leaves the mode', () => {
    const h = harness();
    h.mode.enter();
    h.store.send({ type: 'setTool', tool: 'select' });
    h.store.send({ type: 'paint', ids: ['x', 'y'], mode: 'select' });
    expect(h.store.get().selection.size).toBe(2);

    h.mode.escape();
    expect(h.store.get().selection.size).toBe(0);
    expect(h.store.get().tool).toBe('select');
    expect(h.mode.isActive()).toBe(true);

    h.mode.escape();
    expect(h.store.get().tool).toBe('add');
    expect(h.mode.isActive()).toBe(true);

    h.mode.escape();
    expect(h.mode.isActive()).toBe(false);
  });

  it('Esc from the support area returns to Edit before it leaves; a Remove click goes back to Add', () => {
    const h = harness();
    h.mode.enter();
    h.handlers.get('P::supports')!();
    h.mode.escape();
    expect(h.store.get().mode).toBe('edit');
    h.store.send({ type: 'setAddAction', action: 'remove' });
    h.mode.escape();
    expect(h.store.get()).toMatchObject({ tool: 'add', addAction: 'add' });
    expect(h.mode.isActive()).toBe(true);
    h.mode.escape();
    expect(h.mode.isActive()).toBe(false);
  });

  it('hooks are removed by unbind', () => {
    const h = harness();
    h.mode.enter();
    h.unbind();
    h.mode.escape();
    expect(h.mode.isActive()).toBe(false);
  });
});
