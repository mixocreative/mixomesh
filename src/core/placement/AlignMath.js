// Pure align math for the placement verbs (ADR 0003, Phase B slice 1).
//
// Align translates each selected object along ONE axis so their world-AABB extents
// line up at the selection's min / center / max. This module is the pure core —
// no scene, no Babylon — so it is fully unit-testable; `AlignCommand` reads the live
// world AABBs, calls this, and applies the deltas via a transform Command.

/**
 * @typedef {Object} AlignItem
 * @property {string} id    Object id.
 * @property {number} min   World-AABB minimum along the chosen axis.
 * @property {number} max   World-AABB maximum along the chosen axis.
 */

/**
 * Compute the per-object translation delta (on one axis) to align a selection.
 *
 * - `min`: every object's low edge moves to the selection's lowest edge.
 * - `max`: every object's high edge moves to the selection's highest edge.
 * - `center`: every object's centre moves to the selection's overall centre.
 *
 * Deltas are signed scalars on the chosen axis; the caller adds each to that
 * object's position component. A single-object selection yields a 0 delta (already
 * aligned to itself). Malformed items (non-finite extent) are skipped.
 *
 * @param {AlignItem[]} items
 * @param {'min'|'center'|'max'} mode
 * @returns {Record<string, number>} id → axis delta
 */
export function computeAlignDeltas(items, mode) {
  const valid = Array.isArray(items)
    ? items.filter(it => it && Number.isFinite(it.min) && Number.isFinite(it.max))
    : [];
  if (valid.length === 0) return {};

  const lo = Math.min(...valid.map(it => it.min));
  const hi = Math.max(...valid.map(it => it.max));
  const target = mode === 'min' ? lo : mode === 'max' ? hi : (lo + hi) / 2;

  const out = {};
  for (const it of valid) {
    const edge = mode === 'min' ? it.min : mode === 'max' ? it.max : (it.min + it.max) / 2;
    out[it.id] = target - edge;
  }
  return out;
}
