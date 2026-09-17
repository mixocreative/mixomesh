// 3MF loader per-triangle material tests (writer → loader round trip of a
// multi-mesh logical unit, plus third-party per-triangle `pid` files). Run:
//   node --import ./tests/register-hooks.mjs tests/threemf-loader-materials.test.mjs
//
// XML/DOM harness copied from tests/threemf-components.test.mjs.

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

/** Single-triangle fake mesh at an X offset with a solid colour or a fake texture. */
function makeMesh(name, { color = [0, 1, 0], offsetX = 0, uvs = null, textureName = null } = {}) {
  const mesh = new BABYLON.Mesh(name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = [offsetX, 0, 0, offsetX + 1, 0, 0, offsetX, 1, 0];
  vd.indices = [0, 1, 2];
  if (uvs) vd.uvs = uvs;
  vd.applyToMesh(mesh);
  const mat = new BABYLON.StandardMaterial(`${name}__mat`, scene);
  mat.diffuseColor = new BABYLON.Color3(...color);
  if (textureName) {
    mat.diffuseTexture = {
      name: textureName,
      getBaseSize() { return { width: 1, height: 1 }; },
      readPixels() { return new Uint8Array([255, 255, 255, 255]); },
    };
  }
  mesh.material = mat;
  return mesh;
}

/** One logical unit made of N sibling meshes (a Blender object split per material). */
function unitOf(logicalId, meshes) {
  return {
    logicalId,
    name: logicalId,
    meshes: meshes.map((mesh, i) => ({
      meshId: `${logicalId}_${i}`, logicalId, logicalName: logicalId, name: mesh.name, mesh,
    })),
  };
}

function flatState(ids) {
  const objects = {};
  for (const id of ids) objects[id] = { id, name: id, parentId: null, collectionId: 'c', visible: true, isPrintPart: true };
  return { scene: { objects, groups: {}, assetLibrary: {} } };
}

function modelOf(entries) {
  return entries.find(e => e.path === '3D/3dmodel.model').data;
}

const round = (arr, d = 5) => Array.from(arr).map(v => Math.round(v * 10 ** d) / 10 ** d);

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetScene();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('writer→loader: colorgroup unit of two sibling meshes re-imports as two meshes under one node', async () => {
  const green = makeMesh('Body_green', { color: [0, 1, 0] });
  const red = makeMesh('Body_red', { color: [1, 0, 0], offsetX: 5 });
  const unit = unitOf('body', [green, red]);
  const model = modelOf(Writer.buildColorGroupEntries([unit], { state: flatState(['body']) }));

  // Writer shape this test guards: ONE object, PER-TRIANGLE pid/p1..p3.
  assert.equal((model.match(/<object /g) ?? []).length, 1, 'one <object> for the unit');
  assert.match(model, /<triangle v1="0" v2="1" v3="2" pid="1" p1="0" p2="0" p3="0"\/>/);
  assert.match(model, /<triangle v1="3" v2="4" v3="5" pid="1" p1="1" p2="1" p3="1"\/>/);

  const container = await Loader.__test.buildContainer(scene, null, model);
  assert.equal(container.meshes.length, 2, 'one Babylon mesh per material key');
  assert.equal(container.transformNodes.length, 1, 'one shared parent node');
  const node = container.transformNodes[0];
  assert.equal(node.metadata.importHierarchy, true);
  assert.ok(node.metadata.threeMFObjectId, 'node carries the 3MF object id');
  const [m0, m1] = container.meshes;
  assert.equal(m0.parent, node);
  assert.equal(m1.parent, node);
  assert.equal(m0.getTotalVertices(), 3);
  assert.equal(m1.getTotalVertices(), 3);
  assert.deepEqual([m0.material.diffuseColor.r, m0.material.diffuseColor.g, m0.material.diffuseColor.b], [0, 1, 0]);
  assert.deepEqual([m1.material.diffuseColor.r, m1.material.diffuseColor.g, m1.material.diffuseColor.b], [1, 0, 0]);
  assert.notEqual(m0.material, m1.material, 'one material per sub-mesh');
  assert.ok(m0.metadata.sourceGroupId && m0.metadata.sourceGroupId === m1.metadata.sourceGroupId,
    'siblings share a sourceGroupId so AssetRegistration groups them as one logical object');
  assert.match(m0.name, /^Part_\d+__mat0$/);
  assert.match(m1.name, /^Part_\d+__mat1$/);
  // Geometry survives: the red sibling sits 5 mm along Babylon X from green
  // (writer centres the build; toPrintSpace/fromPrintSpace negate X twice).
  const p0 = round(m0.getVerticesData('position'));
  const p1 = round(m1.getVerticesData('position'));
  assert.equal(Math.round((p1[0] - p0[0]) * 1e5) / 1e5, 5);
  assert.deepEqual(Array.from(m0.getIndices()), [0, 1, 2], 'file index order kept');
});

await test('writer→loader: textured unit (two texture2dgroups) reconstructs each sub-mesh UV set exactly', async () => {
  const a = makeMesh('Body_a', { uvs: [0.25, 0.5, 0.75, 0.5, 0.25, 1], textureName: 'paintA' });
  const b = makeMesh('Body_b', { uvs: [0.125, 0.0625, 0.875, 0.0625, 0.5, 0.9375], textureName: 'paintB', offsetX: 5 });
  const unit = unitOf('body', [a, b]);
  const model = modelOf(await Writer.buildMaterialsExtEntries([unit], { state: flatState(['body']) }));

  assert.equal((model.match(/<m:texture2dgroup /g) ?? []).length, 2, 'one texture2dgroup per sibling mesh');
  assert.equal((model.match(/<object /g) ?? []).length, 1);
  // Second sibling's p-indices are LOCAL to its own group (0..2), vertices offset by 3.
  assert.match(model, /<triangle v1="3" v2="4" v3="5" pid="\d+" p1="0" p2="1" p3="2"\/>/);

  const container = await Loader.__test.buildContainer(scene, null, model);
  assert.equal(container.meshes.length, 2);
  assert.equal(container.transformNodes.length, 1);
  const [m0, m1] = container.meshes;
  assert.equal(m0.parent, container.transformNodes[0]);
  assert.equal(m1.parent, container.transformNodes[0]);
  assert.equal(m0.getTotalVertices(), 3);
  assert.equal(m1.getTotalVertices(), 3);
  assert.deepEqual(round(m0.getVerticesData('uv'), 6), [0.25, 0.5, 0.75, 0.5, 0.25, 1]);
  assert.deepEqual(round(m1.getVerticesData('uv'), 6), [0.125, 0.0625, 0.875, 0.0625, 0.5, 0.9375]);
  assert.notEqual(m0.material, m1.material);
  assert.equal(m0.metadata.sourceGroupId, m1.metadata.sourceGroupId);
});

await test('third-party 3MF: per-triangle pid mixing two colorgroup entries over one vertex pool → two meshes', async () => {
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1"><m:color color="#FF0000FF"/><m:color color="#0000FFFF"/></m:colorgroup>
    <object id="2" type="model" name="Quad" pid="1" pindex="0"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
    </vertices><triangles>
      <triangle v1="0" v2="1" v3="2"/>
      <triangle v1="0" v2="2" v3="3" pid="1" p1="1"/>
    </triangles></mesh></object>
  </resources>
  <build><item objectid="2"/></build>
</model>`;
  const container = await Loader.__test.buildContainer(scene, null, modelXml);

  assert.equal(container.meshes.length, 2);
  assert.equal(container.transformNodes.length, 1);
  const node = container.transformNodes[0];
  assert.equal(node.name, 'Quad');
  assert.deepEqual(node.metadata, { threeMFObjectId: '2', importHierarchy: true });
  const [m0, m1] = container.meshes;
  assert.equal(m0.name, 'Quad__mat0');
  assert.equal(m1.name, 'Quad__mat1');
  assert.equal(m0.parent, node);
  assert.equal(m1.parent, node);
  // First triangle inherits the object's pid/pindex (3MF Core §4.1) → red;
  // second names p1=1 (p2/p3 default to p1) → blue.
  assert.deepEqual([m0.material.diffuseColor.r, m0.material.diffuseColor.b], [1, 0]);
  assert.deepEqual([m1.material.diffuseColor.r, m1.material.diffuseColor.b], [0, 1]);
  // Shared pool compacted per sub-mesh: 3 vertices each, indices re-based.
  assert.equal(m0.getTotalVertices(), 3);
  assert.equal(m1.getTotalVertices(), 3);
  assert.deepEqual(Array.from(m0.getIndices()), [0, 1, 2]);
  assert.deepEqual(Array.from(m1.getIndices()), [0, 1, 2]);
  // 3MF (x,y,z) → Babylon (-x, z, -y): vertex 2 (10,10,0) → (-10, 0, -10) in both.
  assert.deepEqual(round(m0.getVerticesData('position')), [0, 0, 0, -10, 0, 0, -10, 0, -10]);
  assert.deepEqual(round(m1.getVerticesData('position')), [0, 0, 0, -10, 0, -10, 0, 0, -10]);
  assert.equal(m0.metadata.sourceGroupId, m1.metadata.sourceGroupId);
});

await test('per-triangle pid that all resolve to the object default keeps the single-mesh fast path', async () => {
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1"><m:color color="#FF0000FF"/><m:color color="#0000FFFF"/></m:colorgroup>
    <object id="2" type="model" name="Quad" pid="1" pindex="1"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
    </vertices><triangles>
      <triangle v1="0" v2="1" v3="2"/>
      <triangle v1="0" v2="2" v3="3" pid="1" p1="1" p2="1" p3="1"/>
    </triangles></mesh></object>
  </resources>
  <build><item objectid="2"/></build>
</model>`;
  const container = await Loader.__test.buildContainer(scene, null, modelXml);
  assert.equal(container.meshes.length, 1);
  assert.equal(container.transformNodes.length, 0, 'no wrapper node for a single-material object');
  const m = container.meshes[0];
  assert.equal(m.name, 'Quad');
  assert.equal(m.getTotalVertices(), 4, 'full vertex pool kept on the fast path');
  assert.deepEqual(Array.from(m.getIndices()), [0, 1, 2, 0, 2, 3]);
  assert.equal(m.material.diffuseColor.b, 1);
  assert.equal(m.metadata?.sourceGroupId, undefined);
});

await test('multi-material object nested in a component assembly parents its wrapper under the component node', async () => {
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1"><m:color color="#FF0000FF"/><m:color color="#0000FFFF"/></m:colorgroup>
    <object id="2" type="model" name="Quad"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
    </vertices><triangles>
      <triangle v1="0" v2="1" v3="2" pid="1" p1="0"/>
      <triangle v1="0" v2="2" v3="3" pid="1" p1="1"/>
    </triangles></mesh></object>
    <object id="3" type="model" name="Robot"><components>
      <component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
    </components></object>
  </resources>
  <build><item objectid="3"/></build>
</model>`;
  const container = await Loader.__test.buildContainer(scene, null, modelXml);
  assert.equal(container.meshes.length, 2);
  assert.equal(container.transformNodes.length, 2);
  const robot = container.transformNodes.find(n => n.name === 'Robot');
  const quad = container.transformNodes.find(n => n.name === 'Quad');
  assert.ok(robot && quad);
  assert.equal(quad.parent, robot);
  for (const m of container.meshes) assert.equal(m.parent, quad);
  // Component placement baked into vertices: x=5 → Babylon -5 on vertex 0.
  assert.equal(round(container.meshes[0].getVerticesData('position'))[0], -5);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
