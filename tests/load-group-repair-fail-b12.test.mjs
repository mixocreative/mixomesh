// cia B-12: when the multi-part repair replay fails on open, the user is told
// and the project stops claiming the object was repaired.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PM, MeshValidator, getState, goodDoc, sceneObject, seedCurrentScene, toasts } from './load-harness.mjs';

test('a failed groupRepair replay warns and drops the repaired record from every part', async () => {
  seedCurrentScene();
  MeshValidator.repairObject = async () => { throw new Error('engine unavailable'); };
  const fixes = { geometryFixes: ['groupRepair'] };
  const doc = goodDoc('Grouped');
  doc.sceneObjects = [
    sceneObject('lead', 'a_ok', { ...fixes, logicalObjectId: 'lead' }),
    sceneObject('part', 'a_ok', { ...fixes, logicalObjectId: 'lead', isInternalPart: true }),
  ];
  await PM._loadProject(doc);
  const objects = getState().scene.objects;
  assert.ok(toasts.some(t => t.type === 'warning'), 'user is warned');
  for (const id of ['lead', 'part']) {
    assert.ok(!(objects[id].geometryFixes ?? []).includes('groupRepair'), `${id} no longer claims groupRepair`);
  }
});
