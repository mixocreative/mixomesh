import './testEnv';
/*
 * STEP ZERO of the engine re-vendor (`docs/plans/2026-11-12-parts-and-focus-mode.md`, U6): what this
 * app's support pipeline produces on the smoke fixtures at the engine it vendors TODAY.
 *
 * The plan says to capture and commit this before touching `vendor/`, and the reason is specific.
 * mixoMesh is pinned at engine 12 while geocore is at 65 -- 53 ABI versions -- and the changes in
 * between move WHAT GETS PRINTED. Without a before, the after cannot be read: every difference looks
 * equally like a fix and like a regression.
 *
 * And a before is what stops a WRONG attribution surviving. The density change this captured
 * (cube-overhang 70 -> 51 contacts) looks exactly like the `scatterAngle` 50 -> 45 default, and is
 * not: at engine 65 the count is 51 at 45, 50 and 60 degrees alike. It is ENGINES 47/48 - island and
 * lowest-point tips claim first with a half-pitch gap, every edge corner gets a tip, and edges space
 * in round(length / pitch) - an owner decision of 2026-11-01 that is not optional at 65.
 *
 * In process, not in a browser: this is the same `placeGeneric` + `runSupportJob` path the live code
 * runs, with no Vite, no worker and no renderer, so a difference is the engine's and nothing else's.
 *
 * NOT A CONTRACT. These are mixoMesh's own numbers, so when the re-vendor lands they are RE-TAKEN
 * and the diff is read, line by line, by someone deciding whether each change is wanted. A baseline
 * updated without reading the diff is worse than no baseline.
 *
 *   npm run baseline:check                                        compare (also runs in `npm test`)
 *   UPDATE_BASELINE=1 npx vitest run src/supports/engineBaseline.test.ts   re-take
 *
 * ── RE-TAKEN 2026-11-13 at engine 68, and the diff was mostly NOT the engine ───────────────────
 *
 * Two changes landed together and the diff has to be read as two:
 *
 * 1. **The engine (65 -> 68)**: `buried` is new on every row, and `sunk-pair` is new. On the three
 *    old fixtures the engine changed NOTHING -- measured in between, at 67 without the weld below,
 *    where every old row was identical to the committed 65 capture. That is the useful fact about
 *    engines 66-68: the overlap rule costs a single-part model nothing.
 * 2. **This file started welding as the live path does**, and THAT moved most of the numbers:
 *      seam-cube-split: dropped 10 -> 0, tips 82 -> 92, one verdict `blocked` -> `clear`
 *      cube-overhang:   dropped 10/8/12 -> 0, tips 82/84/80 -> 92
 *      slope-47:        placed 66 -> 65, dropped 40 -> 19, tips 26 -> 46, braces 10 -> 169
 *    Every one of those moved the SAME WAY: fewer supports thrown away, more built, a `blocked`
 *    verdict becoming `clear`. The old rows were pessimistic fiction -- supports dropped for
 *    crossing a model whose faces were a few nanometres out of plane, on a mesh the app never hands
 *    the engine. `weldByPosition`'s own comment says this happens (it measured 48 vs 62 contacts in
 *    the browser against the goldens); what is new is seeing it cost ten built supports and a
 *    verdict.
 *
 * **So the build is sensitive to sub-micron geometry, and that is worth knowing on its own.** It is
 * not a defect to chase here: the fix is the one already in the live path, to hand the engine a
 * snapped mesh, which is now also what this file hands it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { runPlacementJob, runSupportJob } from '@mixo-geocore/host/supports/jobRunner';
import {
  defaultSupportSettings, presetValues, toPlacementSettings, updateSetting,
  type LiveSupportSettings, type SettingKey,
} from '@mixo-geocore/host/core/supports/settings';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { emptySupports } from './model';
import { buildJob, REPAIR_BUDGET } from './live/jobInputs';
import { tipCount, toLocal } from './supportJob';
import { weldByPosition } from './frame';
import { cubeOverhang, seamCube, sunkPair } from '../../tests/fixtures/support-cubes.mjs';

const VENDOR = fileURLToPath(new URL('../../public/vendor/mixo-geocore/', import.meta.url));
const BASELINE = new URL('../../tests/fixtures/engine-baseline.json', import.meta.url);

beforeAll(async () => {
  configureGeometry(pathToFileURL(VENDOR + 'mixo_geometry_wasm.js').href, readFileSync(VENDOR + 'mixo_geometry_wasm_bg.wasm'));
  await geometryReady();
});

const base = (): LiveSupportSettings => ({ ...defaultSupportSettings, roofSeededModes: [] });
const set = (s: LiveSupportSettings, patch: Partial<Record<SettingKey, unknown>>): LiveSupportSettings =>
  Object.entries(patch).reduce((acc, [k, v]) => updateSetting(acc, k as SettingKey, v as never), s);

/** Lift the mesh so its lowest point sits `lift` above the bed, as an object on the plate is. */
function lifted(mesh: TriangleMesh, lift: number): TriangleMesh {
  let minY = Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) minY = Math.min(minY, mesh.positions[i]!);
  return { positions: Float32Array.from(mesh.positions, (v, i) => (i % 3 === 1 ? v - minY + lift : v)), indices: mesh.indices };
}

