/*
 * Arity checks for the engine's flat arrays (GEO-006). One job: say no to an array that is not the
 * shape its layout declares.
 *
 * The decoders used to pad and truncate. `decodeSteps` read index by index with
 * `(k) => (k < values.length ? values[k] : 0)`, so a 19-long step array from an engine 62 build
 * decoded as `maxFillLoopMm: 0, loopsConsidered: 0, loopsFilled: 0, loopsLeftOpen: 0,
 * patchTrianglesAdded: 0` - bit for bit what a healthy run that filled nothing looks like. The
 * strided loops ran `at + STRIDE <= length`, which drops a trailing partial record in silence, so a
 * truncated body array loses its LAST body: the noise shell, or the one that is inside out.
 *
 * `loopsLeftOpen: 0` means "this mesh has no holes left". From a short array it is a false clean
 * bill of health on a mesh that is about to be printed. A mis-strided array is exactly as fatal as
 * the engine's own `INVALID_LENGTH`, and these functions throw where the host already throws the
 * engine's coded errors, so every caller has a handler.
 */

/**
 * Records in a flat engine array, refusing a remainder. `what` names the array in the message.
 *
 * @throws RangeError when `values.length` is not a whole multiple of `stride`
 */
export function records(values: ArrayLike<number>, stride: number, what: string): number {
  if (values.length % stride !== 0) {
    throw new RangeError(`${what}: ${values.length} values is not a whole number of ${stride}-value records`);
  }
  return values.length / stride;
}

/**
 * Asserts a fixed-length engine array and hands it back, so a check can wrap the value it guards.
 *
 * @throws RangeError when the length is not exactly `length`
 */
export function exact<T extends ArrayLike<number>>(values: T, length: number, what: string): T {
  if (values.length !== length) {
    throw new RangeError(`${what}: expected ${length} values, got ${values.length}`);
  }
  return values;
}
