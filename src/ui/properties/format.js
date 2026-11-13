// Number formatting for the Properties panel's inputs. Pure, so it has no reason to live in a
// panel: shared by the transform rows, the UV rows and anything else that puts a number in a box.
//
// Why a default of 2 and not more: these are editable `<input type="number">` values, and showing
// a user 12.700000001 in a field they are about to retype is how a transform picks up noise on
// every round trip. Callers that need more precision ask for it (`fmt(x, 3)` for UVs).

/**
 * @param {number} n
 * @param {number} [dp] decimal places
 * @returns {string} a fixed-point string, or '0' for anything non-finite
 */
export function fmt(n, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : '0';
}
