// cia MX-03: a load says what it could not restore.
//
// A damaged `supports` record is dropped on open — correctly, it must never be
// half-applied — but the only notice was a console.warn, and the load still
// ended with a green "Loaded <project>". What is lost is not derived data: an
// ObjectSupports record carries the user's hand-placed points, the contacts
// they deleted by hand, their overrides and stamps. The next action after a
// silent drop is an export with no supports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// MX-11: `restoreSupports` deep-copies with JSON.parse(JSON.stringify(...)), and the loader used
// to call it twice per object — once for the test, once for the value — so every record was copied
// twice on open. For a record carrying `stamps.data` that doubles peak memory on the path that
// opens the biggest documents, against the standing rule to plan for the lowest peak. The MX-03
// fix hoisted it to one call; this is what keeps it there.
//
// Guarded at the SOURCE on purpose. The second call produced no observable difference — same
// deterministic input, same verdict, one warning either way — so there is nothing a behavioural
// test could assert. What there is, is a line that must stay one call.
test('MX-11: the loader reads an object\'s supports exactly once', () => {
  const src = readFileSync(new URL('../src/core/persist/ProjectLoader.js', import.meta.url), 'utf8');
  const calls = src.split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .reduce((n, line) => n + (line.match(/\brestoreSupports\s*\(/g) ?? []).length, 0);
  assert.equal(calls, 1,
    `ProjectLoader must call restoreSupports once per object (found ${calls} call sites) — a second call deep-copies the record again`);
});

test('a clean load says nothing about supports', async () => {
  seedCurrentScene();
  await PM._loadProject(docWithSupports(GOOD_SUPPORTS, 'Clean'));
  assert.deepEqual(warnings(), [], `a clean load must stay quiet: ${JSON.stringify(toasts)}`);
  assert.ok(toasts.some(t => t.type === 'success'), 'and still report success');
});
