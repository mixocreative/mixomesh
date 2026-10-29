vi.hoisted(() => {
  const stub = (): unknown => new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
  (globalThis as unknown as { BABYLON: unknown }).BABYLON = stub();
});
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import * as BABYLON from '@babylonjs/core';
import { SHEET_DEFAULTS, isNoopValues, planSheetTransform } from './sheetPlan.ts';

vi.mock('../../ui/Status.js', () => ({ reportError: vi.fn() }));
vi.mock('../../core/print/ExportContext.js', () => ({ BU_TO_MM: 1000 }));
vi.mock('../../ui/Toast.js', () => ({ Toast: { show: vi.fn() } }));
const built = vi.hoisted(() => ({ calls: [] as unknown[], status: 'applied' as string }));
vi.mock('./buildSheetCommand.ts', () => ({
  buildSheetCommand: (v: unknown) => {
    built.calls.push(v);
    return built.status === 'applied'
      ? { status: 'applied', command: { label: 'Transform', execute() {}, undo() {} } }
      : { status: built.status };
  },
}));
import { TransformSheet } from './TransformSheet.tsx';

const near = (a: number, b: number, e = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(e);
const ident = { x: 0, y: 0, z: 0, w: 1 };
const snap = (x: number, y: number, z: number, s = 1) => ({ position: { x, y, z }, rotation: { ...ident }, scaling: { x: s, y: s, z: s } });

describe('planSheetTransform', () => {
  beforeAll(() => { (window as unknown as { BABYLON: unknown }).BABYLON = BABYLON; });

  it('defaults are a no-op', () => {
    expect(isNoopValues({ ...SHEET_DEFAULTS })).toBe(true);
    expect(isNoopValues({ ...SHEET_DEFAULTS, moveX: 1 })).toBe(false);
  });

  it('move converts mm to BU and offsets every node', () => {
    const { prev, next, noop } = planSheetTransform(
      [{ id: 'a', snap: snap(0, 0, 0) }, { id: 'b', snap: snap(1, 2, 3) }],
      { x: 0, y: 0, z: 0 }, { ...SHEET_DEFAULTS, moveX: 10, moveY: -5 }, 1000);
    expect(noop).toBe(false);
    expect(prev.a.position.x).toBe(0);
    near(next.a.position.x, 0.01);
    near(next.a.position.y, -0.005);
    near(next.b.position.x, 1.01);
    near(next.b.position.z, 3);
  });

  it('rotate 90 deg about Y around the pivot', () => {
    const { next } = planSheetTransform([{ id: 'a', snap: snap(2, 0, 0) }], { x: 1, y: 0, z: 0 }, { ...SHEET_DEFAULTS, rotY: 90 }, 1000);
    near(next.a.position.x, 1);
    near(next.a.position.z, -1);
    const q = next.a.rotation;
    near(Math.hypot(q.x, q.y, q.z, q.w), 1);
    near(Math.abs(q.y), Math.SQRT1_2);
  });

  it('scale % is uniform about the pivot and multiplies scaling', () => {
    const { next } = planSheetTransform([{ id: 'a', snap: snap(3, 0, 0, 2) }], { x: 1, y: 0, z: 0 }, { ...SHEET_DEFAULTS, scalePct: 50 }, 1000);
    near(next.a.position.x, 2);
    near(next.a.scaling.x, 1);
  });
});

describe('TransformSheet panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="viewport"></main>';
    built.calls = [];
    built.status = 'applied';
  });
  afterEach(() => { TransformSheet.unmount(); });
  const q = (s: string) => document.querySelector(s);

  it('is closed until toggled, then Enter applies typed values as one command and resets', async () => {
    await act(async () => { TransformSheet.init(document.getElementById('viewport')); });
    expect(q('.transform-sheet')).toBeNull();
    await act(async () => { TransformSheet.toggle(); });
    expect(q('.transform-sheet')).not.toBeNull();
    expect(TransformSheet.isOpen()).toBe(true);

    const move = q('[role="group"][aria-label="Move"]')!;
    const x = move.querySelector('input') as HTMLInputElement;
    await act(async () => { fireEvent.change(x, { target: { value: '12,5' } }); fireEvent.keyDown(x, { key: 'Enter' }); });
    expect(built.calls).toHaveLength(1);
    expect(built.calls[0]).toMatchObject({ moveX: 12.5, scalePct: 100 });
    expect(x.value).toBe('0');
  });

  it('keys never leak to the canvas; Escape closes', async () => {
    await act(async () => { TransformSheet.init(document.getElementById('viewport')); TransformSheet.open(); });
    const leaked = vi.fn();
    document.addEventListener('keydown', leaked);
    const input = q('.transform-sheet input') as HTMLInputElement;
    await act(async () => { fireEvent.keyDown(input, { key: 'g' }); });
    expect(leaked).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(q('.transform-sheet')).toBeNull();
    document.removeEventListener('keydown', leaked);
  });

  it('nothing selected pushes no command', async () => {
    built.status = 'nothing';
    await act(async () => { TransformSheet.init(document.getElementById('viewport')); TransformSheet.open(); });
    await act(async () => { (q('.ts-apply') as HTMLButtonElement).click(); });
    expect(built.calls).toHaveLength(1);
  });
});
