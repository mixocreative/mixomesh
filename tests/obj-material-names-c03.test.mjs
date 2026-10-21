import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { serializeOBJ } = await import('../src/core/print/ObjWriter.js');

const tri = (name, material) => ({
  name, material,
  getVerticesData: (k) => (k === 'position' ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
  getIndices: () => [0, 1, 2],
});

const ctxFor = (meshes) => ({
  meshes: meshes.map(mesh => ({ mesh })), cloneGroups: [], individually: false,
  projectName: 'P', referenceRatio: 1, targetRatio: 1, prefs: {}, state: { print: {} },
});

const parse = (out) => {
  const files = Object.fromEntries(out.entries.map(e => [e.path, String(e.data)]));
  const obj = files['P_r1to1.obj'];
  const mtl = files['P_r1to1.mtl'];
  const usemtlByObject = {};
  let cur = null;
  for (const line of obj.split('\n')) {
    if (line.startsWith('o ')) cur = line.slice(2);
    if (line.startsWith('usemtl ')) usemtlByObject[cur] = line.slice(7);
  }
  const kdByMtl = {};
  for (const block of mtl.split(/\n(?=newmtl )/)) {
    const name = block.match(/^newmtl (\S+)/m)?.[1];
    kdByMtl[name] = block.match(/^Kd (.+)$/m)?.[1];
  }
  return { usemtlByObject, kdByMtl };
};

test('two shaders that share a source material name keep their own colours in the OBJ', async () => {
  // Babylon keeps the file's name in `id`; the library's default "Rename"
  // only bumps the display name (C-03 probe: both matId "Paint").
  const red = { id: 'Paint', name: 'Paint', diffuseColor: { r: 1, g: 0, b: 0 } };
  const blue = { id: 'Paint', name: 'Paint.001', diffuseColor: { r: 0, g: 0, b: 1 } };
  const { usemtlByObject, kdByMtl } = parse(await serializeOBJ(ctxFor([tri('CubeA', red), tri('CubeB', blue)])));
  assert.notEqual(usemtlByObject.CubeA, usemtlByObject.CubeB, 'distinct shaders get distinct usemtl names');
  assert.equal(kdByMtl[usemtlByObject.CubeA], '1.0000 0.0000 0.0000', 'CubeA prints red');
  assert.equal(kdByMtl[usemtlByObject.CubeB], '0.0000 0.0000 1.0000', 'CubeB prints blue');
});

test('identical display names and ids still yield one newmtl per distinct shader', async () => {
  const a = { id: 'Material', name: 'Material', diffuseColor: { r: 1, g: 0, b: 0 } };
  const b = { id: 'Material', name: 'Material', diffuseColor: { r: 0, g: 1, b: 0 } };
  const c = { id: 'material', name: 'material', diffuseColor: { r: 0, g: 0, b: 1 } };
  const { usemtlByObject, kdByMtl } = parse(await serializeOBJ(ctxFor([tri('A', a), tri('B', b), tri('C', c), tri('D', a)])));
  const names = [usemtlByObject.A, usemtlByObject.B, usemtlByObject.C];
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 3, `case-insensitively unique: ${names}`);
  assert.equal(usemtlByObject.D, usemtlByObject.A, 'one shared shader stays one material');
  assert.equal(Object.keys(kdByMtl).length, 3);
  assert.equal(kdByMtl[usemtlByObject.B], '0.0000 1.0000 0.0000');
});
