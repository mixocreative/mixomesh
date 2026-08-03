import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSliceConnectorOptions,
  planSliceConnector,
  projectPointToPlane,
} from '../src/core/SliceConnectorService.js';

const bounds = {
  min: { x: -0.05, y: -0.02, z: -0.03 },
  max: { x: 0.05, y: 0.08, z: 0.07 },
};

test('camera normal defines the initial cut plane and peg direction', () => {
  const plan = planSliceConnector(bounds, {
    cameraNormal: { x: 0, y: 0, z: -1 },
    connectorPoint: { x: 0.01, y: 0.02, z: 0.005 },
    maleSide: 'front',
    depthMM: 10,
  });

  assert.deepEqual(plan.planeNormal, { x: 0, y: 0, z: -1 });
  assert.deepEqual(plan.pegDirection, { x: 0, y: 0, z: -1 });
  assert.equal(plan.connectorPoint.x, 0.01);
  assert.equal(plan.connectorPoint.y, 0.02);
  assert(Math.abs(plan.connectorPoint.z - 0.02) < 1e-12);
  assert.equal(plan.connectorCenter.z, 0.015500000000000003);
});

test('drag offset moves the camera-aligned cut plane along its normal', () => {
  const plan = planSliceConnector(bounds, {
    cameraNormal: { x: 1, y: 0, z: 0 },
    planeOffsetMM: 25,
  });

  assert.equal(plan.planeCenter.x, 0.025);
  assert.equal(plan.planeCenter.y, 0.03);
  assert(Math.abs(plan.planeCenter.z - 0.02) < 1e-12);
});

test('connector point is projected onto the cut plane', () => {
  const projected = projectPointToPlane(
    { x: 3, y: 4, z: 10 },
    { x: 0, y: 0, z: 2 },
    { x: 0, y: 0, z: 1 },
  );

  assert.deepEqual(projected, { x: 3, y: 4, z: 2 });
});

test('normalization rejects invalid sizes but keeps clearance non-negative', () => {
  const opts = normalizeSliceConnectorOptions({
    diameterMM: -1,
    depthMM: 0,
    clearanceMM: -5,
  });

  assert.equal(opts.diameterMM, 6);
  assert.equal(opts.depthMM, 8);
  assert.equal(opts.clearanceMM, 0.2);
});
