// 3MF component hierarchy tests. Run:
//   node --import ./tests/register-hooks.mjs tests/threemf-components.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
console.error = () => {};

class XmlNode {
  constructor(tagName, attrs = {}, parent = null) {
    this.tagName = tagName;
    this.nodeName = tagName;
    this.localName = tagName.includes(':') ? tagName.split(':').at(-1) : tagName;
    this.attributes = attrs;
    this.parentNode = parent;
    this.children = [];
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  getElementsByTagName(name) { return collect(this, n => n.localName === name || n.tagName === name); }
  getElementsByTagNameNS(_ns, name) { return collect(this, n => n.localName === name); }
}

class SimpleXmlDoc extends XmlNode {
  constructor(root) {
    super('#document');
    if (root) {
      this.children.push(root);
      root.parentNode = this;
    }
  }
}

function collect(root, pred) {
  const out = [];
  const stack = [...(root.children ?? [])];
  while (stack.length) {
    const n = stack.shift();
    if (pred(n)) out.push(n);
    stack.unshift(...(n.children ?? []));
  }
  return out;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  for (const m of raw.matchAll(re)) attrs[m[1]] = m[2];
  return attrs;
}

globalThis.DOMParser = class {
  parseFromString(xml) {
    const stack = [];
    let root = null;
    const re = /<([^!?][^>]*?)>/g;
    for (const m of xml.matchAll(re)) {
      let token = m[1].trim();
      if (!token || token.startsWith('/')) {
        if (token.startsWith('/')) stack.pop();
        continue;
      }
      const selfClosing = token.endsWith('/');
      if (selfClosing) token = token.slice(0, -1).trim();
      const space = token.search(/\s/);
      const name = space === -1 ? token : token.slice(0, space);
      const attrs = parseAttrs(space === -1 ? '' : token.slice(space + 1));
      const parent = stack.at(-1) ?? null;
      const node = new XmlNode(name, attrs, parent);
      if (parent) parent.children.push(node);
      else root = node;
      if (!selfClosing) stack.push(node);
    }
    return new SimpleXmlDoc(root);
  }
};

const { setState } = await import('../src/core/StateManager.js');
const Writer = await import('../src/core/print/ThreeMFWriter.js');
const Loader = await import('../src/core/ThreeMFLoader.js');

assert.equal(typeof Loader.__test?.buildContainer, 'function',
  'ThreeMFLoader must expose test access to the model XML container builder');

let engine = null;
let scene = null;

function resetScene() {
  scene?.dispose();
  engine?.dispose();
  engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
  scene = new BABYLON.Scene(engine);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: {},
      groups: {},
      collections: {},
      assetLibrary: {},
      shaders: {},
      validation: {},
    },
  }), { silent: true });
}

