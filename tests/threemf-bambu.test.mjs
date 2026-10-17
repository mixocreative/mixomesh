// Bambu/Orca-flavoured 3MF (task 1.11). Run:
//   node --import ./tests/register-hooks.mjs tests/threemf-bambu.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const BABYLON = { ...await import('@babylonjs/core') };
BABYLON.Texture = class { constructor(url) { this.url = url; } };
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
console.error = () => {};

const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;

const { setState } = await import('../src/core/StateManager.js');
const Writer = await import('../src/core/print/ThreeMFWriter.js');
const Bambu = await import('../src/core/print/ThreeMFBambu.js');
const Loader = await import('../src/core/ThreeMFLoader.js');

let engine = null;
let scene = null;
function resetScene() {
  scene?.dispose();
  engine?.dispose();
  engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
  scene = new BABYLON.Scene(engine);
  setState(s => ({ ...s, scene: { ...s.scene, objects: {}, groups: {}, collections: {}, assetLibrary: {}, shaders: {}, validation: {} } }), { silent: true });
}

function colouredMesh(name, rgb, { textured = false } = {}) {
  const mesh = new BABYLON.Mesh(name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  vd.indices = [0, 1, 2];
  if (textured) vd.uvs = [0, 0, 1, 0, 0, 1];
  vd.applyToMesh(mesh);
  const mat = new BABYLON.StandardMaterial(`${name}__mat`, scene);
  mat.diffuseColor = new BABYLON.Color3(...rgb);
  if (textured) {
    mat.diffuseTexture = {
      name: 'paint',
      getBaseSize() { return { width: 1, height: 1 }; },
      readPixels() { return new Uint8Array([255, 255, 255, 255]); },
    };
  }
  mesh.material = mat;
  return mesh;
}

function multiUnit(id, meshes) {
  return {
    logicalId: id, name: id,
    meshes: meshes.map(mesh => ({ meshId: mesh.name, logicalId: id, logicalName: id, name: mesh.name, mesh })),
  };
}

const RGB = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], white: [1, 1, 1], black: [0, 0, 0],
};
const BAMBU = { flavour: 'bambu', metadata: { title: 'Mug & Co', application: 'MIXOMESH', creationDate: '2026-10-14' } };
const byPath = entries => Object.fromEntries(entries.map(e => [e.path, e.data]));

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetScene();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

function twoColourMug() {
  return multiUnit('Mug', [colouredMesh('Mug_red', RGB.red), colouredMesh('Mug_blue', RGB.blue)]);
}

await test('model XML: production namespace + requiredextensions="p"', () => {
  const model = byPath(Writer.buildColorGroupEntries([twoColourMug()], BAMBU))['3D/3dmodel.model'];
  assert.match(model, /<model unit="millimeter" requiredextensions="p" [^>]*xmlns:p="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/production\/2015\/06"/);
  assert.match(model, /xmlns:m="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/material\/2015\/02"/);
  assert.ok(model.includes('<metadata name="Application">MIXOMESH</metadata>'));
});

