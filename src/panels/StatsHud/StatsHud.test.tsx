// Core modules read window.BABYLON at import time; a permissive stub is enough because the HUD
// only counts fake meshes from the registry.
vi.hoisted(() => {
  const stub = (): unknown => new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
  (globalThis as unknown as { BABYLON: unknown }).BABYLON = stub();
});
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { StateManager, setState } from '../../core/StateManager.js';
import * as Registry from '../../core/assets/MeshRegistry.js';
import { bump } from '../../core/geometry/GeometryStore.js';
import { countSceneTriangles } from '../../core/scene/TriangleCount.js';
import { StatsHud } from './StatsHud.tsx';

vi.mock('../../ui/Status.js', () => ({ reportError: vi.fn() }));

const fakeMesh = (meshId: string, tris: number) => {
  const m = {
    metadata: { meshId }, geometry: {}, isVisible: true, tris,
    getTotalIndices: () => m.tris * 3, getTotalVertices: () => m.tris,
    setEnabled(on: boolean) { (m as { enabled?: boolean }).enabled = on; },
    isEnabled() { return (m as { enabled?: boolean }).enabled !== false; },
  };
  return m;
};

function scene(objects: Record<string, ReturnType<typeof fakeMesh>>, selected: string[] = []) {
  StateManager.replaceState(StateManager.freshState());
  for (const [id, m] of Object.entries(objects)) Registry.registerMesh(id, m);
  setState((s: { scene: object; selection: object }) => ({
    ...s,
    scene: { ...s.scene, objects: Object.fromEntries(Object.keys(objects).map((id) => [id, { id, name: id, visible: true }])) },
    selection: { ...s.selection, selectedIds: selected, activeId: selected[0] ?? null },
  }), { silent: true });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.querySelector(sel);

beforeEach(() => {
  document.body.innerHTML = '<main id="viewport"></main>';
});
afterEach(() => { StatsHud.unmount(); StatsHud.setClock(null); });

describe('StatsHud', () => {
  it('budget count and HUD snapshot agree after a delete', () => {
    const heavy = fakeMesh('mesh_heavy', 5_000_000);
    scene({ mesh_heavy: heavy, mesh_small: fakeMesh('mesh_small', 8) });
    heavy.setEnabled(false);
    setState((s: { scene: { objects: Record<string, unknown> } }) => {
      const { mesh_heavy: _gone, ...objects } = s.scene.objects;
      return { ...s, scene: { ...s.scene, objects } };
    }, { silent: true });
    expect(StatsHud.snapshot().tris).toBe(countSceneTriangles());
    expect(StatsHud.snapshot().tris).toBe(8);
  });

  it('shows before -> after for a geometry change, then settles; hide button persists', async () => {
    const mesh = fakeMesh('mesh_sub', 200);
    scene({ mesh_sub: mesh }, ['mesh_sub']);
    let now = 10_000;
    StatsHud.setClock(() => now);
    await act(async () => { StatsHud.init(); });
    expect(q('#stats-hud-root.mx-kit')).not.toBeNull();
    expect(q('.sh-tris')?.textContent).toBe('Faces 200');
    expect(q('.sh-scope')?.textContent).toMatch(/Selected 1 \/ 1/);

    mesh.tris = 800;
    bump('mesh_sub');
    await flush();
    expect(q('.sh-tris')?.textContent).toBe('Faces 200 → 800');
    expect(q('.sh-tris')?.classList.contains('sh-changed')).toBe(true);

    now += 3100;
    await act(async () => { StatsHud.refresh(false); });
    expect(q('.sh-tris')?.textContent).toBe('Faces 800');
    expect(q('.sh-tris')?.classList.contains('sh-changed')).toBe(false);

    const onToggle = vi.fn();
    StatsHud.onVisibilityChange(onToggle);
    await act(async () => { (q('.sh-hide') as HTMLButtonElement).click(); });
    expect((q('#stats-hud') as HTMLElement).hidden).toBe(true);
    expect(onToggle).toHaveBeenCalled();
    await act(async () => { StatsHud.setStatsVisible(true); });
    expect((q('#stats-hud') as HTMLElement).hidden).toBe(false);
  });

  it('keeps the same DOM when the readout is unchanged', async () => {
    scene({ a: fakeMesh('a', 12) }, ['a']);
    await act(async () => { StatsHud.init(); });
    const before = q('.stats-hud')!;
    await act(async () => { StatsHud.refresh(false); StatsHud.refresh(false); });
    expect(q('.stats-hud')).toBe(before);
    expect(q('.sh-tris')?.textContent).toBe('Faces 12');
  });
});
