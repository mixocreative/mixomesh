import assert from 'node:assert/strict';
import { checkBedFit } from '../src/core/print/BedFit.js';
import { boundsForExportContext } from '../src/core/print/PrintReadiness.js';

const bed = { x: 100, y: 100, z: 100 };

assert.deepEqual(
  checkBedFit({ min: [0, 0, 0], max: [100, 100, 100] }, bed),
  { fits: true, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 0 },
);
assert.deepEqual(
  checkBedFit({ min: [0, 0, 0], max: [101, 100, 100] }, bed),
  { fits: false, overflowMM: { x: 1, y: 0, z: 0 }, belowBedMM: 0 },
);
assert.deepEqual(
  checkBedFit({ min: [-2, 0, 0], max: [100, 103, 104] }, bed),
  { fits: false, overflowMM: { x: 2, y: 3, z: 4 }, belowBedMM: 0 },
);
assert.deepEqual(
  checkBedFit({ min: [0, 0, -2.5], max: [10, 10, 10] }, bed),
  { fits: false, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 2.5 },
);

const mesh = {
  computeWorldMatrix() {},
  getBoundingInfo: () => ({ boundingBox: {
    minimumWorld: { x: -0.05, y: 0, z: -0.1 },
    maximumWorld: { x: 0.05, y: 0.3, z: 0.1 },
  } }),
};
const projected = boundsForExportContext({
  ratioFactor: 1,
  pivot: { x: 0, y: 0, z: 0 },
  units: [{ parts: [{ mesh }] }],
}, { x: 100, y: 200, z: 300 });
assert.deepEqual(projected, { min: [0, 0, 0], max: [100, 200, 300] });
