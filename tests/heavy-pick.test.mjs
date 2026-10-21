// HeavyPick: the BVH intersects override must answer exactly like Babylon's own pick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
const { buildTriangleBvh } = await import('../src/core/geometry/triangleBvh.js');
const HP = await import('../src/core/scene/HeavyPick.js');
const { bump } = await import('../src/core/geometry/GeometryStore.js');

const engine = new BABYLON.NullEngine({ renderWidth: 200, renderHeight: 200, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
const camera = new BABYLON.ArcRotateCamera('c', 0.7, 0.6, 2.2, BABYLON.Vector3.Zero(), scene);
scene.activeCamera = camera;

function wavyGrid(n) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0, o = 0; j <= n; j++) for (let i = 0; i <= n; i++, o += 3) {
    positions[o] = i / n * 2 - 1; positions[o + 2] = j / n * 2 - 1;
    positions[o + 1] = 0.15 * Math.sin(i * 0.31) * Math.cos(j * 0.27);
  }
  const indices = new Uint32Array(n * n * 6);
  for (let j = 0, o = 0; j < n; j++) for (let i = 0; i < n; i++, o += 6) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
    indices.set([a, b, c, a, c, d], o);
  }
  return { positions, indices };
}

const { positions, indices } = wavyGrid(320);   // 204,800 triangles
const mesh = new BABYLON.Mesh('heavy', scene);
const vd = new BABYLON.VertexData();
vd.positions = positions; vd.indices = indices;
vd.normals = new Float32Array(positions.length);
BABYLON.VertexData.ComputeNormals(positions, indices, vd.normals);
vd.applyToMesh(mesh);
mesh.metadata = { meshId: 'heavy_1' };
mesh.position.set(0.3, -0.2, 0.1);
mesh.rotation.y = 0.4;
mesh.computeWorldMatrix(true);

// Reference twin: same geometry (own copies) and transform, never tracked → Babylon's default pick.
const ref = new BABYLON.Mesh('reference', scene);
const vd2 = new BABYLON.VertexData();
vd2.positions = positions.slice(); vd2.indices = indices.slice(); vd2.normals = vd.normals.slice();
vd2.applyToMesh(ref);
ref.position.copyFrom(mesh.position);
ref.rotation.copyFrom(mesh.rotation);
ref.computeWorldMatrix(true);

HP.setBvhBuilder(async (p, i) => buildTriangleBvh(p, i));

test('only pickable content meshes at or above the threshold are tracked', () => {
  const small = BABYLON.MeshBuilder.CreateBox('small', {}, scene);
  small.metadata = { meshId: 'small_1' };
  assert.equal(HP.track(small), false);
  small.dispose();
  assert.equal(HP.track(ref), false, 'no registry meshId (helper / overlay) → never tracked');
  assert.equal(HP.track(mesh), true);
  assert.equal(HP.hasFreshIndex(mesh), false, 'no index until it is built');
});

test('BVH pick = Babylon default pick: mesh, face, point, distance, barycentrics, normal', async () => {
  await HP.buildNow(mesh);
  assert.equal(HP.hasFreshIndex(mesh), true);
  let compared = 0;
  for (let y = 10; y < 200; y += 19) {
    for (let x = 10; x < 200; x += 19) {
      const ours = scene.pick(x, y, m => m === mesh);
      const theirs = scene.pick(x, y, m => m === ref);
      assert.equal(ours.hit, theirs.hit, `hit at ${x},${y}`);
      if (!ours.hit) continue;
      compared++;
      assert.equal(ours.pickedMesh, mesh);
      assert.equal(theirs.pickedMesh, ref);
      assert.equal(ours.faceId, theirs.faceId);
      assert.ok(Math.abs(ours.distance - theirs.distance) < 1e-5);
      assert.ok(ours.pickedPoint.subtract(theirs.pickedPoint).length() < 1e-5);
      assert.ok(Math.abs(ours.bu - theirs.bu) < 1e-6 && Math.abs(ours.bv - theirs.bv) < 1e-6);
      assert.ok(ours.getNormal(true).subtract(theirs.getNormal(true)).length() < 1e-5);
    }
  }
  assert.ok(compared > 50, `${compared} hits compared`);
});

test('a stale index (revision bump) answers through the flat scan, identically, until rebuilt', async () => {
  const before = scene.pick(100, 100, m => m === mesh);
  bump(mesh);
  assert.equal(HP.hasFreshIndex(mesh), false);
  const hit = scene.pick(100, 100, m => m === mesh);
  assert.equal(hit.pickedMesh, mesh, 'fallback still picks');
  assert.equal(hit.faceId, before.faceId);
  assert.ok(!mesh._positions, "Babylon's per-vertex Vector3 array is never built");
  assert.equal(HP.hasFreshIndex(mesh), false, 'the stale index and its arrays were dropped (review M7)');
  assert.equal(HP.withoutScan(() => scene.pick(100, 100, m => m === mesh)).hit, false,
    'hover-style picks skip a heavy mesh while its index rebuilds (review M8)');
  await HP.buildNow(mesh);
  assert.equal(HP.hasFreshIndex(mesh), true);
  assert.equal(HP.withoutScan(() => scene.pick(100, 100, m => m === mesh)).pickedMesh, mesh, 'with a fresh index hover picks normally');
});

test('untrack restores Babylon intersects; dispose untracks', () => {
  HP.untrack(mesh);
  assert.equal(Object.prototype.hasOwnProperty.call(mesh, 'intersects'), false);
  HP.track(mesh);
  mesh.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(mesh, 'intersects'), false);
  HP.setBvhBuilder(null);
});
