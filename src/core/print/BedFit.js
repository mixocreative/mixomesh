const AXES = ['x', 'y', 'z'];

const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = value => Math.abs(value) < 1e-9 ? 0 : value;

/**
 * Compare print-space millimetre bounds with a 0..XYZ build volume.
 * X/Y are the bed plane; Z is height. Callers translate the centred Babylon
 * bed into this positive coordinate space before invoking the pure check.
 */
export function checkBedFit(bounds, bedDimensions) {
  const min = bounds?.min ?? [0, 0, 0];
  const max = bounds?.max ?? [0, 0, 0];
  const bed = AXES.map(axis => Math.max(0, finite(bedDimensions?.[axis])));
  const lowerX = Math.max(0, -finite(min[0]));
  const lowerY = Math.max(0, -finite(min[1]));
  const overflowMM = {
    x: clean(lowerX + Math.max(0, finite(max[0]) - bed[0])),
    y: clean(lowerY + Math.max(0, finite(max[1]) - bed[1])),
    z: clean(Math.max(0, finite(max[2]) - bed[2])),
  };
  const belowBedMM = clean(Math.max(0, -finite(min[2])));
  return {
    fits: belowBedMM === 0 && AXES.every(axis => overflowMM[axis] === 0),
    overflowMM,
    belowBedMM,
  };
}
