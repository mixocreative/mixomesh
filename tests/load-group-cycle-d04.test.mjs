// cia D-04: a .mixo whose group parent links form a cycle is refused before
// the world reset; the open project and its undo history survive.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PM, getState, goodDoc, seedCurrentScene, XFORM } from './load-harness.mjs';

const group = (id, parentId) => ({ id, name: id, parentId, childIds: [], transform: XFORM });

test('a two-group parent cycle is a named validation error and the scene is untouched', async () => {
  seedCurrentScene();
  const doc = { ...goodDoc('Cyclic'), groups: [group('A', 'B'), group('B', 'A')] };
  await assert.rejects(PM._loadProject(doc), /\.mixo is malformed: .*cycle/);
  assert.ok(getState().scene.objects.keep, 'open scene kept');
  assert.equal(getState().project.name, 'Current');
});

test('a self-parented group is refused', async () => {
  seedCurrentScene();
  await assert.rejects(PM._loadProject({ ...goodDoc('Self'), groups: [group('A', 'A')] }), /\.mixo is malformed/);
  assert.ok(getState().scene.objects.keep);
});

test('nested groups and a dangling parent id still load', async () => {
  seedCurrentScene();
  const doc = { ...goodDoc('Nested'), groups: [group('child', 'root'), group('root', null), group('lost', 'gone')] };
  await PM._loadProject(doc);
  assert.deepEqual(Object.keys(getState().scene.groups).sort(), ['child', 'lost', 'root']);
});
