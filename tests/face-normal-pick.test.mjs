// Place Face on Bed takes the picked FACE normal, not the interpolated vertex normal (review I2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
const { creaseNormals } = await import('../src/core/import/weld.js');

test('on a welded mesh with a shallow bend, getNormal(true, false) is the facet normal', () => {
  const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 32 });
  const scene = new BABYLON.Scene(engine);
  // Two triangles sharing edge (0,0,0)-(0,0,1); the second is bent 20° about it.
  const a = (20 * Math.PI) / 180;
  const positions = new Float32Array([0, 0, 0, 0, 0, 1, -1, 0, 0, Math.cos(a), Math.sin(a), 0]);
  const shaded = creaseNormals(positions, new Uint32Array([0, 1, 2, 0, 3, 1]));
  assert.equal(shaded.positions.length / 3, 4, '20° stays welded (smooth normals across the edge)');
  const mesh = new BABYLON.Mesh('bent', scene);
  const vd = new BABYLON.VertexData();
  vd.positions = shaded.positions; vd.indices = shaded.indices; vd.normals = shaded.normals;
  vd.applyToMesh(mesh);
  const ray = new BABYLON.Ray(new BABYLON.Vector3(-0.3, 5, 0.3), new BABYLON.Vector3(0, -1, 0), 100);
  const pick = scene.pickWithRay(ray, m => m === mesh);
  assert.ok(pick.hit);
  const face = pick.getNormal(true, false);
  const smooth = pick.getNormal(true);
  assert.ok(Math.abs(Math.abs(face.y) - 1) < 1e-6, `facet normal is vertical: ${face}`);
  assert.ok(Math.abs(Math.abs(smooth.y) - 1) > 1e-3, 'the interpolated normal leans toward the bent neighbour');
});

test('InputManager hands the face normal to the context menu (Place Face on Bed)', () => {
  const src = readFileSync(new URL('../src/core/InputManager.js', import.meta.url), 'utf8');
  assert.match(src, /getNormal\?\.\(true, false\)/);
  assert.doesNotMatch(src, /getNormal\?\.\(true\)/);
});
