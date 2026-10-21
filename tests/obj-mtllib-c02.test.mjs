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

async function zipFiles(projectName, meshes, individually) {
  const entries = meshes.map(mesh => ({ mesh }));
  const out = await serializeOBJ({
    meshes: entries, individually,
    cloneGroups: entries.map(e => ({ name: e.mesh.name, meshes: [e] })),
    projectName, referenceRatio: 1, targetRatio: 1, prefs: {}, state: { print: {} },
  });
  return Object.fromEntries(uniqueEntryPaths(out.entries).map(e => [e.path, String(e.data)]));
}

const mtllibOf = (objText) => objText.match(/^mtllib (.+)$/m)?.[1];

for (const projectName of ['My Model', '猫　モデル']) {
  test(`OBJ mtllib names the packaged MTL for project "${projectName}"`, async () => {
    const files = await zipFiles(projectName, [tri('Body', { r: 1, g: 0, b: 0 })], false);
    const objPath = Object.keys(files).find(p => p.endsWith('.obj'));
    const ref = mtllibOf(files[objPath]);
    assert.ok(ref in files, `mtllib ${ref} resolves; entries: ${Object.keys(files)}`);
    assert.doesNotMatch(ref, /\s/, 'mtllib is a single whitespace-free token');
  });
}

test('per-part OBJ: a part name with a space still links its MTL', async () => {
  const files = await zipFiles('My Model', [tri('Left Arm', { r: 1, g: 0, b: 0 })], true);
  const objPath = Object.keys(files).find(p => p.endsWith('.obj'));
  assert.ok(mtllibOf(files[objPath]) in files, `entries: ${Object.keys(files)}`);
});
