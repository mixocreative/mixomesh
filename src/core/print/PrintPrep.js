export function createPrepSteps({ BABYLON, weld, isSolidColor, tryCsg }) {
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
      const M = W.multiply(BABYLON.Matrix.Scaling(ctx.factor, ctx.factor, ctx.factor));
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
