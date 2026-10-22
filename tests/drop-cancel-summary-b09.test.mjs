// B-09: cancelling a multi-file drop still tells the user which files failed
// and which were imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
let cancelImport = null;
ProgressOverlay.open = (_title, opts) => { cancelImport = opts?.onCancel ?? null; return { update() {}, close() {} }; };
const { StateManager } = await import('../src/core/StateManager.js');
const { Modal } = await import('../src/ui/Modal.js');
const { Toast } = await import('../src/ui/Toast.js');
const { setCapabilities, caps } = await import('../src/core/storage/capabilities.js');
const { ViewportDrop } = await import('../src/ui/ViewportDrop.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stl = (n, name) => new File([Buffer.concat([...binaryStlChunks(n)])], name);

function dropTarget() {
  const listeners = {};
  const el = {
    classList: { add() {}, remove() {} },
    querySelector: () => null,
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const scene = {
    getEngine: () => ({ getRenderingCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) }),
    createPickingRay: () => ({ origin: { y: 1, add: () => new B.Vector3(0, 0, 0) }, direction: { y: -1, scale: () => ({}) } }),
    getMeshByName: () => null,
  };
  ViewportDrop.attach(el, scene);
  return (files) => listeners.drop({ dataTransfer: { types: ['Files'], files, getData: () => '' }, preventDefault() {}, clientX: 0, clientY: 0 });
}

test('Cancel mid-drop still reports the file that already failed', async (t) => {
  StateManager.replaceState(StateManager.freshState());
  const before = { triangleBudget: caps.triangleBudget, triangleLimit: caps.triangleLimit };
  const open = Modal.open, show = Toast.show;
  const reports = [];
  const toasts = [];
  t.after(() => { setCapabilities(before); Modal.open = open; Toast.show = show; });
  Modal.open = (id, data) => reports.push({ id, ...data });
  Toast.show = (msg, kind) => { toasts.push([String(msg), kind]); return ''; };
  setCapabilities({ triangleBudget: 10, triangleLimit: 40 });   // 64 triangles refuse, 4 pass
  let started = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { started++; await sleep(300); return { meshes: [], dispose() {} }; } };
  const drop = dropTarget();
  drop([stl(4, 'big.stl'), stl(1, 'slow.stl'), stl(1, 'never.stl')]);
  for (let i = 0; i < 100 && !started; i++) await sleep(10);
  assert.equal(started, 1, 'slow.stl reached the loader');
  cancelImport();
  for (let i = 0; i < 100 && !reports.length; i++) await sleep(10);
  assert.equal(started, 1, 'never.stl was not imported');
  assert.equal(reports.length, 1, `one summary; toasts: ${JSON.stringify(toasts)}`);
  assert.match(reports[0].message, /big\.stl/);
  assert.equal(toasts.some(([, kind]) => kind === 'success'), false, 'no "imported all"');
});
