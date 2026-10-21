// cia W-06: an opened project is validated like an import, so print readiness
// does not wait forever for a validation that never runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PM, MeshValidator, goodDoc, meshAsset, sceneObject, seedCurrentScene } from './load-harness.mjs';

const { isDirty } = await import('../src/core/persist/DirtyTracker.js');

test('opening a project validates each logical object once, without dirtying it', async () => {
  seedCurrentScene();
  const validated = [];
  MeshValidator.shouldAutoValidate = () => true;
  MeshValidator.validateMesh = async (mesh) => { validated.push(mesh.metadata?.meshId ?? mesh.name); return []; };
  const doc = goodDoc('Validate me');
  doc.assetLibrary = [meshAsset('a_ok'), meshAsset('a_two'), meshAsset('a_three')];
  doc.sceneObjects = [
    sceneObject('lead', 'a_ok', { logicalObjectId: 'lead' }),
    sceneObject('part', 'a_ok', { logicalObjectId: 'lead', isInternalPart: true }),
    sceneObject('solo', 'a_two'),
    sceneObject('helper', 'a_three', { isPrintPart: false }),
  ];
  await PM._loadProject(doc);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(validated.sort(), ['lead', 'solo']);
  assert.equal(isDirty(), false, 'load stays clean');
});

test('a mesh over the auto-validate budget is not validated on open', async () => {
  seedCurrentScene();
  const validated = [];
  MeshValidator.shouldAutoValidate = () => false;
  MeshValidator.validateMesh = async (mesh) => { validated.push(mesh.name); return []; };
  await PM._loadProject(goodDoc('Heavy'));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(validated, []);
});
