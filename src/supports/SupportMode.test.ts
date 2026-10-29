// Plan P3.2: Support Mode controller logic against a fake environment (the browser smoke
// tests/browser-support-mode-smoke.mjs proves the same on the real scene).
import './testEnv';
/* eslint-disable @typescript-eslint/no-explicit-any -- scene state is untyped JS */
import { beforeEach, describe, expect, it } from 'vitest';
import { EVENTS } from '../core/events.js';
import { HistoryManager } from '../core/HistoryManager.js';
import { ISOLATION_LAYER, createSupportMode, supportTargets, type SupportModeDeps } from './SupportMode';

const object = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, logicalObjectId: null, isInternalPart: false, ...extra });
const scene = () => ({
  objects: {
    a: object('a', { logicalObjectId: 'a' }),
    a2: object('a2', { logicalObjectId: 'a', isInternalPart: true }),
    b: object('b'),
    c: object('c'),
    ghost: object('ghost', { isGhost: true }),
  } as Record<string, any>,
  groups: { g: { id: 'g', childIds: ['b', 'c'], parentId: null } } as Record<string, any>,
});

class Mesh { layerMask = 0x0fffffff; }

function harness(readOnly = false) {
  const meshes: Record<string, Mesh> = { a: new Mesh(), a2: new Mesh(), b: new Mesh(), c: new Mesh() };
  const sel = { ids: ['a'], activeId: 'a' as string | null };
  const handlers = new Map<string, () => void>();
  const subs = new Map<string, Set<() => void>>();
  const log: string[] = [];
  const toasts: string[] = [];
  const state = scene();
  const deps: SupportModeDeps = {
    scene: () => state,
    selection: () => ({ ids: [...sel.ids], activeId: sel.activeId }),
    setSelection: (ids, activeId) => { sel.ids = ids; sel.activeId = activeId; log.push('setSelection'); },
    meshesOf: (id) => (meshes[id] ? [meshes[id]] : []),
    setGizmoOff: (off) => log.push(`gizmoOff:${off}`),
    readOnly: () => readOnly,
    input: {
      setMode: (m) => log.push(`mode:${m}`),
      register: (k, ctx, fn) => handlers.set(`${k}::${ctx}`, fn),
      unregister: (k, ctx) => handlers.delete(`${k}::${ctx}`),
    },
    history: HistoryManager as any,
    shell: { apply: (on, n) => log.push(`shell:${on}:${n}`) },
    toast: (m) => toasts.push(m),
    subscribe: (e, fn) => { (subs.get(e) ?? subs.set(e, new Set()).get(e)!).add(fn); return () => subs.get(e)!.delete(fn); },
    emit: (e, d) => log.push(`emit:${e}:${d.active}`),
    t: (k) => k,
  };
  return { deps, meshes, sel, handlers, subs, log, toasts, state, mode: createSupportMode(deps) };
}

const fire = (subs: Map<string, Set<() => void>>, event: string) => [...(subs.get(event) ?? [])].forEach((fn) => fn());

beforeEach(() => HistoryManager.clear());

describe('supportTargets', () => {
  it('maps parts to the lead, groups to their objects, drops ghosts and duplicates', () => {
    const s = scene();
    expect(supportTargets(s, ['a2'])).toEqual(['a']);
    expect(supportTargets(s, ['a', 'a2', 'ghost'])).toEqual(['a']);
    expect(supportTargets(s, ['g'])).toEqual(['b', 'c']);
    expect(supportTargets(s, [])).toEqual([]);
  });
});

