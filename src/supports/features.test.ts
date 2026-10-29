import './testEnv';
// Tree, brace (with pruning), raft and label through the mixomesh job path (plan P5.1-P5.4): the
// same placement + `buildJob` the live code runs, on the cube-overhang golden and on a crossing model.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { runSupportJob } from '@mixo-geocore/host/supports/jobRunner';
import { defaultSupportSettings, presetValues, toPlacementSettings, updateSetting, type LiveSupportSettings, type SettingKey } from '@mixo-geocore/host/core/supports/settings';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { emptySupports } from './model';
import { buildJob, REPAIR_BUDGET } from './live/jobInputs';
import { tipCount, toLocal } from './supportJob';
import golden from '../../tests/fixtures/support-golden-cube-overhang.json';
import { cubeOverhang } from '../../tests/fixtures/support-cubes.mjs';

const VENDOR = fileURLToPath(new URL('../../public/vendor/mixo-geocore/', import.meta.url));

beforeAll(async () => {
  configureGeometry(pathToFileURL(VENDOR + 'mixo_geometry_wasm.js').href, readFileSync(VENDOR + 'mixo_geometry_wasm_bg.wasm'));
  await geometryReady();
});

const base = (): LiveSupportSettings => ({ ...defaultSupportSettings, roofSeededModes: [] });
const set = (s: LiveSupportSettings, patch: Partial<Record<SettingKey, unknown>>): LiveSupportSettings =>
  Object.entries(patch).reduce((acc, [k, v]) => updateSetting(acc, k as SettingKey, v as never), s);

function liftedBy(mesh: TriangleMesh, lift: number): TriangleMesh {
  let minY = Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) minY = Math.min(minY, mesh.positions[i]!);
  const positions = Float32Array.from(mesh.positions, (v, i) => (i % 3 === 1 ? v - minY + lift : v));
  return { positions, indices: mesh.indices };
}

function build(mesh: TriangleMesh, settings: LiveSupportSettings, name = 'Test part', keep: (position: readonly number[]) => boolean = () => true, budget = REPAIR_BUDGET) {
  // As the app stands an object: lifted so its lowest point is `liftHeight` above the bed (plate y = 0).
  const model = toLocal(liftedBy(mesh, settings.liftHeight));
  const placement = placeGeneric(model.local, toPlacementSettings(settings));
  const record = { ...emptySupports(settings), settings };
  const inputs = { points: placement.points, manual: [], deleted: placement.points.filter((p) => !keep(p.position)).map((p) => p.id), zones: [], contactSettings: {} };
  const job = { ...buildJob(model, record, inputs, name), repairBudget: budget };
  return { placement, job, built: runSupportJob(job, undefined, 1) };
}

/** Two floating plates either side of a wall that stands on the bed: braces between their pillars cross the wall. */
function crossingModel(): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const o = positions.length / 3;
    for (const y of [y0, y1]) for (const z of [z0, z1]) for (const x of [x0, x1]) positions.push(x, y, z);
    // corner order: x fastest, then z, then y
    const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const [a, b, c, d] of f) indices.push(o + a!, o + c!, o + b!, o + a!, o + d!, o + c!);
  };
  box(-5, -0.6, 10, 12, -4, 4);
  box(0.6, 5, 10, 12, -4, 4);
  box(-0.3, 0.3, 0, 12, -8, 8);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Triangle count plus a coordinate checksum: parameter changes that move vertices without adding triangles still differ. */
const sig = (m: TriangleMesh): string => `${m.indices.length / 3}:${m.positions.reduce((a, v, i) => a + v * ((i % 7) + 1), 0).toFixed(3)}`;

