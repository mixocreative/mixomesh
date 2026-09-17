const AXES = ['x', 'y', 'z'];

const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = value => Math.abs(value) < 1e-9 ? 0 : value;
/** A bed axis that is unset / null / non-positive (e.g. the "custom" printer) is unlimited. */
const limit = value => (finite(value) > 0 ? finite(value) : Infinity);

/**
 * Compare print-space millimetre bounds with the printer's build volume.
 *
 * `bounds` are PrintSpace world bounds (right-handed, Z-up, mm — see
 * PrintSpace.toPrintSpace) BEFORE any writer placement. The check mirrors
 * what the 3MF writer ships (ThreeMFWriter._convertVertices): the build is
 * centred on the bed in X/Y and rested on it (min z → 0), so only the
 * footprint EXTENT is compared with the bed X/Y and the HEIGHT with bed Z.
 * Where the part sits in the scene never affects `overflowMM` / `fits`.
 *
 * `belowBedMM` (how far min z dips under the plate in world placement) is
 * reported separately for the formats that keep world placement — OBJ and
 * STL — and is NOT folded into `fits`; PrintReadiness decides who cares.
 */
export function checkBedFit(bounds, bedDimensions) {
  const min = bounds?.min ?? [0, 0, 0];
  const max = bounds?.max ?? [0, 0, 0];
  const size = AXES.map((_, i) => Math.max(0, finite(max[i]) - finite(min[i])));
  const bed = AXES.map(axis => limit(bedDimensions?.[axis]));
  const overflowMM = {
    x: clean(Math.max(0, size[0] - bed[0])),
    y: clean(Math.max(0, size[1] - bed[1])),
    z: clean(Math.max(0, size[2] - bed[2])),
  };
  const belowBedMM = clean(Math.max(0, -finite(min[2])));
  return {
    fits: AXES.every(axis => overflowMM[axis] === 0),
    overflowMM,
    belowBedMM,
    sizeMM: { x: clean(size[0]), y: clean(size[1]), z: clean(size[2]) },
  };
}
