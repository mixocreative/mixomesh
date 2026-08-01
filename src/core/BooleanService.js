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

// ── CSG2 compute (main-thread; browser-only — exercised by the Slice-2 smoke) ──
//
// CSG2/Manifold init is one-time per session, cached (mirrors PrintPipeline._ensureCSG2).
// window.BABYLON is only touched at call time, so importing this module stays headless-safe.

let _csgInit = null;

async function _ensureCsg2() {
  const B = window.BABYLON;
  if (!B?.InitializeCSG2Async || !B?.CSG2) throw new Error('CSG2 unavailable in this runtime');
  if (!_csgInit) {
    _csgInit = B.InitializeCSG2Async().catch(err => { _csgInit = null; throw err; });
  }
  await _csgInit;
}

/**
 * Compute a Boolean of the operand meshes on the main thread (CSG2/Manifold).
 * Operands combine in WORLD space (`FromMesh` uses each mesh's world matrix), so the
 * result is world-space geometry — the caller serialises it (GeometryCodec) into a
 * synthetic `.mxvd` asset that restores 1:1 (ADR 0002). CSG2 API (verified in
 * `@babylonjs/core/Meshes/csg2.d.ts`): union = `add`, `subtract`, `intersect`.
 * Boolean is SOLID-COLOUR only (CSG2 drops UVs) — the result takes the first operand's
 * diffuse colour, else the scene default (resin grey).
 *
 * @param {'union'|'subtract'|'intersect'} op  Subtract base = meshes[0].
 * @param {import('@babylonjs/core').Mesh[]} meshes  ≥2, in application order.
 * @param {{ name?: string }} [opts]
 * @returns {Promise<import('@babylonjs/core').Mesh>} new world-space result mesh
 */
export async function computeBoolean(op, meshes, opts = {}) {
  const B = window.BABYLON;
  if (!Array.isArray(meshes) || meshes.length < 2) throw new Error('computeBoolean: need ≥2 meshes');
  if (!['union', 'subtract', 'intersect'].includes(op)) throw new Error(`computeBoolean: bad op ${op}`);
  await _ensureCsg2();

  const scene = meshes[0].getScene();
  const made = [];
  try {
    let acc = B.CSG2.FromMesh(meshes[0]);
    made.push(acc);
    for (let i = 1; i < meshes.length; i++) {
      const next = B.CSG2.FromMesh(meshes[i]);
      made.push(next);
      acc = op === 'union' ? acc.add(next)
        : op === 'subtract' ? acc.subtract(next)
        : acc.intersect(next);
      made.push(acc);
    }
    const name = opts.name || `${op}_result`;
    const result = acc.toMesh(name, scene);   // NOT in `made` — this is the kept output

    const srcMat = meshes[0].material;
    const srcColor = srcMat && (srcMat.diffuseColor || srcMat.albedoColor);
    if (srcColor) {
      const mat = new B.StandardMaterial(`${name}_mat`, scene);
      mat.diffuseColor = srcColor.clone();
      result.material = mat;
    } else {
      result.material = scene.defaultMaterial;
    }
    return result;
  } finally {
    for (const csg of made) { try { csg.dispose?.(); } catch { /* already gone */ } }
  }
}
