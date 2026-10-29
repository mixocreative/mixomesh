// Engine integration of the support frame (plan P2.1): the mixomesh path (Babylon world -> frame.ts
// -> object-local job -> placement + `generate` -> frame.ts back) against the mixo-geocore golden,
// and the weld rule on a textured cube whose UV seams cross its bottom face.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { runSupportJob } from '@mixo-geocore/host/supports/jobRunner';
import { defaultSupportSettings, toPlacementSettings, type LiveSupportSettings } from '@mixo-geocore/host/core/supports/settings';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { signedVolume } from '../core/print/PrintSpace.js';
import { meshFromEngine, partsToEngine, type BabylonPart } from './frame';
import { presetSettings, supportJob, supportsToWorld, tipCount, toLocal } from './supportJob';
import golden from '../../tests/fixtures/support-golden-cube-overhang.json';
import { cubeOverhang, seamCube } from '../../tests/fixtures/support-cubes.mjs';

const VENDOR = fileURLToPath(new URL('../../public/vendor/mixo-geocore/', import.meta.url));

beforeAll(async () => {
  configureGeometry(pathToFileURL(VENDOR + 'mixo_geometry_wasm.js').href, readFileSync(VENDOR + 'mixo_geometry_wasm_bg.wasm'));
  await geometryReady();
});

/** An engine-frame mesh as the Babylon world part a ClockWise-flagged (glTF) import would hold. */
function asBabylonPart(engine: TriangleMesh, at: [number, number, number] = [0, 0, 0]): BabylonPart {
  const moved = new Float32Array(engine.positions.length);
  for (let i = 0; i < moved.length; i++) moved[i] = engine.positions[i]! + at[i % 3]!;
  const { positions, indices } = meshFromEngine({ positions: moved, indices: engine.indices }, true);
  return { positions, indices, clockwise: true };
}

function generateFor(parts: BabylonPart[], settings: LiveSupportSettings) {
  const model = toLocal(partsToEngine(parts).mesh);
  const placement = placeGeneric(model.local, toPlacementSettings(settings));
  const job = supportJob(model, settings, placement);
  const built = runSupportJob(job, undefined, 1);
  return { model, placement, job, built, world: supportsToWorld(built, model.center) };
}

const sources = (points: { source: string }[]) => points.reduce<Record<string, number>>((acc, p) => ((acc[p.source] = (acc[p.source] ?? 0) + 1), acc), {});

describe('support spike: mixomesh path vs mixo-geocore golden', () => {
  it('cube-overhang (golden default settings): same placement and tip count as the golden', () => {
    const settings = { ...defaultSupportSettings, roofSeededModes: [] } as LiveSupportSettings;
    // Anywhere on the bed: the object-local frame makes the contacts independent of position.
    const { placement, built } = generateFor([asBabylonPart(cubeOverhang(), [37.25, 0, -12.5])], settings);
    expect(placement.points.map((p) => p.id)).toEqual(golden.placementIds);
    expect(placement.points.length).toBe(golden.placementPoints);
    expect(tipCount(built)).toBe(golden.tips);
  });

  it('cube-overhang with the sub-micron noise of a Babylon import still matches the golden', () => {
    const settings = { ...defaultSupportSettings, roofSeededModes: [] } as LiveSupportSettings;
    const noisy = cubeOverhang();
    // What the browser import measured: 5 mm corners arrive as 5.0000005, 1 mm as 0.9999995.
    for (let i = 0; i < noisy.positions.length; i++) noisy.positions[i] = noisy.positions[i]! + (i % 2 ? 5e-7 : -5e-7) * Math.sign(noisy.positions[i]! || 1);
    const { placement, built } = generateFor([asBabylonPart(noisy)], settings);
    expect(placement.points.map((p) => p.id)).toEqual(golden.placementIds);
    expect(tipCount(built)).toBe(golden.tips);
  });

  it('MIDDLE preset builds supports whose lowest point is the plate and whose tips reach the model', () => {
    const { job, world, built } = generateFor([asBabylonPart(cubeOverhang())], presetSettings('MIDDLE'));
    expect(tipCount(built)).toBeGreaterThan(0);
    let minY = Infinity;
    for (let i = 1; i < world.positions.length; i += 3) minY = Math.min(minY, world.positions[i]!);
    expect(minY).toBeCloseTo(job.plate!, 3);
    // Engine output is counter-clockwise-outward (right-handed): positive signed volume.
    expect(signedVolume(world.positions, world.indices)).toBeGreaterThan(0);
  });
});

describe('support spike: weld rule', () => {
  it('a textured cube with UV seams across its bottom gets the same contacts as the plain cube', () => {
    const settings = presetSettings('MIDDLE');
    const plain = generateFor([asBabylonPart(seamCube({ split: false }))], settings);
    const seams = generateFor([asBabylonPart(seamCube({ split: true }))], settings);
    expect(seams.model.local.positions.length).toBe(plain.model.local.positions.length);
    expect(sources(seams.placement.points)).toEqual(sources(plain.placement.points));
    expect(seams.placement.points.map((p) => p.id)).toEqual(plain.placement.points.map((p) => p.id));
    expect(tipCount(seams.built)).toBe(tipCount(plain.built));
  });
});
