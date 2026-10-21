// cia W-01: "Set scale" relabels without resizing, so a save and reopen must
// show the same millimetre size; Convert after a relabel still resizes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { B, PM, AssetLoader, getState, goodDoc, makeContainer, seedCurrentScene } from './load-harness.mjs';

const { SetScaleLabelCommand, RescaleObjectCommand } = await import('../src/core/commands/ScaleCommands.js');

// A container mesh that records the uniform scale baked into its vertices.
function scaleTrackingContainer() {
  const c = makeContainer();
  const mesh = c.meshes[0];
  mesh.vertexScale = 1;
  mesh.bakeTransformIntoVertices = function (m) { this.vertexScale *= m.sx ?? 1; };
  return c;
}

async function reopen() {
  B.SceneLoader = { LoadAssetContainerAsync: async () => scaleTrackingContainer() };
  const doc = JSON.parse(JSON.stringify(await PM._buildDocument({ skipTextureImages: true })));
  await PM._loadProject(doc);
  return AssetLoader.getBabylonMesh('o_ok');
}

async function openFresh() {
  seedCurrentScene();
  B.SceneLoader = { LoadAssetContainerAsync: async () => scaleTrackingContainer() };
  await PM._loadProject(goodDoc('Kit'));
  AssetLoader.getAssetBytes = async () => new TextEncoder().encode('glb-bytes').buffer;
  return AssetLoader.getBabylonMesh('o_ok');
}

test('Set scale 1:10, save, reopen: same size, label kept', async () => {
  const before = (await openFresh()).vertexScale;
  new SetScaleLabelCommand(['o_ok'], 10).execute();
  const after = await reopen();
  assert.equal(after.vertexScale, before, 'reopened part keeps its millimetre size');
  assert.equal(getState().scene.objects.o_ok.ratio, 10, 'declared 1:10 survives');
  assert.equal(getState().scene.objects.o_ok.ratioSource, 'user');
});

test('Set scale then Convert resizes once, and the size survives reopen', async () => {
  await openFresh();
  new SetScaleLabelCommand(['o_ok'], 10).execute();
  new RescaleObjectCommand(['o_ok'], 20).execute();
  const shown = AssetLoader.getBabylonMesh('o_ok').vertexScale;
  assert.equal(shown, 0.5, 'Convert 1:10 -> 1:20 halves the part');
  const after = await reopen();
  assert.ok(Math.abs(after.vertexScale - shown) < 1e-12, `reopened ${after.vertexScale} vs shown ${shown}`);
  assert.equal(getState().scene.objects.o_ok.ratio, 20);
});

test('undoing a Set scale restores the label and a reopen keeps the size', async () => {
  const before = (await openFresh()).vertexScale;
  const cmd = new SetScaleLabelCommand(['o_ok'], 10);
  cmd.execute();
  cmd.undo();
  assert.equal(getState().scene.objects.o_ok.ratio, 1);
  assert.equal((await reopen()).vertexScale, before);
});
