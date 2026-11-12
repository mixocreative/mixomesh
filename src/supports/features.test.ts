import './testEnv';
// Tree, brace (with pruning), raft and label through the mixomesh job path (plan P5.1-P5.4): the
// same placement + `buildJob` the live code runs, on the cube-overhang golden and on a crossing model.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { runSupportJob } from '@mixo-geocore/host/supports/jobRunner';
import { defaultSupportSettings, presetValues, setRoofMode, toPlacementSettings, updateSetting, type LiveSupportSettings, type SettingKey } from '@mixo-geocore/host/core/supports/settings';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { emptySupports } from './model';
import { buildJob, REPAIR_BUDGET } from './live/jobInputs';
import { tipCount, toLocal } from './supportJob';
import golden from '../../tests/fixtures/support-golden-cube-overhang.json';
import { cubeOverhang, seamCube } from '../../tests/fixtures/support-cubes.mjs';

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
  return { placement, job, model, built: runSupportJob(job, undefined, 1) };
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
  /*
   * CHARACTERISATION, not a contract: these numbers are mixoMesh's OWN output, so they are to be
   * RE-TAKEN on the next re-vendor rather than defended. The one number that is a contract is
   * `golden.placementPoints`, which comes from geocore's own snapshot.
   *
   * Why it exists (Fable, 2026-11-12): browser-support-support-worker-shapes-smoke.mjs asserted
   * `tips === golden.tips` and had been red since the live job started sending
   * `repairBudget: REPAIR_BUDGET`. 68 is correct - placement returns 70 and the safety repair drops
   * the two contacts at the overhang edge where MIDDLE's thicker supports cross the model, which is
   * why the verdict moves from `blocked` to `clear`. The smoke now asserts conservation, which
   * survives a re-vendor but does not bound how many contacts get dropped. This does, in CI, which
   * is where the browser smokes are not.
   */
  it('MIDDLE at the live repair budget: 70 placed, 2 dropped at the overhang edge, verdict clear', () => {
    const { placement, built } = build(cubeOverhang(), set(base(), presetValues.MIDDLE as Partial<Record<SettingKey, unknown>>));
    expect(placement.points.length).toBe(golden.placementPoints);
    expect(built.dropped.length + tipCount(built)).toBe(placement.points.length);
    expect(built.dropped.length).toBe(2);
    expect([...built.dropped].sort()).toEqual(['auto-215_100_-485', 'auto-215_100_485']);
    expect(built.verdict?.status).toBe('clear');
  });
  it('without the budget the same preset keeps all 70 and cannot reach a clear verdict', () => {
    const { placement, built } = build(cubeOverhang(), set(base(), presetValues.MIDDLE as Partial<Record<SettingKey, unknown>>), 'Test part', () => true, 0);
    expect(tipCount(built)).toBe(placement.points.length);
    expect(built.dropped.length).toBe(0);
    expect(built.verdict?.status).toBe('blocked');
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

const perPartOf = (b: ReturnType<typeof build>['built']) => b.components.reduce<Record<string, number>>((a, c) => ((a[c.part] = (a[c.part] ?? 0) + 1), a), {});

describe('P5.5 roof (golden cube-overhang roof variant)', () => {
  const roofBase = () => set(setRoofMode(base(), 'ROOF'), { labelText: 'A' }); // the golden's label text
  it('roof on, the golden policy: placement, triangle count and part counts as the golden', () => {
    const { placement, built } = build(cubeOverhang(), roofBase(), 'Cube', undefined, 0);
    expect(placement.points.length).toBe(golden.placementPoints);
    // mixo-geocore goldens/__snapshots__/cube-overhang.roof.json: 24852 triangles; per part neck 70, pillar 140,
    // foot 70, brace 28, raft 65, label 2, column 12, cross-bar 72, roof 1, roof-brace 15.
    expect(Math.abs(built.indices.length / 3 - 24852)).toBeLessThan(24852 * 0.01); // the 1 um snap of toLocal moves a few facets
    expect(perPartOf(built)).toEqual({ neck: 70, pillar: 140, foot: 70, brace: 28, raft: 65, label: 2, column: 12, 'cross-bar': 72, roof: 1, 'roof-brace': 15 });
    expect([...built.parts].sort()).toEqual(['brace', 'column', 'cross-bar', 'foot', 'label', 'neck', 'pillar', 'raft', 'roof', 'roof-brace']);
    expect(built.verdict?.status).toBe('clear');
  });
  it('roof off: none of its parts; the roof is part of the one support mesh (what the export writes)', () => {
    const off = build(cubeOverhang(), base()).built;
    for (const part of ['column', 'cross-bar', 'roof', 'roof-brace', 'cage-ring']) expect(off.parts).not.toContain(part);
    const { built: on, model } = build(cubeOverhang(), roofBase());
    expect(on.indices.length).toBeGreaterThan(off.indices.length);
    // The roof slab lies above the model top (lift + 10 mm + roof gap), the columns reach it.
    const topOf = (part: string) => {
      let top = -Infinity;
      for (const c of on.components) if (c.part === part) for (let i = c.start; i < c.start + c.count; i++) top = Math.max(top, on.positions[on.indices[i]! * 3 + 1]! + model.center[1]);
      return top;
    };
    const expected = 5 + 10 + roofBase().roofGap - 0.01; // lift + model height + roof gap (the slab adds its thickness)
    expect(topOf('roof')).toBeGreaterThan(expected);
    expect(topOf('column')).toBeGreaterThanOrEqual(expected);
  });
  it('every roof setting reaches the engine (the mesh changes)', () => {
    const run = (patch: Partial<Record<SettingKey, unknown>>, from = roofBase()) => sig(build(cubeOverhang(), set(from, patch)).built);
    const a = run({});
    for (const patch of [{ roofGap: 9 }, { columnCount: 8 }, { columnDiameter: 3 }, { diagonalEnabled: false }, { diagonalDiameter: 2 }, { braceConcentric: 1 }, { braceThickness: 2 },
      { storeyFloorThickness: 3 }, { storeyEncloseCeiling: false }]) {
      expect(run(patch), JSON.stringify(patch)).not.toBe(a);
    }
    // The brace slope is limited by the roof gap (the engine keeps the braces inside the gap), so it shows with a tall gap.
    const tall = set(roofBase(), { roofGap: 40 });
    expect(run({ braceAngle: 15 }, tall)).not.toBe(run({ braceAngle: 40 }, tall));
  });
});

describe('P5.6 cage (no golden: deterministic counts and bounds on a 20 mm cube)', () => {
  const cube = () => seamCube({ split: false });
  const cageBase = () => setRoofMode(base(), 'CAGE');
  /** Highest vertex y of every cage ring, sorted; and how far the ring vertices stand outside the cube's footprint. */
  function rings(b: ReturnType<typeof build>['built'], centreY: number) {
    const levels: number[] = [];
    let nearest = Infinity;
    for (const c of b.components) {
      if (c.part !== 'cage-ring') continue;
      let top = -Infinity;
      for (let i = c.start; i < c.start + c.count; i++) {
        const v = b.indices[i]! * 3;
        top = Math.max(top, b.positions[v + 1]! + centreY);
        nearest = Math.min(nearest, Math.hypot(Math.max(Math.abs(b.positions[v]!) - 10, 0), Math.max(Math.abs(b.positions[v + 2]!) - 10, 0)));
      }
      levels.push(top);
    }
    return { levels: levels.sort((x, y) => x - y), nearest };
  }
  it('rings = ceil((model top + top gap) / pitch), one per pitch, columns around the raft, clear of the model', () => {
    const s = cageBase();
    expect(s).toMatchObject({ cagePitch: 10, cageTopGap: 5, cageSideGap: 4, columnCount: 12 });
    const { built, model } = build(cube(), s, 'Cube');
    const top = s.liftHeight + 20;
    const per = perPartOf(built);
    expect(per['cage-ring']).toBe(Math.ceil((top + s.cageTopGap) / s.cagePitch));
    expect(per.column).toBe(12);
    expect(built.parts).not.toContain('roof');
    expect(built.parts).not.toContain('roof-brace');
    const { levels, nearest } = rings(built, model.center[1]);
    // Ring k sits at k * pitch (plus its radius at the top of the tube); the top ring is at least the top gap above the model.
    levels.forEach((y, k) => expect(y).toBeCloseTo((k + 1) * s.cagePitch + s.cageRingDiameter / 2, 1));
    expect(levels.at(-1)! - s.cageRingDiameter / 2).toBeGreaterThanOrEqual(top + s.cageTopGap - 0.01);
    // The cage stands at least the side gap outside the model outline.
    expect(nearest).toBeGreaterThanOrEqual(s.cageSideGap);
    // The engine's own body-clearance verdict: nothing of the support mesh crosses the model.
    expect(built.verdict?.status).toBe('clear');
  });
  it('pitch, top gap and side gap change the ring count and distances; still clear', () => {
    const s = cageBase();
    const ringsFor = (patch: Partial<Record<SettingKey, unknown>>) => { const { built: b, model } = build(cube(), set(s, patch), 'Cube'); return { n: perPartOf(b)['cage-ring'], r: rings(b, model.center[1]), v: b.verdict?.status }; };
    expect(ringsFor({ cagePitch: 7 }).n).toBe(Math.ceil(30 / 7));
    expect(ringsFor({ cageTopGap: 20 }).n).toBe(Math.ceil(45 / 10));
    const wide = ringsFor({ cageSideGap: 9 });
    expect(wide.r.nearest).toBeGreaterThanOrEqual(9);
    expect(wide.v).toBe('clear');
    const b8 = build(cube(), set(s, { columnCount: 8, diagonalEnabled: false }), 'Cube').built;
    expect(perPartOf(b8).column).toBe(8);
    expect(b8.parts).not.toContain('cross-bar');
  });
  it('Roof and Cage are one mode: picking one drops the other, and each keeps its own values', () => {
    const roof = updateSetting(setRoofMode(base(), 'ROOF'), 'roofGap', 12);
    const cage = setRoofMode(roof, 'CAGE');
    expect(cage.roofMode).toBe('CAGE');
    expect(cage).toMatchObject({ columnDiameter: 1.2, roofGap: 12 }); // the cage seeds its column diameter, the roof gap stays
    const parts = build(cube(), cage, 'Cube').built.parts;
    expect(parts).toContain('cage-ring');
    expect(parts).not.toContain('roof');
    const back = setRoofMode(updateSetting(cage, 'columnDiameter', 2), 'ROOF');
    expect(back).toMatchObject({ roofMode: 'ROOF', roofGap: 12, columnDiameter: 2 }); // not re-seeded
    expect(build(cube(), setRoofMode(back, 'OFF'), 'Cube').built.parts).not.toContain('column');
  });
});
