import assert from 'node:assert/strict';
import { buildReadiness, EXPORT_FORMATS, WORLD_PLACED_FORMATS } from '../src/core/print/PrintReadiness.js';

// Bounds are PrintSpace world mm (right-handed, Z-up) BEFORE writer placement.
const bed = { x: 300, y: 300, z: 250 };
const bounds = { min: [-50, -10, 0], max: [50, 10, 30] };   // 100×20×30 mm on the floor
const part = (over = {}) => ({
  objectId: 'part_a',
  objectIds: ['part_a'],
  sourceAvailable: true,
  unitConfirmed: true,
  textureAvailable: true,
  validationResults: [],
  ...over,
});
const target = (ratio, targetBounds = bounds) => ({ ratio, label: `1:${ratio}`, bounds: targetBounds, objectIds: ['part_a'] });
const find = (readiness, code) => readiness.issues.find(issue => issue.code === code);

const empty = buildReadiness({ parts: [], targets: [], bedDimensions: bed });
assert.equal(empty.status, 'blocked');
assert.equal(find(empty, 'no-print-parts')?.severity, 'error');

// 100×20×30 mm part on a 300×300 bed: ready, no bed issues.
const ready = buildReadiness({ parts: [part()], targets: [target(1)], bedDimensions: bed });
assert.equal(ready.status, 'ready');
assert.equal(find(ready, 'bed-overflow'), undefined);
assert.equal(find(ready, 'below-bed'), undefined);
assert.deepEqual(ready.targets[0].fit.sizeMM, { x: 100, y: 20, z: 30 });

// 400 mm-wide part overflows the 300 mm bed by 100 mm in X.
const wide = buildReadiness({
  parts: [part()],
  targets: [target(1, { min: [-200, -10, 0], max: [200, 10, 30] })],
  bedDimensions: bed,
});
assert.equal(wide.status, 'warning');
assert.equal(wide.requiresAcknowledgement, true);
assert.deepEqual(find(wide, 'bed-overflow')?.data.overflowMM, { x: 100, y: 0, z: 0 });
assert.deepEqual(find(wide, 'bed-overflow')?.objectIds, ['part_a']);
assert.equal(find(wide, 'below-bed'), undefined);

// Same 400 mm part pushed far off-centre in the scene: still exactly one
// overflow of 100 mm — the 3MF writer re-centres the build on the bed.
const offCentre = buildReadiness({
  parts: [part()],
  targets: [target(1, { min: [800, 800, 0], max: [1200, 820, 30] })],
  bedDimensions: bed,
});
assert.deepEqual(find(offCentre, 'bed-overflow')?.data.overflowMM, { x: 100, y: 0, z: 0 });

// Part sitting 5 mm under the floor (print-space min z = -5): fits when seated
// (3MF), but OBJ/STL keep world placement → below-bed names those formats.
const sunk = buildReadiness({
  parts: [part()],
  targets: [target(1, { min: [-50, -10, -5], max: [50, 10, 25] })],
  bedDimensions: bed,
});
assert.equal(sunk.status, 'warning');
assert.equal(find(sunk, 'bed-overflow'), undefined, '3MF seats the build: no overflow');
assert.equal(sunk.targets[0].fit.fits, true);
assert.equal(find(sunk, 'below-bed')?.severity, 'warning');
assert.equal(find(sunk, 'below-bed')?.data.belowBedMM, 5);
assert.deepEqual(find(sunk, 'below-bed')?.data.formats, ['obj', 'stl']);
assert.deepEqual(WORLD_PLACED_FORMATS, ['obj', 'stl']);

// Height is checked against bed Z when configured, and ignored when not.
const tall = { min: [0, 0, 0], max: [10, 10, 260] };
assert.deepEqual(
  find(buildReadiness({ parts: [part()], targets: [target(1, tall)], bedDimensions: bed }), 'bed-overflow')?.data.overflowMM,
  { x: 0, y: 0, z: 10 },
);
assert.equal(
  find(buildReadiness({ parts: [part()], targets: [target(1, tall)], bedDimensions: { x: 300, y: 300, z: null } }), 'bed-overflow'),
  undefined,
  'custom printer with no Z limit only checks X/Y',
);

// Combined warnings still acknowledge, never block.
const warnings = buildReadiness({
  parts: [part({ unitConfirmed: false })],
  targets: [target(72, { min: [-200, -10, -1], max: [200, 10, 29] })],
  bedDimensions: bed,
});
assert.equal(warnings.status, 'warning');
assert.equal(warnings.requiresAcknowledgement, true);
assert.equal(find(warnings, 'unit-unconfirmed')?.severity, 'warning');
assert.equal(find(warnings, 'bed-overflow')?.severity, 'warning');
assert.equal(find(warnings, 'below-bed')?.severity, 'warning');
assert.equal(find(warnings, 'bed-overflow')?.data.targetRatio, 72);

const missing = buildReadiness({
  parts: [part({ sourceAvailable: false }), part({ objectId: 'part_b', objectIds: ['part_b'], textureAvailable: false })],
  targets: [target(72)],
  bedDimensions: bed,
});
assert.equal(missing.status, 'blocked');
assert.equal(missing.canExport, false);
assert.equal(find(missing, 'missing-source')?.severity, 'error');
assert.equal(find(missing, 'missing-texture')?.severity, 'error');

const geometry = buildReadiness({
  parts: [part({ validationResults: [{ severity: 'error', message: 'zero vertices' }] })],
  targets: [target(72)],
  bedDimensions: bed,
});
assert.equal(find(geometry, 'geometry-error')?.severity, 'error');

const multiple = buildReadiness({
  parts: [part()],
  targets: [target(72), target(144, { min: [-25, -5, 0], max: [25, 5, 15] })],
  bedDimensions: bed,
});
assert.equal(multiple.targets.length, 2);
assert.equal(multiple.targets.every(item => item.fit.fits), true);
assert.deepEqual(multiple.formats, EXPORT_FORMATS);
assert.deepEqual(
  buildReadiness({ parts: [part()], targets: [target(72)], bedDimensions: bed, printerId: 'anything' }).formats,
  ['obj', '3mf', 'stl'],
  'printer identity never changes format availability',
);
