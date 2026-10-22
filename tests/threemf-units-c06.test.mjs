// cia C-06: a 3MF's `unit` scales build-item and component translations, not
// only vertices. Run:
//   node --import ./tests/register-hooks.mjs --test tests/threemf-units-c06.test.mjs
//
// Fixtures: tests/fixtures/make-3mf-units.mjs (a 1-unit cube at the origin,
// and the same cube via a components object: item translate x=10, component
// translate y=2, all in file units). Authority: 3MF Core 1.4.0 §3.4, `unit`
// "Specifies the unit used to interpret all vertices, locations, or
// measurements in the model", and ch.3 "Producers and consumers MUST use the
// unit resolution of the coordinate space as specified in the <model>
// element". trimesh 4.8.1 agrees (centimeter file: second cube's translation
// [10, 2, 0] cm, bounds 11 x 3 x 1 cm). PrusaSlicer 2.9.3
// (`--dont-arrange --merge --export-stl`) scales the cubes but not the
// translations, so it disagrees with the spec for non-mm files.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
console.error = () => {};
const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;

const Loader = await import('../src/core/ThreeMFLoader.js');
const { toPrintSpace } = await import('../src/core/print/PrintSpace.js');
const JSZip = createRequire(import.meta.url)('jszip');
const scene = new BABYLON.Scene(new BABYLON.NullEngine());

/** Per-mesh bounding box in 3MF print space (mm), sorted by min x. */
async function partBoxes(unit) {
  const zip = await Loader.__test.openZip(JSZip, readFileSync(new URL(`./fixtures/units-${unit}.3mf`, import.meta.url)));
  const xml = await zip.file('3D/3dmodel.model').async('text');
  const container = await Loader.__test.buildContainer(scene, zip, xml);
  return container.meshes.map(mesh => {
    const pos = mesh.getVerticesData('position');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      const p = toPrintSpace(pos[i], pos[i + 1], pos[i + 2]);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
    }
    const r = v => Math.round(v * 1000) / 1000;
    return { min: min.map(r), max: max.map(r) };
  }).sort((a, b) => a.min[0] - b.min[0]);
}

for (const [unit, mm] of [['millimeter', 1], ['centimeter', 10], ['inch', 25.4]]) {
  test(`${unit}: both cubes and their placement scale to mm together`, async () => {
    const r = v => Math.round(v * 1000) / 1000;
    assert.deepEqual(await partBoxes(unit), [
      { min: [0, 0, 0], max: [mm, mm, mm].map(r) },
      { min: [10 * mm, 2 * mm, 0].map(r), max: [11 * mm, 3 * mm, mm].map(r) },
    ]);
  });
}