/**
 * A flat 40 x 40 mm plate tilted `deg` from horizontal, floating 10 mm above the bed.
 *
 * Here because NEITHER other fixture can see the overhang angle: both are axis-aligned and have no
 * face between 45 and 50 degrees, so `scatterAngle` moves nothing on them. Measured 2026-11-12 at
 * engine 65, contacts per angle:
 *
 *   slope 44 deg -> 45:172  50:196
 *   slope 46 deg -> 45:64   50:194
 *   slope 47 deg -> 45:66   50:187
 *
 * So a face sloped 46-47 degrees loses its FIELD tips entirely at the engine's 45 default, keeping
 * only the ~63 rim and island points every slope gets. That is the whole cost of taking 45 rather
 * than pinning 50, and it is the industry 45-degree self-support convention: 50 was more
 * conservative than convention, not more correct. An operator who sees sag on such a face raises
 * one control per object. Captured so that a re-vendor which moves this BAND is noticed, because
 * nothing else here would notice it.
 */
function tiltedPlate(deg: number): TriangleMesh {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  const half = 20;
  const thick = 2;
  const raw: [number, number, number][] = [];
  for (const z of [-half, half]) for (const y of [0, thick]) for (const x of [-half, half]) raw.push([x, y, z]);
  const pts = raw.map(([x, y, z]) => [x * c - y * sn, x * sn + y * c + 10, z] as [number, number, number]);
  const quads: [number, number, number, number][] = [
    [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
  ];
  return {
    positions: new Float32Array(pts.flat()),
    indices: new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d])),
  };
}

/** One row: what the pipeline did, in numbers a diff can be read from. */
function row(mesh: TriangleMesh, settings: LiveSupportSettings, budget: number) {
  // `weldByPosition` FIRST, because the live path does it (`frame.ts`, in `partsToEngine`) and a
  // baseline that skips a step of the live path measures a path nobody runs. It mattered: without
  // it, `seam-cube-split` -- a cube whose bottom cells have their own vertices, as a textured import
  // does -- reached the engine as 32 unconnected faces, and engine 67's overlap rule read all
  // sixteen bottom contacts as buried inside a neighbouring "part". That found a real engine defect
  // (fixed in 68: the ABI welds too), and it was still the wrong path to be measuring.
  const model = toLocal(weldByPosition(lifted(mesh, settings.liftHeight)).mesh);
  // `runPlacementJob`, not `placeGeneric`: the live path goes through the job (that is where the
  // overlap rule drops buried contacts, engine 67), and a baseline that skipped it would measure a
  // path the app does not run. Orientation is identity here -- the object's pose is in `model`.
  const placement = runPlacementJob({ mesh: model.local, orientation: { position: [0, 0, 0], rotation: [0, 0, 0] }, settings: toPlacementSettings(settings) });
  const record = { ...emptySupports(settings), settings };
  const inputs = { points: placement.points, manual: [], deleted: [], zones: [], contactSettings: {} };
  const built = runSupportJob({ ...buildJob(model, record, inputs, 'baseline'), repairBudget: budget }, undefined, 1);
  const perPart = built.components.reduce<Record<string, number>>((a, c) => ((a[c.part] = (a[c.part] ?? 0) + 1), a), {});
  return {
    placed: placement.points.length,
    // The COUNT, not the positions the engine now reports: a baseline of coordinates would churn on
    // any float change and say nothing a reader could use, while the count is exactly the fact
    // ("the overlap rule dropped nine here") a diff needs to be readable.
    buried: placement.buried?.length ?? 0,
    regions: placement.regions.length,
    tips: tipCount(built),
    dropped: built.dropped.length,
    droppedIds: [...built.dropped].sort(),
    verdict: built.verdict?.status ?? 'none',
    triangles: built.indices.length / 3,
    parts: Object.keys(perPart).sort(),
    perPart: Object.fromEntries(Object.entries(perPart).sort()),
    fallbacks: [...(built.fallbacks ?? [])].sort(),
  };
}

