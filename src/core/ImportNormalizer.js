// THE import side of the transform pipeline. Everything that decides how a
// freshly-loaded asset's units / ratio / handedness / drop anchor get folded
// into geometry lives HERE and nowhere else, so future import settings stay
// isolated from loading, scene wiring and export. The export-side twin is
// PrintManager's `flattenWorld` PREP step.

import {
  DEFAULT_SOURCE_UNIT,
  SOURCE_UNIT_FACTORS,
  computeSceneNormalizationScale,
} from './scale/ScaleMath.js';

const BABYLON = window.BABYLON;

export { DEFAULT_SOURCE_UNIT, SOURCE_UNIT_FACTORS };

/**
 * The one unit/ratio scale used by the import-normalization seam: source-unit
 * conversion × (model's own ratio / scene working ratio). Both the fresh-load
 * and project-restore paths feed this into {@link bakeImportTransform} so the
 * math can't drift between them.
 */
export function importScaleFactor(sourceUnit, modelRatio, ratio = modelRatio) {
  // Per-object ratio redesign (2026-06-16): the scene-scale term is the
  // object's own `ratio`, seeded `= modelRatio` at import. With the seed the
  // ratio cancels (authoredRatio / ratio === 1), so a fresh import lands at its
  // authored size, normalized only by sourceUnit. Changing the object's ratio
  // afterwards goes through RescaleObjectCommand; project restore feeds the
  // saved per-object ratio here to reproduce the baked size.
  return computeSceneNormalizationScale(
    { sourceUnit, authoredRatio: modelRatio },
    { sceneRatio: ratio }
  );
}

/**
 * THE SINGLE IMPORT-NORMALIZATION SEAM.
 *
 * Every transform a freshly-imported asset arrives with is resolved here and
 * BAKED into vertex data, leaving each mesh with a clean local transform:
 * `rotation = 0`, `scaling = (1,1,1)`, `parent = null`, and `position` = its
 * world placement (plus the drop offset). Nothing import-related lives on the
 * node transforms afterwards — future import tweaks belong in this one
 * function and nowhere else.
 *
 * What gets folded in:
 *  1. Unit + ratio scale (`factor`, from {@link importScaleFactor}: sourceUnit
 *     × modelRatio / workingRatio).
 *  2. Babylon's glTF **right-handed → left-handed** conversion. The loader
 *     expresses this as a reflection on the `__root__` node (a negative-
 *     determinant matrix). Leaving it on the hierarchy is exactly what made
 *     the Properties panel read `rotZ 180 / scaleY -1`: `Matrix.decompose`
 *     cannot factor a reflection into rotation + positive scale, so it picks
 *     an equivalent-but-ugly split. Baking it into the geometry removes it
 *     from every readout while keeping the model visually identical.
 *  3. The drop anchor.
 *
 * Because step 2 is a reflection, baking it into a now-positive-scale mesh
 * reverses triangle winding — so faces are flipped back when the baked linear
 * matrix has a negative determinant, keeping culling and exported OBJ/STL
 * winding outward.
 *
 * @param {BABYLON.AssetContainer} container
 * @param {number} factor    unit × ratio scale
 * @param {BABYLON.Vector3} [position]  world drop offset
 */
export function bakeImportTransform(container, factor, position) {
  const nodes = [...container.meshes, ...container.transformNodes];
  const roots = nodes.filter(n => !n.parent);

  // Fold the unit/ratio scale onto the roots so it propagates into every
  // descendant's world matrix (and thus into the bake below).
  for (const r of roots) {
    r.scaling = r.scaling.scale(factor);
    r.position.scaleInPlace(factor);
  }

  const geo = container.meshes.filter(
    m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0
  );

  // Snapshot full world matrices before any detaching so the loop order
  // can't perturb a result mid-flight.
  const worlds = new Map();
  for (const m of geo) { m.computeWorldMatrix(true); worlds.set(m, m.getWorldMatrix().clone()); }

  for (const m of geo) {
    const W = worlds.get(m);
    const linear = W.clone();
    linear.setTranslation(BABYLON.Vector3.Zero());   // rot + scale + RH→LH flip
    m.bakeTransformIntoVertices(linear);

    m.setParent(null);
    m.position.copyFrom(W.getTranslation());
    if (position) m.position.addInPlace(position);
    m.rotationQuaternion = BABYLON.Quaternion.Identity();
    m.rotation.set(0, 0, 0);
    m.scaling.set(1, 1, 1);

    if (linear.determinant() < 0) m.flipFaces(false);
    m.refreshBoundingInfo?.();
  }

  // The container's transform / empty nodes (incl. Babylon's __root__) are
  // now childless — drop them so the hierarchy is flat and decompose-clean.
  for (const n of nodes) {
    if (geo.includes(n)) continue;
    try { n.dispose(true, false); } catch { /* */ }
  }
}
