import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { bakeImportTransform } = await import('../src/core/ImportNormalizer.js');

function v(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    addInPlace(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; },
    scaleInPlace(f) { this.x *= f; this.y *= f; this.z *= f; return this; },
    scale(f) { return v(this.x * f, this.y * f, this.z * f); },
    set(x2, y2, z2) { this.x = x2; this.y = y2; this.z = z2; return this; },
    copyFrom(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; },
    clone() { return v(this.x, this.y, this.z); },
  };
}

function matrix({ tx = 0, ty = 0, tz = 0 } = {}) {
  return {
    clone() { return matrix({ tx, ty, tz }); },
    setTranslation() {},
    getTranslation() { return v(tx, ty, tz); },
    determinant() { return 1; },
  };
}

function makeNode(name, parent = null) {
  return {
    name,
    parent,
    metadata: {},
    position: v(),
    scaling: v(1, 1, 1),
    rotation: v(),
    rotationQuaternion: null,
    setParent(p) { this.parent = p; },
    dispose() { this.disposed = true; },
    computeWorldMatrix() {},
  };
}

function makeBakeableMesh(name, parent = null, world = matrix()) {
  return {
    ...makeNode(name, parent),
    geometry: {},
    material: { name: `${name}Mat` },
    isVisible: true,
    getTotalVertices: () => 3,
    getVerticesData: () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    getIndices: () => [0, 1, 2],
    computeWorldMatrix() {},
    getWorldMatrix: () => world,
    bakeTransformIntoVertices(M) { this.bakedMatrix = M; },
    makeGeometryUnique() { this.geometryUnique = true; },
    refreshBoundingInfo() { this.refreshed = true; },
    flipFaces() { this.flipped = true; },
  };
}

function makeInstanceMesh(name, sourceMesh, parent = null, world = matrix()) {
  return {
    ...makeNode(name, parent),
    geometry: sourceMesh.geometry,
    material: sourceMesh.material,
    sourceMesh,
    isAnInstance: true,
    isVisible: true,
    getTotalVertices: () => sourceMesh.getTotalVertices(),
    computeWorldMatrix() {},
    getWorldMatrix: () => world,
    refreshBoundingInfo() {},
    dispose() { this.disposed = true; },
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('import normalization materializes instance meshes before vertex baking', () => {
  const root = makeNode('__root__');
  const source = makeBakeableMesh('SourceMesh', root, matrix({ tx: 1 }));
  const instance = makeInstanceMesh('SourceMeshInstance', source, root, matrix({ tx: 4 }));
  source.clone = (name, parent, doNotCloneChildren) => {
    const clone = makeBakeableMesh(name, parent, instance.getWorldMatrix());
    clone.material = source.material;
    clone.metadata = { ...(instance.metadata ?? {}) };
    clone.isVisible = instance.isVisible;
    clone.cloneArgs = { name, parent, doNotCloneChildren };
    return clone;
  };
  const container = {
    meshes: [source, instance],
    transformNodes: [root],
  };

  bakeImportTransform(container, 1);

  assert.equal(instance.disposed, true, 'original instance should be removed');
  assert.equal(container.meshes.length, 2);
  assert.equal(container.meshes[1].name, 'SourceMeshInstance');
  assert.equal(typeof container.meshes[1].bakeTransformIntoVertices, 'function');
  assert.ok(container.meshes[1].bakedMatrix, 'materialized mesh should go through the normal bake path');
  assert.equal(container.meshes[1].geometryUnique, true, 'materialized mesh must own geometry for later per-object bakes');
  assert.equal(container.meshes[1].parent, null, 'normalizer should leave imported meshes transform-clean');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
