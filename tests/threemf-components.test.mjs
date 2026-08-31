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

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
