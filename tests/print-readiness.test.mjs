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
assert.deepEqual(find(sunk, 'below-bed')?.data.formats, ['obj', 'stl', 'ply', 'wrl']);
assert.deepEqual(WORLD_PLACED_FORMATS, ['obj', 'stl', 'ply', 'wrl']);

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
  ['obj', '3mf', 'stl', 'ply', 'wrl'],
  'printer identity never changes format availability',
);

// 1.15: mixed scales → one info note naming the explicit reference; never blocks.
const mixed = buildReadiness({
  parts: [part({ ratio: 35 }), part({ objectId: 'part_b', objectIds: ['part_b'], ratio: 72 })],
  targets: [target(35)],
  bedDimensions: bed,
  reference: { logicalId: 'part_b', ratio: 72 },
});
assert.equal(find(mixed, 'mixed-scales')?.severity, 'info');
assert.equal(find(mixed, 'mixed-scales')?.data.referenceId, 'part_b');
assert.deepEqual(find(mixed, 'mixed-scales')?.data.ratios, [35, 72]);
assert.equal(mixed.status, 'ready', 'info never changes status');
assert.equal(mixed.requiresAcknowledgement, false);
const same = buildReadiness({ parts: [part({ ratio: 72 }), part({ objectId: 'part_b', objectIds: ['part_b'], ratio: 72 })], targets: [target(72)], bedDimensions: bed });
assert.equal(find(same, 'mixed-scales'), undefined);

// 1.4: per-printer hints from the selected profile.
{
  const profile = {
    colour: { maxTextureSize: 4096, maxTexturesPerObject: 1 },
    validation: { requireWatertight: true, minWallMM: 1.0, minFeatureMM: 0.5 },
  };
  const tgt = (ratio, scaleToMM) => ({ ...target(ratio), scaleToMM });
  const run = (over, extra = {}) => buildReadiness({
    parts: [part(over)], targets: [tgt(1, 1000)], bedDimensions: bed, profile, ...extra,
  });

  const clean = run({ textures: [{ assetId: 'a', width: 2048, height: 2048 }], thicknessBU: 0.005, watertight: true });
  assert.equal(clean.issues.length, 0, 'within every limit: nothing raised');

  const big = run({ textures: [{ assetId: 'a', width: 8192, height: 4096 }] });
  assert.equal(find(big, 'texture-too-large')?.severity, 'warning');
  assert.equal(find(big, 'texture-too-large').data.maxTextureSize, 4096);
  assert.equal(find(big, 'texture-too-large').data.textures[0].width, 8192);
  assert.deepEqual(find(big, 'texture-too-large').objectIds, ['part_a']);

  const many = run({ textures: [{ assetId: 'a', width: 64, height: 64 }, { assetId: 'b', width: 64, height: 64 }] });
  assert.equal(find(many, 'texture-count')?.severity, 'warning');
  assert.equal(find(many, 'texture-count').data.counts.part_a, 2);
  assert.equal(find(many, 'texture-too-large'), undefined);

  // limit 0 / absent = no limit
  const unlimited = buildReadiness({
    parts: [part({ textures: [{ assetId: 'a', width: 9000, height: 9000 }, { assetId: 'b', width: 1, height: 1 }] })],
    targets: [tgt(1, 1000)], bedDimensions: bed,
    profile: { colour: { maxTextureSize: 0, maxTexturesPerObject: 0 }, validation: {} },
  });
  assert.equal(unlimited.issues.length, 0);

  // thin-feature: 0.0004 BU = 0.4 mm as shown (< 1.0 mm wall); data carries limit + actual.
  const thin = run({ thicknessBU: 0.0004 });
  const tf = find(thin, 'thin-feature');
  assert.equal(tf?.severity, 'warning');
  assert.equal(tf.data.minWallMM, 1.0);
  assert.ok(Math.abs(tf.data.thicknessMM.part_a - 0.4) < 1e-9);
  // same object printed at half scale thins further; printed at 2x it clears the limit.
  assert.ok(find(buildReadiness({ parts: [part({ thicknessBU: 0.0008 })], targets: [tgt(1, 500)], bedDimensions: bed, profile }), 'thin-feature'));
  assert.equal(find(buildReadiness({ parts: [part({ thicknessBU: 0.0008 })], targets: [tgt(1, 2000)], bedDimensions: bed, profile }), 'thin-feature'), undefined);
  assert.equal(thin.requiresAcknowledgement, true, 'warning, not a blocker');

  // watertight-required: warning normally, error under strictExport.
  const open = run({ watertight: false });
  assert.equal(find(open, 'watertight-required')?.severity, 'warning');
  assert.equal(open.canExport, true);
  const strict = run({ watertight: false }, { strictExport: true });
  assert.equal(find(strict, 'watertight-required')?.severity, 'error');
  assert.equal(strict.canExport, false);
  // unknown (null) is never "not watertight"; profile without the rule never raises it.
  assert.equal(find(run({ watertight: null }), 'watertight-required'), undefined);
  assert.equal(find(buildReadiness({ parts: [part({ watertight: false })], targets: [tgt(1, 1000)], bedDimensions: bed,
    profile: { validation: { requireWatertight: false } } }), 'watertight-required'), undefined);
}
