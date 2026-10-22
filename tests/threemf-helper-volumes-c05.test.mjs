// cia C-05: slicer helper volumes (negative volumes, modifiers, support
// blockers) must not import as printable geometry. Run:
//   node --import ./tests/register-hooks.mjs --test tests/threemf-helper-volumes-c05.test.mjs
//
// Fixtures come from tests/fixtures/make-slicer-helper-volumes.mjs; each holds
// a 20 mm box model part plus a negative volume, a modifier and a support
// blocker (12 triangles each). Expected results:
//   PrusaSlicer file: PrusaSlicer 2.9.3's own reading (`prusa-slicer-console
//     --info`): number_of_facets = 12, volume = 8000, size 20 mm.
//   Bambu file: Bambu Studio source, commit 79df7ae (Model.cpp
//     ModelVolume::type_from_string, Format/bbs_3mf.cpp
//     _handle_start_config_volume): only subtype "normal_part" is a model part.
//     PrusaSlicer imports Bambu projects as geometry only, so it is no oracle
//     for part subtypes.

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
const { importThreeMFBuffer } = await import('../src/core/import/meshImportCore.js');
const { Toast } = await import('../src/ui/Toast.js');
const JSZip = createRequire(import.meta.url)('jszip');

const scene = new BABYLON.Scene(new BABYLON.NullEngine());
const toasts = [];
Toast.show = (message, type) => { toasts.push({ message, type }); return 'toast'; };

function summary(container) {
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of container.meshes) {
    triangles += mesh.getIndices().length / 3;
    const pos = mesh.getVerticesData('position');
    for (let i = 0; i < pos.length; i++) {
      min[i % 3] = Math.min(min[i % 3], pos[i]);
      max[i % 3] = Math.max(max[i % 3], pos[i]);
    }
  }
  return { triangles, size: max.map((v, i) => Math.round((v - min[i]) * 1000) / 1000) };
}

async function mainThread(bytes) {
  const zip = await Loader.__test.openZip(JSZip, bytes);
  const xml = await zip.file('3D/3dmodel.model').async('text');
  return Loader.__test.buildContainer(scene, zip, xml, { modelPath: '3D/3dmodel.model' });
}

async function workerPath(bytes) {
  const w = await importThreeMFBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { JSZip });
  return Loader.buildThreeMFContainerFromParsed(scene, w.result);
}

for (const [name, fixture] of [
  ['PrusaSlicer volume_type', 'prusa-helper-volumes.3mf'],
  ['Bambu Studio part subtype', 'bambu-helper-volumes.3mf'],
]) {
  const bytes = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url));
  for (const [path, load] of [['main thread', mainThread], ['worker', workerPath]]) {
    test(`${name} (${path}): only the printable model part imports`, async () => {
      toasts.length = 0;
      const got = summary(await load(bytes));
      assert.deepEqual(got, { triangles: 12, size: [20, 20, 20] });
      assert.deepEqual(toasts.map(x => x.type), ['warning'], 'one warning about the skipped helper volumes');
    });
  }
}

test('a core object of type "other" is never built (3MF Core ch.4)', async () => {
  toasts.length = 0;
  const box = (id, type, s) => `<object id="${id}" type="${type}"><mesh><vertices>`
    + `<vertex x="0" y="0" z="0"/><vertex x="${s}" y="0" z="0"/><vertex x="0" y="${s}" z="0"/><vertex x="0" y="0" z="${s}"/>`
    + '</vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>'
    + '<triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>';
  const xml = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources>${box(1, 'model', 10)}${box(2, 'other', 40)}</resources>`
    + '<build><item objectid="1"/><item objectid="2"/></build></model>';
  const got = summary(await Loader.__test.buildContainer(scene, null, xml));
  assert.deepEqual(got, { triangles: 4, size: [10, 10, 10] });
  assert.deepEqual(toasts.map(x => x.type), ['warning']);
});

test('a plain 3MF with no helper volumes imports whole and raises no notice', async () => {
  toasts.length = 0;
  const xml = readFileSync(new URL('./fixtures/prusa-tetra.3mf', import.meta.url));
  const got = summary(await mainThread(xml));
  assert.equal(got.triangles, 4);
  assert.equal(toasts.length, 0);
});
