import assert from 'node:assert/strict';
import { checkBedFit } from '../src/core/print/BedFit.js';
import { boundsForExportContext } from '../src/core/print/PrintReadiness.js';
// ExportContext.js pulls StateManager (needs `location`) so it can't load headless;
// pin the constant it exports (BU_TO_MM = 1000) here.
const BU_TO_MM = 1000;

const bed = { x: 300, y: 300, z: 250 };

// A 100×20×30 mm part fits a 300×300 bed wherever it sits in the scene:
// the writer centres it in X/Y and rests it on the plate.
assert.deepEqual(
  checkBedFit({ min: [-50, -10, 0], max: [50, 10, 30] }, bed),
  { fits: true, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 0, sizeMM: { x: 100, y: 20, z: 30 } },
);
assert.deepEqual(
  checkBedFit({ min: [400, 900, 0], max: [500, 920, 30] }, bed),
  { fits: true, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 0, sizeMM: { x: 100, y: 20, z: 30 } },
  'off-centre scene placement is not an overflow — the build is re-centred on export',
);

// A 400 mm-wide part overflows a 300 mm bed by 100 mm in X.
assert.deepEqual(
  checkBedFit({ min: [-200, -10, 0], max: [200, 10, 30] }, bed),
  { fits: false, overflowMM: { x: 100, y: 0, z: 0 }, belowBedMM: 0, sizeMM: { x: 400, y: 20, z: 30 } },
);
// Y and Z limits are checked the same way (height vs bed Z, seated at z=0).
assert.deepEqual(
  checkBedFit({ min: [0, 0, 100], max: [100, 303, 354] }, bed),
  { fits: false, overflowMM: { x: 0, y: 3, z: 4 }, belowBedMM: 0, sizeMM: { x: 100, y: 303, z: 254 } },
);

// Sitting 2.5 mm under the plate: seated fit is fine, belowBedMM is reported separately.
assert.deepEqual(
  checkBedFit({ min: [0, 0, -2.5], max: [10, 10, 10] }, bed),
  { fits: true, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 2.5, sizeMM: { x: 10, y: 10, z: 12.5 } },
);

// An unconfigured axis (the "custom" printer ships null) is unlimited.
assert.deepEqual(
  checkBedFit({ min: [0, 0, 0], max: [100, 100, 900] }, { x: 300, y: 300, z: null }),
  { fits: true, overflowMM: { x: 0, y: 0, z: 0 }, belowBedMM: 0, sizeMM: { x: 100, y: 100, z: 900 } },
);

// boundsForExportContext: Babylon (left-handed, Y-up, BU) → PrintSpace mm via
// toPrintSpace(x, y, z) = (-x, -z, y), scaled with ctx.unitFactor.
const meshWith = (lo, hi) => ({
  computeWorldMatrix() {},
  getBoundingInfo: () => ({ boundingBox: { minimumWorld: lo, maximumWorld: hi } }),
});
const ctx = (mesh, over = {}) => ({
  ratioFactor: 1,
  pivot: { x: 0, y: 0, z: 0 },
  unitFactor: BU_TO_MM,
  units: [{ parts: [{ mesh }] }],
  ...over,
});

// 100 mm wide (x), 30 mm tall (y), 20 mm deep (z), resting on the floor.
const part = meshWith({ x: -0.05, y: 0, z: -0.01 }, { x: 0.05, y: 0.03, z: 0.01 });
assert.deepEqual(boundsForExportContext(ctx(part)), { min: [-50, -10, 0], max: [50, 10, 30] });

// Sitting 5 mm under the floor in Babylon (y = -0.005) → print-space min z = -5.
const sunk = meshWith({ x: -0.05, y: -0.005, z: -0.01 }, { x: 0.05, y: 0.025, z: 0.01 });
assert.deepEqual(boundsForExportContext(ctx(sunk)), { min: [-50, -10, -5], max: [50, 10, 25] });

// Ratio scaling happens about the pivot; a 2× factor doubles extents around it.
const scaled = boundsForExportContext(ctx(part, { ratioFactor: 2, pivot: { x: 0.05, y: 0, z: 0 } }));
const round = list => list.map(v => Math.round(v * 1e6) / 1e6);   // float noise from the pivot offset
assert.deepEqual({ min: round(scaled.min), max: round(scaled.max) }, { min: [-50, -20, 0], max: [150, 20, 60] });

// Off-axis placement survives the sign flips: Babylon x∈[0.1,0.2] → print x∈[-200,-100],
// Babylon z∈[0.3,0.4] → print y∈[-400,-300].
const offset = meshWith({ x: 0.1, y: 0, z: 0.3 }, { x: 0.2, y: 0.01, z: 0.4 });
assert.deepEqual(boundsForExportContext(ctx(offset)), { min: [-200, -400, 0], max: [-100, -300, 10] });

// Union over several parts.
const two = boundsForExportContext(ctx(part, { units: [{ parts: [{ mesh: part }, { mesh: offset }] }] }));
assert.deepEqual(two, { min: [-200, -400, 0], max: [50, 10, 30] });

// Contract guards.
assert.equal(boundsForExportContext({ ratioFactor: 0, pivot: { x: 0, y: 0, z: 0 }, unitFactor: BU_TO_MM }), null);
assert.equal(boundsForExportContext(ctx(meshWith(null, null))), null, 'no bounding box → nothing to measure');
assert.throws(() => boundsForExportContext(ctx(part, { unitFactor: undefined })), TypeError);
