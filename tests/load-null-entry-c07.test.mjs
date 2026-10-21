// cia C-07: a .mixo whose list holds a null or non-object entry, or a broken
// transform, is refused before the world reset; the open project survives.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PM, getState, goodDoc, seedCurrentScene } from './load-harness.mjs';

async function assertRefusedAndKept(doc, label) {
  seedCurrentScene();
  await assert.rejects(PM._loadProject(doc), /\.mixo is malformed/, label);
  assert.ok(getState().scene.objects.keep, `${label}: open scene kept`);
  assert.equal(getState().project.name, 'Current', `${label}: session not renamed`);
}

test('null entry in sceneObjects or assetLibrary leaves the open project intact', async () => {
  await assertRefusedAndKept({ ...goodDoc('BadDoc'), sceneObjects: [null] }, 'sceneObjects null');
  await assertRefusedAndKept({ ...goodDoc('BadDoc'), assetLibrary: [null] }, 'assetLibrary null');
  await assertRefusedAndKept({ ...goodDoc('BadDoc'), shaders: [7] }, 'shaders number');
  await assertRefusedAndKept({ ...goodDoc('BadDoc'), groups: [{ name: 'no id' }] }, 'group without id');
});

test('a scene object with a malformed transform is refused before the reset', async () => {
  const doc = goodDoc('BadDoc');
  doc.sceneObjects[0].transform = { p: [0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  await assertRefusedAndKept(doc, 'short position');
});

test('a well-formed doc still loads, including a null transform', async () => {
  seedCurrentScene();
  const doc = goodDoc('Fine');
  doc.sceneObjects[0].transform = null;
  await PM._loadProject(doc);
  assert.equal(getState().project.name, 'Fine');
  assert.ok(getState().scene.objects.o_ok);
});
