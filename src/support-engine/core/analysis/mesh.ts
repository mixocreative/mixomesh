/** Converts a zero-based index to A..Z, AA..AZ, and so on. */
export function labelForIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('index must be a non-negative integer');
  }

  let remainder = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (remainder % 26)) + label;
    remainder = Math.floor(remainder / 26) - 1;
  } while (remainder >= 0);

  return label;
}
