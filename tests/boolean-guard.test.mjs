// A Boolean now runs in a worker while the UI stays live: guard against a
// second concurrent Boolean and against operands edited during the run.
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
console.error = () => {};
const { performBoolean } = await import('../src/core/commands/BooleanCommands.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { setState } = await import('../src/core/StateManager.js');
const { bump } = await import('../src/core/geometry/GeometryStore.js');

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function fakeMesh(id) {
  const m = {
    name: id, metadata: { meshId: id }, material: null, matrix: [...IDENTITY],
    getTotalIndices: () => 36, computeWorldMatrix() { return { m: this.matrix }; },
    setParent() {}, setEnabled() {}, parent: null,
  };
  return m;
}
const meshes = new Map([['a', fakeMesh('a')], ['b', fakeMesh('b')]]);
AssetLoader.getBabylonMesh = id => meshes.get(id) ?? null;
let registered = 0;
AssetLoader.registerBakedResult = async () => { registered++; return { assetId: 'asset_r', meshId: 'mesh_r' }; };
setState(s => ({ ...s, scene: { ...s.scene, objects: {
  a: { id: 'a', name: 'a', isGhost: false, isPrintPart: true },
  b: { id: 'b', name: 'b', isGhost: false, isPrintPart: true },
} } }), { silent: true });

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}
const resultMesh = () => ({ disposed: false, dispose() { this.disposed = true; } });

await test('a second Boolean while one runs is refused as busy', async () => {
  let finish;
  const first = performBoolean(['a', 'b'], 'union', { compute: () => new Promise(r => { finish = r; }) });
  const second = await performBoolean(['a', 'b'], 'union', { compute: async () => resultMesh() });
  assert.deepEqual(second, { blocked: true, reason: 'busy' });
  const r = resultMesh();
  bump('a');                     // make the first one stale so it does not touch the scene
  finish(r);
  assert.deepEqual(await first, { blocked: true, reason: 'changed-during-boolean' });
  assert.equal(r.disposed, true, 'stale result disposed');
});

await test('an operand edited during the run (geometry) discards the result', async () => {
  registered = 0;
  let finish;
  const p = performBoolean(['a', 'b'], 'subtract', { compute: () => new Promise(r => { finish = r; }) });
  bump('b');
  const r = resultMesh();
  finish(r);
  assert.deepEqual(await p, { blocked: true, reason: 'changed-during-boolean' });
  assert.equal(r.disposed, true);
  assert.equal(registered, 0, 'nothing registered');
});

await test('an operand moved during the run discards the result', async () => {
  let finish;
  const p = performBoolean(['a', 'b'], 'union', { compute: () => new Promise(r => { finish = r; }) });
  meshes.get('a').matrix[12] = 5;
  const r = resultMesh();
  finish(r);
  assert.deepEqual(await p, { blocked: true, reason: 'changed-during-boolean' });
  meshes.get('a').matrix[12] = 0;
});

await test('an operand deleted during the run discards the result', async () => {
  let finish;
  const p = performBoolean(['a', 'b'], 'union', { compute: () => new Promise(r => { finish = r; }) });
  const b = meshes.get('b'); meshes.delete('b');
  const r = resultMesh();
  finish(r);
  assert.deepEqual(await p, { blocked: true, reason: 'changed-during-boolean' });
  meshes.set('b', b);
});

await test('a failed compute clears the busy flag', async () => {
  await assert.rejects(performBoolean(['a', 'b'], 'union', { compute: async () => { throw new Error('open operand'); } }), /open operand/);
  let finish;
  const p = performBoolean(['a', 'b'], 'union', { compute: () => new Promise(r => { finish = r; }) });
  bump('a'); finish(resultMesh());
  assert.deepEqual(await p, { blocked: true, reason: 'changed-during-boolean' }, 'not refused as busy');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