function makeMesh(name, { textured = false } = {}) {
  const mesh = new BABYLON.Mesh(name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  vd.indices = [0, 1, 2];
  if (textured) vd.uvs = [0, 0, 1, 0, 0, 1];
  vd.applyToMesh(mesh);
  const mat = new BABYLON.StandardMaterial(`${name}__mat`, scene);
  mat.diffuseColor = new BABYLON.Color3(0, 1, 0);
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

function unit(mesh, id) {
  return { logicalId: id, name: id, meshes: [{ meshId: id, logicalId: id, logicalName: id, name: id, mesh }] };
}

function stateForHierarchy() {
  return {
    scene: {
      objects: {
        body: { id: 'body', name: 'Body', parentId: 'robot', collectionId: 'import_a', visible: true, isPrintPart: true },
      },
      groups: {
        robot: { id: 'robot', name: 'Robot', parentId: null, childIds: ['body'], origin: 'user' },
      },
      assetLibrary: {},
    },
  };
}

function stateForNestedHierarchy() {
  return {
    scene: {
      objects: {
        body: { id: 'body', name: 'Body', parentId: 'child', collectionId: 'import_a', visible: true, isPrintPart: true },
      },
      groups: {
        parent: { id: 'parent', name: 'Parent', parentId: null, childIds: [], origin: 'user' },
        child: { id: 'child', name: 'Child', parentId: 'parent', childIds: ['body'], origin: 'user' },
      },
      assetLibrary: {},
    },
  };
}

function objectStart(model, objectId) {
  return model.indexOf(`<object id="${objectId}"`);
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetScene();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('solid 3MF export emits component objects for hierarchy instead of root build meshes', () => {
  const mesh = makeMesh('Body');
  const entries = Writer.buildColorGroupEntries([unit(mesh, 'body')], { state: stateForHierarchy() });
  const model = entries.find(e => e.path === '3D/3dmodel.model').data;

  assert.match(model, /<components>/, 'component assembly missing');
  assert.match(model, /<object id="\d+" type="model" name="Robot"><components>/);
  const meshObject = model.match(/<object id="(\d+)" type="model" pid="1" pindex="0">/);
  const groupObject = model.match(/<object id="(\d+)" type="model" name="Robot"><components>/);
  assert.ok(meshObject && groupObject, 'expected mesh object and group object');
  assert.match(model, new RegExp(`<component objectid="${meshObject[1]}" transform="1 0 0 0 1 0 0 0 1 0 0 0"\\/>`));
  assert.match(model, new RegExp(`<build><item objectid="${groupObject[1]}" transform="1 0 0 0 1 0 0 0 1 0 0 0"\\/>`));
});

await test('textured 3MF export keeps Materials Extension resources and component hierarchy', async () => {
  const mesh = makeMesh('Body', { textured: true });
  const entries = await Writer.buildMaterialsExtEntries([unit(mesh, 'body')], { state: stateForHierarchy() });
  const model = entries.find(e => e.path === '3D/3dmodel.model').data;

  assert.match(model, /<m:texture2d id="1" path="\/3D\/Textures\/paint\.png" contenttype="image\/png"\/>/);
  assert.match(model, /<m:texture2dgroup id="2" texid="1">/);
  assert.match(model, /<object id="\d+" type="model" name="Robot"><components>/);
  assert.match(model, /<component objectid="\d+" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/>/);
});

await test('nested 3MF components define children before parents that reference them', () => {
  const mesh = makeMesh('Body');
  const entries = Writer.buildColorGroupEntries([unit(mesh, 'body')], { state: stateForNestedHierarchy() });
  const model = entries.find(e => e.path === '3D/3dmodel.model').data;

  const meshObject = model.match(/<object id="(\d+)" type="model" pid="1" pindex="0">/);
  const childObject = model.match(/<object id="(\d+)" type="model" name="Child"><components>/);
  const parentObject = model.match(/<object id="(\d+)" type="model" name="Parent"><components>/);
  assert.ok(meshObject && childObject && parentObject, 'expected mesh, child group, and parent group object resources');

  assert.match(model, new RegExp(`<component objectid="${childObject[1]}" transform="1 0 0 0 1 0 0 0 1 0 0 0"\\/>`));
  assert.ok(objectStart(model, meshObject[1]) < objectStart(model, childObject[1]), 'mesh object must precede child component object');
  assert.ok(objectStart(model, childObject[1]) < objectStart(model, parentObject[1]), 'child component object must precede parent component object');
});

await test('3MF component import creates transform groups and child meshes', async () => {
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1"><m:color color="#00FF00FF"/></m:colorgroup>
    <object id="2" type="model" pid="1" pindex="0"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
    </vertices><triangles><triangle v1="0" v2="2" v3="1"/></triangles></mesh></object>
    <object id="3" type="model" name="Robot"><components>
      <component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
    </components></object>
  </resources>
  <build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build>
</model>`;
  const container = await Loader.__test.buildContainer(scene, null, modelXml);

  assert.equal(container.transformNodes.length, 1);
  assert.equal(container.transformNodes[0].name, 'Robot');
  assert.equal(container.meshes.length, 1);
  assert.equal(container.meshes[0].parent, container.transformNodes[0]);
  assert.equal(container.meshes[0].material.diffuseColor.g, 1);
});

await test('3MF import follows production component paths into related model parts', async () => {
  const rootModelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>
    <object id="2" type="model" name="PlateObject"><components>
      <component p:path="/3D/Objects/object_46.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 4 0 0"/>
    </components></object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build>
</model>`;
  const relatedModelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>
    <object id="1" type="model"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
    </vertices><triangles><triangle v1="0" v2="2" v3="1"/></triangles></mesh></object>
  </resources>
</model>`;
  const files = new Map([['3D/Objects/object_46.model', relatedModelXml]]);
  const zip = {
    file(path) {
      const clean = String(path).replace(/^\//, '');
      const text = files.get(clean);
      return text ? { async: async () => text } : null;
    },
  };

  const container = await Loader.__test.buildContainer(scene, zip, rootModelXml);

  assert.equal(container.transformNodes.length, 1);
  assert.equal(container.transformNodes[0].name, 'PlateObject');
  assert.equal(container.meshes.length, 1);
  assert.equal(container.meshes[0].parent, container.transformNodes[0]);
});


// ── Independent producer: PrusaSlicer 2.9.3 (`prusa-slicer-console --export-3mf`)
// wrote tests/fixtures/prusa-tetra.3mf from a tetrahedron with glTF vertices
// (0,0,0) (10,0,0) (0,20,0) (0,0,30). Its model XML is embedded verbatim below
// (class-d fixture, S24). Expected Babylon result = PrintSpace.fromPrintSpace.
const PRUSA_TETRA_MODEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="slic3rpe:Version3mf">1</metadata>
 <metadata name="Title">prusa-tetra</metadata>
 <metadata name="Designer"></metadata>
 <metadata name="Description">prusa-tetra</metadata>
 <metadata name="Copyright"></metadata>
 <metadata name="LicenseTerms"></metadata>
 <metadata name="Rating"></metadata>
 <metadata name="CreationDate">2026-09-17</metadata>
 <metadata name="ModificationDate">2026-09-17</metadata>
 <metadata name="Application">PrusaSlicer-2.9.3</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex x="10.000001" y="0" z="0"/>
     <vertex x="0" y="20.0000019" z="0"/>
     <vertex x="0" y="0" z="30.0000019"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/>
     <triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/>
     <triangle v1="1" v2="2" v3="3"/>
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>
`;

const signedVol = (pos, idx) => {
  let v6 = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    v6 += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v6 / 6;
};

await test('3MF import (PrusaSlicer-written file): +Z up → Babylon +Y, x reflected, winding Babylon-outward', async () => {
  const container = await Loader.__test.buildContainer(scene, null, PRUSA_TETRA_MODEL_XML);
  assert.equal(container.meshes.length, 1);
  const m = container.meshes[0];
  const pos = Array.from(m.getVerticesData('position')).map(v => Math.round(v * 1e6) / 1e6);
  // 3MF (x, y, z) → Babylon (-x, z, -y): apex (0,0,30) lands at (0, 30, 0), i.e. UP.
  assert.deepEqual(pos, [0, 0, 0, -10.000001, 0, 0, 0, 0, -20.000002, 0, 30.000002, 0]);
  const idx = Array.from(m.getIndices());
  assert.deepEqual(idx, [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], 'file order kept (reflection makes it Babylon-CCW-outward)');
  assert.ok(signedVol(pos, idx) < 0, 'negative raw signed volume = outward for a CounterClockWise-flagged Babylon mesh');
  assert.notEqual(m.sideOrientation, 0, 'loader meshes keep the default CounterClockWise flag');
});

await test('3MF import honours the model unit attribute (inch → mm ×25.4; unknown unit → throws)', async () => {
  const inch = PRUSA_TETRA_MODEL_XML.replace('unit="millimeter"', 'unit="inch"');
  const c = await Loader.__test.buildContainer(scene, null, inch);
  const pos = Array.from(c.meshes[0].getVerticesData('position'));
  assert.ok(Math.abs(pos[3] - (-10.000001 * 25.4)) < 1e-3, `x scaled by 25.4, got ${pos[3]}`);
  assert.ok(Math.abs(pos[10] - (30.000002 * 25.4)) < 1e-3, `apex scaled by 25.4, got ${pos[10]}`);
  const bad = PRUSA_TETRA_MODEL_XML.replace('unit="millimeter"', 'unit="furlong"');
  await assert.rejects(Loader.__test.buildContainer(scene, null, bad), /unsupported unit "furlong"/);
});

await test('3MF import refuses a triangle whose vertex index is out of range (no silent garbage mesh)', async () => {
  const oob = PRUSA_TETRA_MODEL_XML.replace('<triangle v1="1" v2="2" v3="3"/>', '<triangle v1="1" v2="2" v3="99"/>');
  await assert.rejects(Loader.__test.buildContainer(scene, null, oob), /references a vertex outside 0\.\.3/);
  const nan = PRUSA_TETRA_MODEL_XML.replace('<vertex x="10.000001" y="0" z="0"/>', '<vertex x="ten" y="0" z="0"/>');
  await assert.rejects(Loader.__test.buildContainer(scene, null, nan), /non-numeric coordinate/);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
