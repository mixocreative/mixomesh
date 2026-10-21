import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';
installEnv();
const { GeometryStore, revisionOf, bump, meshIdOf, extract } = await import('../src/core/geometry/GeometryStore.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function fakeMesh({ id = 'mesh_a', positions = [0,0,0, 1,0,0, 0,1,0], indices = [0,1,2], uvs = null, matrix = IDENTITY } = {}) {
  const data = { position: Float32Array.from(positions), uv: uvs && Float32Array.from(uvs) };
  return {
    metadata: { meshId: id },
    getVerticesData: kind => data[kind] ?? null,
    getIndices: () => indices,
    computeWorldMatrix: () => ({ m: matrix }),
    data,
  };
}

test('revision starts at 0 and bump increments and announces it', () => {
  const seen = [];
  const off = subscribe(EVENTS.GEOMETRY_CHANGED, e => seen.push(e));
  assert.equal(revisionOf('mesh_new'), 0);
  assert.equal(bump('mesh_new'), 1);
  assert.equal(bump('mesh_new'), 2);
  assert.equal(revisionOf('mesh_new'), 2);
  assert.deepEqual(seen, [{ meshId: 'mesh_new', revision: 1 }, { meshId: 'mesh_new', revision: 2 }]);
  off?.();
});

test('bump accepts a mesh as well as an id; meshes without an id are ignored', () => {
  const m = fakeMesh({ id: 'mesh_b' });
  assert.equal(meshIdOf(m), 'mesh_b');
  assert.equal(bump(m), 1);
  assert.equal(revisionOf(m), 1);
  assert.equal(bump({ metadata: {} }), 0);
  assert.equal(meshIdOf(null), null);
});

test('extract returns owned copies with the current revision', () => {
  const m = fakeMesh({ id: 'mesh_c' });
  bump(m);
  const g = extract(m);
  assert.ok(g.positions instanceof Float32Array);
  assert.ok(g.indices instanceof Uint32Array);
  assert.deepEqual([...g.indices], [0, 1, 2]);
  assert.equal(g.revision, 1);
  g.positions[0] = 99;
  assert.equal(m.data.position[0], 0, 'source untouched');
  assert.notEqual(g.positions.buffer, m.data.position.buffer);
  assert.equal(g.uvs, undefined, 'uvs only when asked');
});

test('world space applies the world matrix to the copy only', () => {
  // scale 2, translate (10, 20, 30); Babylon row-vector layout (translation in m[12..14])
  const matrix = [2,0,0,0, 0,2,0,0, 0,0,2,0, 10,20,30,1];
  const m = fakeMesh({ id: 'mesh_d', positions: [1,1,1, 0,0,0, 1,0,0], matrix });
  const g = extract(m, { space: 'world' });
  assert.deepEqual([...g.positions.slice(0, 6)], [12, 22, 32, 10, 20, 30]);
  assert.equal(m.data.position[0], 1);
});

test('uvs are copied when asked; missing data gives empty arrays', () => {
  const m = fakeMesh({ id: 'mesh_e', uvs: [0,0, 1,0, 0,1] });
  const g = extract(m, { uvs: true });
  assert.deepEqual([...g.uvs], [0,0, 1,0, 0,1]);
  const empty = extract({ metadata: {}, getVerticesData: () => null, getIndices: () => null });
  assert.equal(empty.positions.length, 0);
  assert.equal(empty.indices.length, 0);
  assert.equal(empty.revision, 0);
});

test('non-indexed meshes get a sequential index list', () => {
  const m = fakeMesh({ id: 'mesh_f', indices: null, positions: [0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1] });
  assert.deepEqual([...extract(m).indices], [0, 1, 2, 3, 4, 5]);
});

test('GeometryStore namespace exposes the same functions', () => {
  assert.equal(GeometryStore.extract, extract);
  assert.equal(GeometryStore.bump, bump);
});

test('a project reset clears every revision (meshes are disposed there)', async () => {
  const { resetRegistry } = await import('../src/core/assets/MeshRegistry.js');
  bump('mesh_reset_a'); bump('mesh_reset_b');
  resetRegistry();
  assert.equal(revisionOf('mesh_reset_a'), 0);
  assert.equal(revisionOf('mesh_reset_b'), 0);
});
