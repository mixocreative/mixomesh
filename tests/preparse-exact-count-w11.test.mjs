import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};
const { StateManager } = await import('../src/core/StateManager.js');
const { importWithDedupe } = await import('../src/core/assets/AssetImport.js');
const { setCapabilities, caps } = await import('../src/core/storage/capabilities.js');
const { HEAD_BYTES } = await import('../src/core/import/TriangleEstimate.js');
const { Toast } = await import('../src/ui/Toast.js');

/** OBJ whose first MiB is mostly vertices: the head sample says ~10k faces, the file holds ~136k. */
function unevenObj() {
  const faces = 'f 1 2 3\n'.repeat(5000);
  const vertex = 'v 0 0 0\n';
  const head = faces + vertex.repeat(Math.floor((HEAD_BYTES - faces.length) / vertex.length));
  const tail = 'f 1 2 3\n'.repeat(Math.floor(HEAD_BYTES / 8));
  return new Blob([head, tail]);
}

test('an OBJ whose sample under-reads it is refused before parsing, with no "continuing" warning', async (t) => {
  StateManager.replaceState(StateManager.freshState());
  const before = caps.triangleBudget;
  const show = Toast.show;
  const warnings = [];
  t.after(() => { setCapabilities({ triangleBudget: before }); Toast.show = show; });
  Toast.show = (msg, kind) => { if (kind === 'warning') warnings.push(msg); };
  setCapabilities({ triangleBudget: 2000 });
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; throw new Error('parsed'); } };
  await assert.rejects(importWithDedupe(unevenObj(), 'dense.obj'), (err) => err.code === 'over-budget' && /136,072 triangles/.test(err.message));
  assert.equal(loads, 0, 'refused before the loader ran');
  assert.deepEqual(warnings, []);
});

test('the exact count reads ASCII STL facets and OBJ n-gons across stream chunks', async () => {
  const { countFileTriangles } = await import('../src/core/import/TriangleEstimate.js');
  const facet = 'facet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n  vertex 0 1 0\n endloop\nendfacet\n';
  const stl = new Blob(['solid x\n', facet.repeat(20000), 'endsolid x\n']);
  assert.deepEqual(await countFileTriangles(stl, '.stl'), { triangles: 20000, confidence: 'exact' });
  const obj = new Blob(['v 0 0 0\n'.repeat(4), 'f 1 2 3 4\n'.repeat(70000)]);
  assert.deepEqual(await countFileTriangles(obj, '.obj'), { triangles: 140000, confidence: 'exact' });
  assert.equal(await countFileTriangles(new Blob([new Uint8Array(184)]), '.stl'), null, 'binary STL has no text to count');
});
