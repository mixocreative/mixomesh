/**
 * Per-mesh prep steps run on EXPORT CLONES (never on live scene meshes).
 *
 * Each step takes (mesh, ctx) where ctx is the frozen ExportContext built
 * by ExportContext.js. Required ctx fields throw — silent fallback would
 * mean wrong geometry shipped to a slicer without warning.
 */

export function createPrepSteps({ BABYLON, weld, isSolidColor, tryCsg }) {
  return {
    fallbackMaterial(mesh) {
      if (mesh.material) return;
      const m = new BABYLON.StandardMaterial(`${mesh.name}__mat`, mesh.getScene?.() ?? null);
      if ('diffuseColor' in m && BABYLON.Color3) m.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
      mesh.material = m;
    },

    /**
     * Bake (world transform · pivot-anchored ratio scaling · BU→mm) into
     * vertices, then reset the node TRS. Pivot-anchored scaling keeps the
     * reference object's world origin fixed at its as-shown millimetre
     * coordinate while every other object resizes proportionally around it.
     */
    flattenWorld(mesh, ctx) {
      if (!ctx?.pivot)             throw new Error('PrintPrep.flattenWorld: ctx.pivot required');
      if (!(ctx.ratioFactor > 0))  throw new Error('PrintPrep.flattenWorld: ctx.ratioFactor must be positive');
      if (!(ctx.unitFactor > 0))   throw new Error('PrintPrep.flattenWorld: ctx.unitFactor must be positive');
      mesh.computeWorldMatrix?.(true);
      const W = mesh.getWorldMatrix?.();
      // No silent fallback — a mesh without a world matrix would otherwise
      // ship to the slicer at raw BU scale (1000× too small) with no warning.
      if (!W) throw new Error(`PrintPrep.flattenWorld: mesh "${mesh?.name ?? '?'}" has no world matrix`);
      const { pivot: p, ratioFactor: r, unitFactor: u } = ctx;
      const M = W
        .multiply(BABYLON.Matrix.Translation(-p.x, -p.y, -p.z))
        .multiply(BABYLON.Matrix.Scaling(r, r, r))
        .multiply(BABYLON.Matrix.Translation(p.x, p.y, p.z))
        .multiply(BABYLON.Matrix.Scaling(u, u, u));
      mesh.bakeTransformIntoVertices?.(M);
      mesh.setParent?.(null);
      mesh.position?.set?.(0, 0, 0);
      mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
      mesh.rotation?.set?.(0, 0, 0);
      mesh.scaling?.set?.(1, 1, 1);
      mesh.refreshBoundingInfo?.();
    },

    weld(mesh)               { weld(mesh); },
    weldSolidOnly(mesh)      { if (isSolidColor(mesh)) weld(mesh); },
    optimizeIndices(mesh)    { mesh.optimizeIndices?.(); },
    createNormals(mesh)      { mesh.createNormals?.(true); },
    csg(mesh, ctx)           { tryCsg(mesh, ctx); },
    csgSolidOnly(mesh, ctx)  { if (isSolidColor(mesh)) tryCsg(mesh, ctx); },
  };
}
