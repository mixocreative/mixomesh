// OBJ cannot express a clamped texture (an MTL `-clamp on` breaks trimesh), so
// readiness names the parts whose clamped texture is sampled past its edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { Texture } = await import('@babylonjs/core/Materials/Textures/texture.js');
const { clampedUVsLeaveUnitSquare } = await import('../src/core/print/UvTransform.js');
const { buildReadiness } = await import('../src/core/print/PrintReadiness.js');

function babylonTexture(over) {
  const t = Object.create(Texture.prototype);
  Object.assign(t, {
    name: 'paint', metadata: { mixoAssetId: 'tex' },
    uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0, vAng: 0, wAng: 0,
    uRotationCenter: 0.5, vRotationCenter: 0.5, wRotationCenter: 0.5,
    homogeneousRotationInUVTransform: false, wrapU: 1, wrapV: 1,
  }, over);
  return t;
}

const mesh = (uvs, textureOver) => ({
  material: textureOver == null ? null : { diffuseTexture: babylonTexture(textureOver) },
  getVerticesData: (k) => (k === 'uv' ? new Float32Array(uvs) : null),
});

test('clampedUVsLeaveUnitSquare: clamp on an axis whose exported UVs leave [0,1]', () => {
  const inside = [0, 0, 1, 0, 0, 1];
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, { wrapU: 0, wrapV: 0 })), false, 'clamped but inside');
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, { wrapU: 0, wrapV: 0, uOffset: 0.25 })), true, 'offset pushes u past 1');
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, { uOffset: 0.25 })), false, 'repeat: nothing to lose');
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, { wrapU: 0, vOffset: 0.25 })), false, 'v leaves, but only u is clamped');
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, { wrapV: 0, vOffset: 0.25 })), true);
  assert.equal(clampedUVsLeaveUnitSquare(mesh([-0.5, 0, 1.5, 0, 0, 1], { wrapU: 0 })), true, 'raw UVs outside');
  assert.equal(clampedUVsLeaveUnitSquare(mesh(inside, null)), false, 'no texture');
});

test('readiness: an info hint naming OBJ, never a gate', () => {
  const part = (over) => ({
    objectId: 'p', objectIds: ['p'], sourceAvailable: true, unitConfirmed: true, textureAvailable: true,
    validationResults: [], ...over,
  });
  const hinted = buildReadiness({ parts: [part({ clampedTextureOverflow: true })], targets: [], bedDimensions: { x: 300, y: 300, z: 250 } });
  const hint = hinted.issues.find(i => i.code === 'texture-clamp-obj');
  assert.equal(hint?.severity, 'info');
  assert.deepEqual(hint.objectIds, ['p']);
  assert.deepEqual(hint.data.formats, ['obj']);
  assert.equal(hinted.status, 'ready');
  assert.equal(hinted.requiresAcknowledgement, false);
  const plain = buildReadiness({ parts: [part({ clampedTextureOverflow: false })], targets: [], bedDimensions: { x: 300, y: 300, z: 250 } });
  assert.equal(plain.issues.some(i => i.code === 'texture-clamp-obj'), false);
});
