import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { serializeOBJ } = await import('../src/core/print/ObjWriter.js');
const { uniqueEntryPaths } = await import('../src/core/print/PrintPackaging.js');

const tri = (name, color) => ({
  name, material: { id: `mat-${name}`, diffuseColor: color },
  getVerticesData: (k) => (k === 'position' ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
  getIndices: () => [0, 1, 2],
});

test('per-part OBJ: parts named Cube and cube each link the MTL with their own colour', async () => {
  const entries = [tri('Cube', { r: 1, g: 0, b: 0 }), tri('cube', { r: 0, g: 0, b: 1 })].map(mesh => ({ mesh }));
  const out = await serializeOBJ({
    meshes: entries, individually: true,
    cloneGroups: entries.map(e => ({ name: e.mesh.name, meshes: [e] })),
    projectName: 'P', referenceRatio: 1, targetRatio: 1, prefs: {}, state: { print: {} },
  });
  const files = Object.fromEntries(uniqueEntryPaths(out.entries).map(e => [e.path, String(e.data)]));
  const objs = Object.keys(files).filter(p => p.endsWith('.obj'));
  assert.equal(objs.length, 2, `both parts packaged: ${Object.keys(files)}`);
  const kdByPart = {};
  for (const p of objs) {
    const part = files[p].match(/^o (\S+)$/m)[1];
    const mtl = files[files[p].match(/^mtllib (.+)$/m)[1]];
    assert.ok(mtl, `${p} links a packaged MTL`);
    kdByPart[part] = mtl.match(/^Kd (.+)$/m)[1];
  }
  assert.deepEqual(kdByPart, { Cube: '1.0000 0.0000 0.0000', cube: '0.0000 0.0000 1.0000' });
});