describe('enter / exit', () => {
  it('hides every non-selected object with the mask only, and restores it', () => {
    const h = harness();
    expect(h.mode.enter()).toBe(true);
    expect(h.meshes.a!.layerMask).toBe(0x0fffffff);
    expect(h.meshes.a2!.layerMask).toBe(0x0fffffff);   // part of the selected logical object
    expect(h.meshes.b!.layerMask).toBe(ISOLATION_LAYER);
    expect(h.meshes.c!.layerMask).toBe(ISOLATION_LAYER);
    expect(h.state.objects.b.visible).toBeUndefined();   // object visibility untouched
    expect(h.log).toEqual(expect.arrayContaining(['gizmoOff:true', 'mode:supports', 'shell:true:1']));
    expect(h.handlers.has('Escape::supports')).toBe(true);
    expect(h.mode.exit()).toBe(true);
    expect(h.meshes.b!.layerMask).toBe(0x0fffffff);
    expect(h.log).toEqual(expect.arrayContaining(['gizmoOff:false', 'mode:null', 'shell:false:0']));
    expect(h.handlers.size).toBe(0);
  });

  it('is disabled without a selected object and in the read-only viewer', () => {
    const h = harness();
    h.sel.ids = []; h.sel.activeId = null;
    expect(h.mode.targetCount()).toBe(0);
    expect(h.mode.enter()).toBe(false);
    expect(harness(true).mode.enter()).toBe(false);
  });

  it('restores the selection when it changed during the mode', () => {
    const h = harness();
    h.mode.enter();
    h.sel.ids = ['b']; h.sel.activeId = 'b';
    h.mode.exit();
    expect(h.sel).toEqual({ ids: ['a'], activeId: 'a' });
  });

  it('exits on a loaded project and when its objects are gone', () => {
    const h = harness();
    h.mode.enter();
    fire(h.subs, EVENTS.PROJECT_LOADED);
    expect(h.mode.isActive()).toBe(false);
    h.mode.enter();
    delete h.state.objects.a;
    fire(h.subs, EVENTS.OBJECT_REMOVED);
    expect(h.mode.isActive()).toBe(false);
  });

  it('re-masks an object added during the mode', () => {
    const h = harness();
    h.mode.enter();
    h.meshes.d = new Mesh(); h.state.objects.d = object('d');
    fire(h.subs, EVENTS.ASSET_INSTANTIATED);
    expect(h.meshes.d.layerMask).toBe(ISOLATION_LAYER);
  });
});

describe('Esc order', () => {
  it('support selection, then the active tool, then leaves the mode', () => {
    const h = harness();
    h.mode.enter();
    let selected = true, tool = true;
    h.mode.addEscapeHook('tool', () => { if (!tool) return false; tool = false; return true; });
    h.mode.addEscapeHook('selection', () => { if (!selected) return false; selected = false; return true; });
    h.handlers.get('Escape::supports')!();
    expect([selected, tool, h.mode.isActive()]).toEqual([false, true, true]);
    h.handlers.get('Escape::supports')!();
    expect([selected, tool, h.mode.isActive()]).toEqual([false, false, true]);
    h.handlers.get('Escape::supports')!();
    expect(h.mode.isActive()).toBe(false);
  });

  it('Shift+S inside the mode leaves it', () => {
    const h = harness();
    h.mode.enter();
    h.handlers.get('Shift+S::supports')!();
    expect(h.mode.isActive()).toBe(false);
  });
});

describe('mode-scoped undo', () => {
  const cmd = (label: string, supports: boolean, hit: string[]) => ({
    label, ...(supports ? { supportsCommand: true } : {}),
    execute: () => { hit.push(`do:${label}`); },
    undo: () => { hit.push(`undo:${label}`); },
  });

  it('only walks support commands, including inside a batch; an older step stays and a toast says why', () => {
    const hit: string[] = [];
    HistoryManager.push(cmd('move', false, hit));
    const h = harness();
    h.mode.enter();
    HistoryManager.push(cmd('s1', true, hit));
    HistoryManager.beginBatch('batch');
    HistoryManager.push(cmd('s2', true, hit));
    HistoryManager.push(cmd('s3', true, hit));
    HistoryManager.endBatch();
    HistoryManager.undo();                       // the batch
    expect(hit.slice(-2)).toEqual(['undo:s3', 'undo:s2']);
    HistoryManager.undo();                       // s1
    expect(hit.at(-1)).toBe('undo:s1');
    const n = hit.length;
    HistoryManager.undo();                       // "move" is older and not a support command
    expect(hit.length).toBe(n);
    expect(h.toasts).toEqual(['supportMode.undoBlocked']);
    expect(HistoryManager.getUndoLabel()).toBe('move');
    HistoryManager.redo();                       // s1 back
    expect(hit.at(-1)).toBe('do:s1');
    h.mode.exit();
    HistoryManager.undo();                       // s1 again (outside the mode: the plain stack)
    HistoryManager.undo();                       // now "move" can be undone
    expect(hit.at(-1)).toBe('undo:move');
  });

  it('a mixed batch is not a support step', () => {
    const hit: string[] = [];
    const h = harness();
    h.mode.enter();
    HistoryManager.beginBatch('mixed');
    HistoryManager.push(cmd('s', true, hit));
    HistoryManager.push(cmd('x', false, hit));
    HistoryManager.endBatch();
    HistoryManager.undo();
    expect(hit).toEqual(['do:s', 'do:x']);
    expect(h.toasts).toHaveLength(1);
  });
});
