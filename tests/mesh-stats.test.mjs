// MeshStats scene-wide triangle-count caching (watertight-repair-and-cost
// task 7, fix round 1 finding 3). Run:
//   node --import ./tests/register-hooks.mjs tests/mesh-stats.test.mjs
//
// The HUD's scene-wide triangle total is a full scene.meshes walk, so it must
// be cached and re-walked ONLY on events that actually change scene geometry
// — never on SELECTION_CHANGED (fired constantly during interaction) — and a
// burst of geometry events in one tick (an N-part import) must coalesce into
// a single walk via the queueMicrotask debounce.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { StateManager, dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { MeshStats } = await import('../src/ui/MeshStats.js');

function resetState() {
  StateManager.replaceState(StateManager.freshState());
}

// Two microtask hops: one lets the debounced `queueMicrotask` callback run,
// the second is slack for anything it chains internally.
function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

// init() subscribes named module-level functions to StateManager's Set-backed
// listener lists — calling it more than once is a harmless no-op (no
// duplicate handlers), so one call for the whole file is enough.
MeshStats.init();

const scene = { meshes: [] };
SceneManager.getScene = () => scene;

/** Spy on the real scene-walk entry point without touching module internals. */
async function withCountSpy(fn) {
  const real = MeshStats.countSceneTriangles;
  let calls = 0;
  MeshStats.countSceneTriangles = (s) => { calls++; return real(s); };
  try { await fn(() => calls); }
  finally { MeshStats.countSceneTriangles = real; }
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetState();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('SELECTION_CHANGED x100 never triggers a scene-wide triangle re-walk', async () => {
  await withCountSpy(async (getCalls) => {
    for (let i = 0; i < 100; i++) dispatch(EVENTS.SELECTION_CHANGED, {});
    await flushMicrotasks();
    assert.equal(getCalls(), 0, 'SELECTION_CHANGED must never call the scene counter');
  });
});

await test('a burst of 5 ASSET_INSTANTIATED in one tick coalesces into exactly 1 recount', async () => {
  await withCountSpy(async (getCalls) => {
    for (let i = 0; i < 5; i++) dispatch(EVENTS.ASSET_INSTANTIATED, { meshId: `m${i}` });
    assert.equal(getCalls(), 0, 'the walk is deferred (microtask), never synchronous inside dispatch');
    await flushMicrotasks();
    assert.equal(getCalls(), 1, 'exactly one walk for the whole burst, not 5');
  });
});

await test('geometry events in separate ticks each get their own walk', async () => {
  await withCountSpy(async (getCalls) => {
    dispatch(EVENTS.OBJECT_REMOVED, { id: 'x' });
    await flushMicrotasks();
    dispatch(EVENTS.OBJECT_RESTORED, { id: 'x' });
    await flushMicrotasks();
    assert.equal(getCalls(), 2, 'two separate ticks → two separate walks (no under-counting)');
  });
});

await test('HISTORY_UNDONE / HISTORY_REDONE / VALIDATION_COMPLETE also queue a recount', async () => {
  await withCountSpy(async (getCalls) => {
    dispatch(EVENTS.HISTORY_UNDONE, {});
    dispatch(EVENTS.HISTORY_REDONE, {});
    dispatch(EVENTS.VALIDATION_COMPLETE, { meshId: 'm1', results: [] });
    await flushMicrotasks();
    assert.equal(getCalls(), 1, 'all three fired in one tick still coalesce into one walk');
  });
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
