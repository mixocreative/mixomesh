import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.show = () => {};
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => {};
ProgressOverlay.open = () => ({ update() {}, close() {} });
const { StateManager } = await import('../src/core/StateManager.js');
const { importWithDedupe } = await import('../src/core/assets/AssetImport.js');
const { setCapabilities, caps } = await import('../src/core/storage/capabilities.js');
const { formatTriCount } = await import('../src/core/scene/TriangleCount.js');
const { Toast } = await import('../src/ui/Toast.js');

const stl = (n) => new Blob([Buffer.concat([...binaryStlChunks(n)])]);

test('two imports dropped together each warn with their own projected count', async (t) => {
  StateManager.replaceState(StateManager.freshState());
  const before = caps.triangleBudget;
  const show = Toast.show;
  const toasts = [];
  t.after(() => { setCapabilities({ triangleBudget: before }); Toast.show = show; });
  Toast.show = (msg, kind) => { if (kind === 'warning') toasts.push(String(msg)); };
  setCapabilities({ triangleBudget: 50 });
  B.SceneLoader = { LoadAssetContainerAsync: async () => { throw new Error('stop after the check'); } };
  const results = await Promise.allSettled([importWithDedupe(stl(4), 'a.stl'), importWithDedupe(stl(5), 'b.stl')]);
  assert.deepEqual(results.map(r => r.reason?.message), ['stop after the check', 'stop after the check']);
  assert.equal(toasts.length, 2, toasts.join('\n'));
  assert.ok(toasts.some(m => m.includes(formatTriCount(64))), `a.stl warns with 64:\n${toasts.join('\n')}`);
  assert.ok(toasts.some(m => m.includes(formatTriCount(100))), `b.stl warns with 100:\n${toasts.join('\n')}`);
});
