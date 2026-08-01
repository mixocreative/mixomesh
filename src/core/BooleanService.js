// Interactive Boolean engine for pre-slice kitbashing (ADR 0002).
//
// This slice ships the PURE eligibility + size gating that fronts every Boolean
// (union / subtract / intersect). The CSG2/Manifold compute wrapper + the
// BooleanCommand + synthetic-asset persistence land in the next slice (they need
// a live Babylon CSG2 and are covered by the browser smoke).
//
// Design (ADR 0002): Boolean is SOLID-COLOUR only — Babylon's CSG2 (Manifold)
// drops UVs, so textured operands must be consciously baked to solid colour
// (a modal the caller drives on the `needs-texture-bake` result), never silently.
// Multi-part logical objects are refused (same guard as SmartReplace). Heavy
// operations are capped so a browser tab's memory isn't blown (a desktop build
// raises the cap — ADR 0001 capabilities).

/**
 * Default summed-triangle ceiling for a Boolean on the web build. Chosen below
 * the existing heavy-op thresholds (100k auto-validate skip, 500k thumbnail
 * skip) because CSG2/Manifold is worst-case super-linear and re-uploads the
 * result to the GPU. A desktop build passes a larger cap.
 */
export const DEFAULT_BOOLEAN_TRIANGLE_CAP = 50_000;

/**
 * @typedef {Object} BooleanOperand
 * @property {string} id           SceneObject id.
 * @property {number} triangles    Triangle count of this operand's mesh.
 * @property {boolean} solidColor   True when the material has no base/diffuse texture.
 * @property {number} [partCount]  Logical-object part count (>1 ⇒ multi-part, refused).
 */

/**
 * @typedef {Object} BooleanEligibility
 * @property {boolean} ok            False ⇒ a hard block; true ⇒ proceed (possibly after a bake).
 * @property {'needs-two'|'multi-part'|'too-large'|'needs-texture-bake'|'ready'} reason
 * @property {string} [offender]     Offending operand id (multi-part).
 * @property {string[]} [texturedIds] Operands needing a bake-to-solid (needs-texture-bake).
 * @property {number} [totalTriangles]
 * @property {number} [triangleCap]
 */

/**
 * Decide whether a set of operands can be combined, WITHOUT touching the scene
 * or CSG2 — pure, so it is fully unit-testable and drives the UI gating. The
 * caller builds operand descriptors from the live meshes/state.
 *
 * Order matters: hard blocks first (too-few, multi-part, over-cap), then the
 * soft texture gate (ok:true but the caller must confirm a bake-to-solid).
 *
 * @param {BooleanOperand[]} operands
 * @param {{ triangleCap?: number }} [opts]
 * @returns {BooleanEligibility}
 */
export function evaluateBooleanEligibility(operands, opts = {}) {
  const triangleCap = Number.isFinite(opts.triangleCap) ? opts.triangleCap : DEFAULT_BOOLEAN_TRIANGLE_CAP;

  if (!Array.isArray(operands) || operands.length < 2) {
    return { ok: false, reason: 'needs-two' };
  }

  const multiPart = operands.find(o => (o.partCount ?? 1) > 1);
  if (multiPart) {
    return { ok: false, reason: 'multi-part', offender: multiPart.id };
  }

  const totalTriangles = operands.reduce((sum, o) => sum + (Number(o.triangles) || 0), 0);
  if (triangleCap > 0 && totalTriangles > triangleCap) {
    return { ok: false, reason: 'too-large', totalTriangles, triangleCap };
  }

  const texturedIds = operands.filter(o => !o.solidColor).map(o => o.id);
  if (texturedIds.length) {
    return { ok: true, reason: 'needs-texture-bake', texturedIds, totalTriangles };
  }

  return { ok: true, reason: 'ready', totalTriangles };
}
