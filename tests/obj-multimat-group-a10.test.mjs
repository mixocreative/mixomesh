import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
const { Scene } = await import('@babylonjs/core/scene.js');
const { SceneLoader } = await import('@babylonjs/core/Loading/sceneLoader.js');
await import('@babylonjs/loaders/OBJ/index.js');
const { splitMultiMaterialMeshesInContainer } = await import('../src/core/assets/MeshSplit.js');

const scene = new Scene(new NullEngine());

async function importGroups(objText) {
  const container = await SceneLoader.LoadAssetContainerAsync(`data:${objText}`, '', scene, null, '.obj');
  splitMultiMaterialMeshesInContainer(container);
  return container.meshes
    .filter(m => m.getTotalVertices() > 0)
    .map(m => ({ name: m.name, group: m.metadata?.sourceGroupId ?? null, objectName: m.metadata?.sourceMeshName ?? null }));
}

const QUAD = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\n';

test('one OBJ object with two materials imports as one multi-part object', async () => {
  const parts = await importGroups(`o Cube\n${QUAD}usemtl Tex\nf 1 2 3\nusemtl Red\nf 1 3 4\n`);
  assert.equal(parts.length, 2, 'Babylon yields one mesh per material');
  assert.ok(parts[0].group, 'parts carry a split-group stamp');
  assert.equal(parts[1].group, parts[0].group, 'both material parts share one group');
  assert.deepEqual(parts.map(p => p.objectName), ['Cube', 'Cube']);
});

test('separate OBJ objects and groups are never merged', async () => {
  const parts = await importGroups(
    `${QUAD}o Cube\nusemtl A\nf 1 2 3\nusemtl B\nf 1 3 4\no Other\nusemtl A\nf 1 2 3\ng G2\nusemtl B\nf 1 3 4\nusemtl A\nf 1 2 4\n`);
  const byName = parts.map(p => `${p.name}:${p.objectName}`);
  assert.deepEqual(byName, ['Cube:Cube', 'mesh_mm1:Cube', 'Other:null', 'G2:G2', 'mesh_mm1:G2']);
  const [cube, cubeB, other, g2, g2b] = parts;
  assert.equal(cubeB.group, cube.group);
  assert.equal(g2b.group, g2.group);
  assert.notEqual(g2.group, cube.group);
  assert.equal(other.group, null, 'a single-material object stays ungrouped');
});
