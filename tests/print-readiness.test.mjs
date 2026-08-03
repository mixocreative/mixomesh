import assert from 'node:assert/strict';
import { buildReadiness, EXPORT_FORMATS } from '../src/core/print/PrintReadiness.js';

const bed = { x: 100, y: 100, z: 100 };
const bounds = { min: [0, 0, 0], max: [50, 50, 50] };
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

const empty = buildReadiness({ parts: [], targets: [], bedDimensions: bed });
assert.equal(empty.status, 'blocked');
assert.equal(empty.issues.find(issue => issue.code === 'no-print-parts')?.severity, 'error');

const warnings = buildReadiness({
  parts: [part({ unitConfirmed: false })],
  targets: [target(72, { min: [0, 0, -1], max: [101, 50, 50] })],
  bedDimensions: bed,
});
assert.equal(warnings.status, 'warning');
assert.equal(warnings.requiresAcknowledgement, true);
assert.equal(warnings.issues.find(issue => issue.code === 'unit-unconfirmed')?.severity, 'warning');
assert.equal(warnings.issues.find(issue => issue.code === 'bed-overflow')?.severity, 'warning');
assert.equal(warnings.issues.find(issue => issue.code === 'below-bed')?.severity, 'warning');

const missing = buildReadiness({
  parts: [part({ sourceAvailable: false }), part({ objectId: 'part_b', objectIds: ['part_b'], textureAvailable: false })],
  targets: [target(72)],
  bedDimensions: bed,
});
assert.equal(missing.status, 'blocked');
assert.equal(missing.canExport, false);
assert.equal(missing.issues.find(issue => issue.code === 'missing-source')?.severity, 'error');
assert.equal(missing.issues.find(issue => issue.code === 'missing-texture')?.severity, 'error');

const geometry = buildReadiness({
  parts: [part({ validationResults: [{ severity: 'error', message: 'zero vertices' }] })],
  targets: [target(72)],
  bedDimensions: bed,
});
assert.equal(geometry.issues.find(issue => issue.code === 'geometry-error')?.severity, 'error');

const multiple = buildReadiness({
  parts: [part()],
  targets: [target(72), target(144, { min: [0, 0, 0], max: [25, 25, 25] })],
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
