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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { runSupportJob } from '@mixo-geocore/host/supports/jobRunner';
import {
  defaultSupportSettings, presetValues, toPlacementSettings, updateSetting,
  type LiveSupportSettings, type SettingKey,
} from '@mixo-geocore/host/core/supports/settings';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { emptySupports } from './model';
import { buildJob, REPAIR_BUDGET } from './live/jobInputs';
import { tipCount, toLocal } from './supportJob';
import { cubeOverhang, seamCube } from '../../tests/fixtures/support-cubes.mjs';

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

/** One row: what the pipeline did, in numbers a diff can be read from. */
function row(mesh: TriangleMesh, settings: LiveSupportSettings, budget: number) {
  const model = toLocal(lifted(mesh, settings.liftHeight));
  const placement = placeGeneric(model.local, toPlacementSettings(settings));
  const record = { ...emptySupports(settings), settings };
  const inputs = { points: placement.points, manual: [], deleted: [], zones: [], contactSettings: {} };
  const built = runSupportJob({ ...buildJob(model, record, inputs, 'baseline'), repairBudget: budget }, undefined, 1);
  const perPart = built.components.reduce<Record<string, number>>((a, c) => ((a[c.part] = (a[c.part] ?? 0) + 1), a), {});
  return {
    placed: placement.points.length,
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
  it('matches the committed capture, or UPDATE_BASELINE=1 re-takes it', () => {
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
