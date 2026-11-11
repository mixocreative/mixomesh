// cia MX-03: a load says what it could not restore.
//
// A damaged `supports` record is dropped on open — correctly, it must never be
// half-applied — but the only notice was a console.warn, and the load still
// ended with a green "Loaded <project>". What is lost is not derived data: an
// ObjectSupports record carries the user's hand-placed points, the contacts
// they deleted by hand, their overrides and stamps. The next action after a
// silent drop is an export with no supports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PM, toasts, goodDoc, seedCurrentScene, sceneObject, meshAsset } from './load-harness.mjs';

// Shaped like model.ts ObjectSupports, and accepted by isSupportsRecord.
const GOOD_SUPPORTS = {
  settings: { preset: 'default' }, deleted: [], manual: [{ id: 'p1', position: [0, 0, 0] }],
  overrides: {}, stamps: { kinds: '', data: '' }, sourceHash: null, pose: null,
  placed: null, revision: 1,
};
// Damaged the way a torn write or a foreign build damages it: the record is
// still an object, so nothing throws — `manual` is simply no longer points.
const BAD_SUPPORTS = { ...GOOD_SUPPORTS, manual: [{ id: 'p1', position: [0, 0] }] };

function docWithSupports(supports, name = 'WithSupports') {
  const doc = goodDoc(name);
  doc.assetLibrary = [meshAsset('a_ok'), meshAsset('a_two')];
  doc.sceneObjects = [
    sceneObject('o_ok', 'a_ok', { name: 'Dragon', supports }),
    sceneObject('o_two', 'a_two', { name: 'Base', supports: GOOD_SUPPORTS }),
  ];
  return doc;
}

const warnings = () => toasts.filter(t => t.type === 'warning').map(t => String(t.msg));

test('a damaged supports record is reported, naming the object it came from', async () => {
  seedCurrentScene();
  await PM._loadProject(docWithSupports(BAD_SUPPORTS));
  const warned = warnings();
  assert.equal(warned.length, 1, `expected one warning toast, got: ${JSON.stringify(toasts)}`);
  assert.match(warned[0], /Dragon/, 'it names the object whose hand work was dropped');
  assert.match(warned[0], /support/i);
});

test('the intact record on the other object still restores', async () => {
  seedCurrentScene();
  await PM._loadProject(docWithSupports(BAD_SUPPORTS));
  const { getState } = await import('../src/core/StateManager.js');
  assert.equal(getState().scene.objects.o_ok.supports, undefined, 'damaged: dropped, never half-applied');
  assert.deepEqual(getState().scene.objects.o_two.supports, GOOD_SUPPORTS);
});

test('a clean load says nothing about supports', async () => {
  seedCurrentScene();
  await PM._loadProject(docWithSupports(GOOD_SUPPORTS, 'Clean'));
  assert.deepEqual(warnings(), [], `a clean load must stay quiet: ${JSON.stringify(toasts)}`);
  assert.ok(toasts.some(t => t.type === 'success'), 'and still report success');
});