/** Every case worth a before: the two fixtures, the three presets, and the repair budget on and off. */
function capture() {
  const fixtures: Record<string, () => TriangleMesh> = {
    'cube-overhang': () => cubeOverhang() as TriangleMesh,
    'seam-cube-split': () => seamCube({ split: true }) as TriangleMesh,
    // 47 degrees: inside the 45-50 band, so this row and only this row moves with the overhang angle.
    'slope-47': () => tiltedPlate(47),
    /*
     * Two overlapping meshes in one file, and the row that records a DECIDED behaviour rather than a
     * regression. Read this before "fixing" it.
     *
     * The generic placement path does NOT apply the overlap rule -- permanently, settled 2026-11-13
     * (`host/supports/README.md` in geocore has the invariant). So this row reads
     * `placed 41, buried 0, dropped 9, tips 33, verdict blocked`: a support is built onto the buried
     * face and the build SAYS SO, in the panel, as "Some supports cross the model".
     *
     * Its earlier values -- `placed 32, buried 9, tips 32, verdict clear` -- are what the rule gave
     * for the part of one day it ran here, and the previous note said a `placed` that climbed back
     * up meant "the rule having stopped working". That is now exactly backwards: the climb IS the
     * decision. The rule is defined over PARTS, a file only gives SHELLS, and shells are not parts
     * -- mixodental's walk fixture has 588 of them, which cost it 92% of its automatic supports.
     *
     * A genuine two-part overlap in one file is a model problem, fixed by unioning or separating the
     * parts. The loud verdict is the right answer; silently dropping the contacts was not.
     */
    'sunk-pair': () => sunkPair() as TriangleMesh,
  };
  const out: Record<string, unknown> = {
    note: 'mixoMesh own output, engine as vendored. RE-TAKE on re-vendor and READ the diff.',
    engineVersion: JSON.parse(readFileSync(VENDOR + 'SOURCE.json', 'utf8')).engineVersion,
  };
  for (const [fixture, make] of Object.entries(fixtures)) {
    for (const preset of ['LIGHT', 'MIDDLE', 'HEAVY'] as const) {
      for (const [label, budget] of [['budget', REPAIR_BUDGET], ['nobudget', 0]] as const) {
        const settings = set(base(), presetValues[preset] as Partial<Record<SettingKey, unknown>>);
        out[`${fixture}/${preset}/${label}`] = row(make(), settings, budget);
      }
    }
  }
  return out;
}

describe('the engine-12 baseline this app is re-vendored FROM', () => {
  it('matches the committed capture, or UPDATE_BASELINE=1 re-takes it', { timeout: 60_000 }, () => {
    const now = capture();
    if (process.env.UPDATE_BASELINE === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`);
      expect(now).toEqual(now);
      return;
    }
    const committed = JSON.parse(readFileSync(BASELINE, 'utf8'));
    // One assertion over the whole table: a diff of twelve rows at once is what a reviewer needs to
    // read, rather than twelve failures to read one at a time.
    expect(now).toEqual(committed);
  });
});
