import assert from 'node:assert/strict';
import {
  dropToBedDelta,
  centerOnBedDelta,
  quaternionFromNormalToUp,
  rotateVector,
} from '../src/core/placement/BedPlacement.js';

assert.deepEqual(dropToBedDelta({ min: { y: -2.5 } }), { x: 0, y: 2.5, z: 0 });
assert.deepEqual(centerOnBedDelta({
  min: { x: 10, y: 2, z: -30 },
  max: { x: 30, y: 12, z: 10 },
}), { x: -20, y: 0, z: 10 });

const q = quaternionFromNormalToUp({ x: 0, y: 0, z: 1 });
const rotated = rotateVector({ x: 0, y: 0, z: 1 }, q);
assert.ok(Math.abs(rotated.x) < 1e-9);
assert.ok(Math.abs(rotated.y - 1) < 1e-9);
assert.ok(Math.abs(rotated.z) < 1e-9);

const opposite = quaternionFromNormalToUp({ x: 0, y: -1, z: 0 });
const up = rotateVector({ x: 0, y: -1, z: 0 }, opposite);
assert.ok(Math.abs(up.y - 1) < 1e-9);
