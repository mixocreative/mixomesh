export function createPrepSteps({ BABYLON, weld, isSolidColor, tryCsg }) {
  const BU_TO_MM = 1000;

  return {
    fallbackMaterial(mesh) {
      if (mesh.material) return;
      const m = new BABYLON.StandardMaterial(`${mesh.name}__mat`, mesh.getScene?.() ?? null);
      if ('diffuseColor' in m && BABYLON.Color3) m.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
      mesh.material = m;
    },
    flattenWorld(mesh, ctx) {
      mesh.computeWorldMatrix?.(true);
      const W = mesh.getWorldMatrix?.();
      if (!W) return;
      const ratioFactor = _positive(ctx.ratioFactor, _positive(ctx.factor, BU_TO_MM) / BU_TO_MM);
      const unitFactor = _positive(ctx.unitFactor, BU_TO_MM);
      const pivot = _validPivot(ctx.pivot);
      const M = pivot
        ? W
          .multiply(BABYLON.Matrix.Translation(-pivot.x, -pivot.y, -pivot.z))
          .multiply(BABYLON.Matrix.Scaling(ratioFactor, ratioFactor, ratioFactor))
          .multiply(BABYLON.Matrix.Translation(pivot.x, pivot.y, pivot.z))
          .multiply(BABYLON.Matrix.Scaling(unitFactor, unitFactor, unitFactor))
        : W.multiply(BABYLON.Matrix.Scaling(ctx.factor, ctx.factor, ctx.factor));
      mesh.bakeTransformIntoVertices?.(M);
      mesh.setParent?.(null);
      mesh.position?.set?.(0, 0, 0);
      mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
      mesh.rotation?.set?.(0, 0, 0);
      mesh.scaling?.set?.(1, 1, 1);
      mesh.refreshBoundingInfo?.();
    },
    weld(mesh) { weld(mesh); },
    weldSolidOnly(mesh) { if (isSolidColor(mesh)) weld(mesh); },
    optimizeIndices(mesh) { mesh.optimizeIndices?.(); },
    createNormals(mesh) { mesh.createNormals?.(true); },
    csg(mesh, ctx) { tryCsg(mesh, ctx); },
    csgSolidOnly(mesh, ctx) { if (isSolidColor(mesh)) tryCsg(mesh, ctx); },
  };
}

function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _validPivot(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
    ? p
    : null;
}
