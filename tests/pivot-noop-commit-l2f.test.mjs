// L2-08: a click on the selection's gizmo (press and release, no drag) put a
// "Transform" step on the undo stack that changed nothing. A gizmo or body
// drag that ends where it started commits nothing.
//   node --import ./tests/register-hooks.mjs --test tests/pivot-noop-commit-l2f.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const real = await import('@babylonjs/core');
let gizmos = null;
const BABYLON = {
  ...real,
  GizmoManager: class extends real.GizmoManager {
    constructor(...args) { super(...args); gizmos = this; }
  },
};
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
const Pivot = await import('../src/core/scene/PivotSession.js');

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
Pivot.initPivotSession(scene, { getCursorPosition: () => BABYLON.Vector3.Zero() });
Pivot.setGizmoMode('translate');

const commits = [];
Pivot.setTransformCommitHandler(c => commits.push(c));
const mesh = BABYLON.MeshBuilder.CreateBox('b', { size: 1 }, scene);
mesh.metadata = { meshId: 'b' };
Pivot.attachToSelection([mesh], 'median', mesh);

test('a gizmo press and release without movement commits nothing', () => {
  commits.length = 0;
  const g = gizmos.gizmos.positionGizmo;
  g.onDragStartObservable.notifyObservers({});
  g.onDragEndObservable.notifyObservers({});
  assert.equal(commits.length, 0);
});

test('a gizmo drag that moves the selection commits once', () => {
  commits.length = 0;
  const g = gizmos.gizmos.positionGizmo;
  g.onDragStartObservable.notifyObservers({});
  Pivot.getPivotNode().position.x += 0.01;
  g.onDragEndObservable.notifyObservers({});
  assert.equal(commits.length, 1);
});

test('a body drag that ends where it started commits nothing', () => {
  commits.length = 0;
  assert.ok(Pivot.beginBodyDrag());
  Pivot.endBodyDrag();
  assert.equal(commits.length, 0);
});