await test('p:UUID on every object, component, item and the build — well-formed, unique, deterministic', () => {
  const units = () => [twoColourMug(), multiUnit('Lid', [colouredMesh('Lid_white', RGB.white)])];
  const model = byPath(Writer.buildColorGroupEntries(units(), BAMBU))['3D/3dmodel.model'];
  const count = re => (model.match(re) ?? []).length;
  assert.equal(count(/<object /g), count(/<object id="\d+" p:UUID="/g), 'every <object> has p:UUID');
  assert.equal(count(/<component /g), count(/<component objectid="\d+" p:UUID="/g), 'every <component> has p:UUID');
  assert.equal(count(/<item /g), count(/<item objectid="\d+" p:UUID="/g), 'every <item> has p:UUID');
  assert.match(model, /<build p:UUID="[0-9a-f-]{36}">/);
  const uuids = [...model.matchAll(/p:UUID="([^"]+)"/g)].map(m => m[1]);
  // 2 objects × (parts + parent): Mug 3 objects, Lid 2 → 5 objects, 3 components, 2 items, 1 build.
  assert.equal(uuids.length, 5 + 3 + 2 + 1);
  for (const u of uuids) assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(uuids).size, uuids.length, 'UUIDs unique');
  resetScene();
  const again = byPath(Writer.buildColorGroupEntries(units(), BAMBU))['3D/3dmodel.model'];
  assert.deepEqual([...again.matchAll(/p:UUID="([^"]+)"/g)].map(m => m[1]), uuids, 'deterministic');
});

await test('every logical object is parent + parts (even single-material); group hierarchy flattened', () => {
  const state = {
    scene: {
      objects: { Lid: { id: 'Lid', name: 'Lid', parentId: 'grp', visible: true, isPrintPart: true } },
      groups: { grp: { id: 'grp', name: 'Robot', parentId: null, childIds: ['Lid'], origin: 'user' } },
      assetLibrary: {},
    },
  };
  const model = byPath(Writer.buildColorGroupEntries(
    [multiUnit('Lid', [colouredMesh('Lid_white', RGB.white)])], { ...BAMBU, state, splitByMaterial: false }))['3D/3dmodel.model'];
  assert.match(model, /<object id="2" p:UUID="[^"]+" type="model" name="Lid_white" pid="1" pindex="0"><mesh>/);
  assert.match(model, /<object id="3" p:UUID="[^"]+" type="model" name="Lid"><components><component objectid="2" p:UUID="[^"]+" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/><\/components><\/object>/);
  assert.ok(!model.includes('name="Robot"'), 'group hierarchy not emitted in the Bambu flavour');
  assert.match(model, /<build p:UUID="[^"]+"><item objectid="3" p:UUID="[^"]+" /);
});

await test('model_settings.config: objects, parts and extruders for a 2-colour object', () => {
  const files = byPath(Writer.buildColorGroupEntries([twoColourMug()], BAMBU));
  const cfg = files[Bambu.BAMBU_MODEL_SETTINGS_PATH];
  assert.ok(cfg, 'model_settings.config present');
  // colorgroup id=1, parts 2 (red) + 3 (blue), parent 4.
  assert.ok(cfg.includes(
    ' <object id="4">\n' +
    '  <metadata key="name" value="Mug"/>\n' +
    '  <metadata key="extruder" value="1"/>\n' +
    '  <part id="2" subtype="normal_part">\n' +
    '   <metadata key="name" value="Mug_red"/>\n' +
    '   <metadata key="extruder" value="1"/>\n' +
    '  </part>\n' +
    '  <part id="3" subtype="normal_part">\n' +
    '   <metadata key="name" value="Mug_blue"/>\n' +
    '   <metadata key="extruder" value="2"/>\n' +
    '  </part>\n' +
    ' </object>\n'), cfg);
  assert.match(cfg, /<plate>\n {2}<metadata key="plater_id" value="1"\/>/);
  assert.match(cfg, /<model_instance>\n {3}<metadata key="object_id" value="4"\/>\n {3}<metadata key="instance_id" value="0"\/>/);
  assert.ok(!cfg.includes('thumbnail_file'), 'no plate thumbnail reference without a thumbnail');
  // Part ids in the config = component objectids in the model.
  const model = files['3D/3dmodel.model'];
  for (const id of [2, 3]) assert.match(model, new RegExp(`<component objectid="${id}" `));
  // project_settings.config: minimal valid JSON with the used slot colours.
  const proj = JSON.parse(files[Bambu.BAMBU_PROJECT_SETTINGS_PATH]);
  assert.deepEqual(proj, { filament_colour: ['#FF0000', '#0000FF'] });
  // .config parts declared; no paint data.
  assert.match(files['[Content_Types].xml'], /<Default Extension="config" ContentType="text\/plain"\/>/);
  assert.ok(!/paint_color/.test(model) && !/paint_color/.test(cfg));
});

await test('same colour across objects shares a slot', () => {
  const a = multiUnit('A', [colouredMesh('A_red', RGB.red)]);
  const b = multiUnit('B', [colouredMesh('B_red', RGB.red), colouredMesh('B_green', RGB.green)]);
  const files = byPath(Writer.buildColorGroupEntries([a, b], BAMBU));
  const extruders = [...files[Bambu.BAMBU_MODEL_SETTINGS_PATH].matchAll(/<part id="\d+" subtype="normal_part">\n {3}<metadata key="name" value="([^"]+)"\/>\n {3}<metadata key="extruder" value="(\d)"/g)]
    .map(m => [m[1], m[2]]);
  assert.deepEqual(extruders, [['A_red', '1'], ['B_red', '1'], ['B_green', '2']]);
  assert.deepEqual(JSON.parse(files[Bambu.BAMBU_PROJECT_SETTINGS_PATH]).filament_colour, ['#FF0000', '#00FF00']);
});

await test('5-colour object: slots 1-4, the fifth shares slot 4 and warns', () => {
  const names = ['red', 'green', 'blue', 'white', 'black'];
  const unit = multiUnit('Toy', names.map(n => colouredMesh(`Toy_${n}`, RGB[n])));
  const warnings = [];
  const files = byPath(Writer.buildColorGroupEntries([unit], { ...BAMBU, onWarning: w => warnings.push(w) }));
  const slots = [...files[Bambu.BAMBU_MODEL_SETTINGS_PATH].matchAll(/<part id="\d+" subtype="normal_part">\n {3}<metadata key="name" value="[^"]+"\/>\n {3}<metadata key="extruder" value="(\d)"/g)]
    .map(m => Number(m[1]));
  assert.deepEqual(slots, [1, 2, 3, 4, 4]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, '3mf-bambu-slot-overflow');
  assert.deepEqual(warnings[0].overflow, ['#000000FF']);
  assert.match(warnings[0].message, /5 materials but only 4 filament slots/);
  assert.equal(JSON.parse(files[Bambu.BAMBU_PROJECT_SETTINGS_PATH]).filament_colour.length, 4);
  // ≤4 colours → no warning.
  const quiet = [];
  Writer.buildColorGroupEntries([twoColourMug()], { ...BAMBU, onWarning: w => quiet.push(w) });
  assert.equal(quiet.length, 0);
});

await test('thumbnail: Metadata/thumbnail.png AND Metadata/plate_1.png, plate references it', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]);
  const files = byPath(Writer.buildColorGroupEntries([twoColourMug()], { ...BAMBU, thumbnailPng: png }));
  assert.equal(files['Metadata/thumbnail.png'], png);
  assert.equal(files[Bambu.BAMBU_PLATE_THUMBNAIL_PATH], png);
  assert.ok(files['_rels/.rels'].includes('Target="/Metadata/thumbnail.png"'));
  assert.ok(files[Bambu.BAMBU_MODEL_SETTINGS_PATH].includes('<metadata key="thumbnail_file" value="Metadata/plate_1.png"/>'));
  assert.match(files['[Content_Types].xml'], /Extension="png" ContentType="image\/png"/);
});

await test('package listing (bambu) vs core: core flavour output unchanged', () => {
  const bambu = Writer.buildColorGroupEntries([twoColourMug()], BAMBU).map(e => e.path);
  assert.deepEqual(bambu, [
    '[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model',
    'Metadata/model_settings.config', 'Metadata/project_settings.config',
  ]);
  resetScene();
  for (const flavour of [undefined, 'core', 'prusa']) {
    const files = byPath(Writer.buildColorGroupEntries([twoColourMug()], { flavour }));
    assert.deepEqual(Object.keys(files), ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    assert.ok(!/p:UUID|requiredextensions|Extension="config"/.test(files['3D/3dmodel.model'] + files['[Content_Types].xml']));
  }
});

await test('textured content keeps the Materials Extension under the Bambu flavour (rule 6)', async () => {
  const unit = multiUnit('Body', [colouredMesh('Body_tex', RGB.white, { textured: true }), colouredMesh('Body_blue', RGB.blue)]);
  const files = byPath(await Writer.buildMaterialsExtEntries([unit], BAMBU));
  const model = files['3D/3dmodel.model'];
  assert.match(model, /<m:texture2d id="1" path="\/3D\/Textures\/Body_baseColor\.png"/);
  assert.match(model, /requiredextensions="p"/);
  assert.ok(files['3D/Textures/Body_baseColor.png'] && files['3D/_rels/3dmodel.model.rels']);
  const cfg = files[Bambu.BAMBU_MODEL_SETTINGS_PATH];
  assert.match(cfg, /value="Body_tex"\/>\n {3}<metadata key="extruder" value="1"/);
  assert.match(cfg, /value="Body_blue"\/>\n {3}<metadata key="extruder" value="2"/);
  const container = await Loader.__test.buildContainer(scene, { file: path => files[path] ? { async: async () => files[path] } : null }, model);
  assert.equal(container.meshes.length, 2);
});

await test('loader round-trip: our Bambu-flavoured model re-imports as one node with its parts', async () => {
  const model = byPath(Writer.buildColorGroupEntries([twoColourMug()], BAMBU))['3D/3dmodel.model'];
  const container = await Loader.__test.buildContainer(scene, null, model);
  assert.equal(container.meshes.length, 2);
  assert.equal(container.transformNodes.length, 1);
  assert.equal(container.transformNodes[0].name, 'Mug');
  assert.ok(container.meshes.every(m => m.parent === container.transformNodes[0]));
  assert.deepEqual(container.meshes.map(m => m.name).sort(), ['Mug_blue', 'Mug_red']);
  const colours = container.meshes.map(m => [m.material.diffuseColor.r, m.material.diffuseColor.b]);
  assert.deepEqual(colours, [[1, 0], [0, 1]]);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