describe('P5.1 tree (golden cube-overhang tree variant)', () => {
  it('tree on, the golden policy (no repair budget): 70 placement points and tips as the golden, trunks and branches, no braces', () => {
    const { placement, built } = build(cubeOverhang(), set(base(), { scatterAutoTree: true, labelText: 'A' }), 'Cube', undefined, 0);
    expect(placement.points.length).toBe(golden.placementPoints);
    // mixo-geocore goldens/__snapshots__/cube-overhang.tree.json: 62 contacts, 14680 triangles, and per part
    // neck 34, pillar 68, foot 34, tree-branch 28, tree-trunk 7, raft 17, label 2.
    expect(tipCount(built)).toBe(62);
    expect(Math.abs(built.indices.length / 3 - 14680)).toBeLessThan(14680 * 0.01); // the 1 um snap of toLocal moves a few facets
    const perPart = built.components.reduce<Record<string, number>>((a, c) => ((a[c.part] = (a[c.part] ?? 0) + 1), a), {});
    expect(perPart).toEqual({ neck: 34, pillar: 68, foot: 34, 'tree-branch': 28, 'tree-trunk': 7, raft: 17, label: 2 });
    expect(built.parts).toContain('tree-trunk');
    expect(built.parts).toContain('tree-branch');
    expect(built.parts).not.toContain('brace');
    expect(built.fallbacks ?? []).toEqual([]);
  });
  it('with the live repair budget the tree that would cross the model falls back to braces and says so', () => {
    const { placement, built } = build(cubeOverhang(), set(base(), { scatterAutoTree: true }));
    expect(placement.points.length).toBe(golden.placementPoints);
    expect(tipCount(built)).toBe(golden.tips);
    expect(built.fallbacks).toEqual(['tree']);
    expect(built.parts).not.toContain('tree-trunk');
  });
  it('tree off: braces and no tree parts', () => {
    const { built } = build(cubeOverhang(), base());
    expect(built.parts).toContain('brace');
    expect(built.parts).not.toContain('tree-trunk');
  });
  it('merge distance, branch descent and safe distance reach the engine (the mesh changes)', () => {
    const run = (patch: Partial<Record<SettingKey, unknown>>) => sig(build(cubeOverhang(), set(base(), { scatterAutoTree: true, ...patch }), 'Cube', undefined, 0).built);
    const a = run({});
    expect(run({ scatterMergeDistance: 6 })).not.toBe(a);
    expect(run({ scatterSafeDistance: 2 })).not.toBe(a);
    expect(run({ scatterBranchDescent: 8 })).not.toBe(a);
  });
  it('merge distance is 2, 3, 4 mm by preset', () => {
    expect([presetValues.LIGHT, presetValues.MIDDLE, presetValues.HEAVY].map((v) => v.scatterMergeDistance)).toEqual([2, 3, 4]);
  });
});

describe('P5.2 braces with pruning', () => {
  it('the live job carries the repair budget', () => {
    expect(build(cubeOverhang(), base()).job.repairBudget).toBe(REPAIR_BUDGET);
    expect(REPAIR_BUDGET).toBeGreaterThanOrEqual(3);
  });
  it('braces off removes the brace part; spacing changes the mesh', () => {
    expect(build(cubeOverhang(), set(base(), { trussEnabled: false })).built.parts).not.toContain('brace');
    const tri = (patch: Partial<Record<SettingKey, unknown>>) => sig(build(cubeOverhang(), set(base(), patch)).built);
    expect(tri({ trussSpacing: 4 })).not.toBe(tri({}));
  });
  it('a model that braces would cross: pruning reports brace-pruned and keeps the other braces', () => {
    const open = build(crossingModel(), base(), 'Wall', (p) => Math.abs(p[0]!) > 0.8);
    expect(open.built.fallbacks).toContain('brace-pruned');
    expect(open.built.parts).toContain('brace');
    // With no budget the repair only reports (the old behaviour): nothing is pruned.
    const none = build(crossingModel(), base(), 'Wall', (p) => Math.abs(p[0]!) > 0.8, 0);
    expect(none.built.fallbacks ?? []).not.toContain('brace-pruned');
    // Pruning drops only the crossing braces: fewer than the unpruned build, not none.
    const braceTris = (b: typeof open.built) => b.components.filter((c) => c.part === 'brace').reduce((a, c) => a + c.count / 3, 0);
    expect(braceTris(open.built)).toBeGreaterThan(0);
    expect(braceTris(open.built)).toBeLessThan(braceTris(none.built));
  });
});

describe('P5.3 raft', () => {
  it('on by default; off removes the raft part; parameters change the mesh', () => {
    expect(build(cubeOverhang(), base()).built.parts).toContain('raft');
    expect(build(cubeOverhang(), set(base(), { raftEnabled: false })).built.parts).not.toContain('raft');
    const tri = (patch: Partial<Record<SettingKey, unknown>>) => sig(build(cubeOverhang(), set(base(), patch)).built);
    const a = tri({});
    expect(tri({ raftExpandWidth: 6 })).not.toBe(a);
    expect(tri({ raftWallAngle: 60 })).not.toBe(a);
    // The app's own cap (the engine never returns at 90 degrees): a stored 120 is built as 89.
    const stored = build(cubeOverhang(), set(base(), { raftWallAngle: 90 }));
    expect(stored.job.settings.raftWallAngle).toBe(89);
    expect(stored.built.parts).toContain('raft');
  });
});

describe('P5.4 label', () => {
  it('on: a label part; off: none; text changes the mesh', () => {
    const on = build(cubeOverhang(), base(), 'Cube 1');
    expect(on.built.parts).toContain('label');
    expect(on.job.labelText).toBe('CUBE-1');
    expect(build(cubeOverhang(), set(base(), { labelEnabled: false })).built.parts).not.toContain('label');
    const tri = (text: string) => sig(build(cubeOverhang(), set(base(), { labelText: text })).built);
    expect(tri('AB')).not.toBe(tri('W-W-W-W'));
  });
});
