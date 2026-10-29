// Core modules read window.BABYLON at import time; a permissive stub is enough
// because these tests never touch a scene.
vi.hoisted(() => {
  const stub = (): unknown => new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
  (globalThis as unknown as { BABYLON: unknown }).BABYLON = stub();
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { dispatch, subscribe } from '../core/StateManager.js';
import { undo, clear, getUndoLabel } from '../core/HistoryManager.js';
import { useStore, useCommand, mountPanel, PanelErrorBoundary } from './index.ts';

vi.mock('../ui/Status.js', () => ({ reportError: vi.fn() }));

let count = 0;
const cmd = (label: string) => ({
  label,
  execute: () => { count++; },
  undo: () => { count--; },
});

beforeEach(() => { clear(); count = 0; });

describe('useStore', () => {
  it('re-renders on its own event only, and derived objects do not loop', () => {
    let v = 0;
    const s = { n: 0 }, o = { n: 0 }, d = { n: 0 };
    function S() { s.n++; return <p>{useStore(['test:s'], () => v)}</p>; }
    function Other() { o.n++; return <p>{useStore(['test:other'], () => v)}</p>; }
    function Derived() { d.n++; useStore(['test:s'], () => ({ x: 1 }), (a, b) => a.x === b.x); return null; }
    const { container } = render(<><S /><Other /><Derived /></>);
    const s0 = s.n, o0 = o.n, d0 = d.n;
    v = 5;
    act(() => dispatch('test:s'));
    expect(container.textContent).toBe('50');
    expect(s.n).toBeGreaterThan(s0);
    expect(o.n).toBe(o0);
    expect(d.n).toBe(d0);
  });
});

describe('useCommand', () => {
  function grab() {
    const ref: { api?: ReturnType<typeof useCommand> } = {};
    function G() { ref.api = useCommand(); return null; }
    render(<G />);
    return ref.api!;
  }
  it('run pushes exactly one entry', () => {
    const api = grab();
    const pushed: string[] = [];
    subscribe('history:pushed', (p: { label: string }) => pushed.push(p.label));
    api.run(cmd('one'));
    expect(pushed).toEqual(['one']);
    expect(getUndoLabel()).toBe('one');
  });
  it('batch groups into one undo step', () => {
    const api = grab();
    const pushed: string[] = [];
    subscribe('history:pushed', (p: { label: string }) => pushed.push(p.label));
    api.batch('group', () => { api.run(cmd('a')); api.run(cmd('b')); });
    expect(count).toBe(2);
    expect(pushed).toEqual(['group']);
    expect(getUndoLabel()).toBe('group');
    undo();
    expect(count).toBe(0);
  });
});

describe('mountPanel', () => {
  it('is idempotent and unmount removes all listeners', async () => {
    document.body.innerHTML = '<div id="p"></div>';
    const fn = vi.fn(); let tick = 0;
    function P() { fn(); return <p>{useStore(['test:leak'], () => tick)}</p>; }
    let unmount!: () => void;
    await act(async () => { unmount = mountPanel('p', <P />); });
    await act(async () => { mountPanel('p', <P />); });
    fn.mockClear();
    tick++;
    act(() => dispatch('test:leak'));
    expect(fn).toHaveBeenCalled();   // live before unmount
    await act(async () => unmount());
    fn.mockClear();
    tick++;
    act(() => dispatch('test:leak'));
    expect(fn).not.toHaveBeenCalled();
  });
  it('error boundary reports a throwing child', () => {
    const reporter = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): never { throw new Error('boom'); }
    render(<PanelErrorBoundary reporter={reporter}><Boom /></PanelErrorBoundary>);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect((reporter.mock.calls[0][0] as Error).message).toBe('boom');
    err.mockRestore();
  });
});
