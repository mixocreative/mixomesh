// 3MF import — registers a Babylon SceneLoader plugin for `.3mf`, so every
// existing AssetLoader path (drop, re-instantiate, project restore) handles
// 3MF with zero branching. Babylon ships no 3MF loader, so the parser is
// hand-rolled — the exact INVERSE of PrintManager.exportThreeMF.
//
//   export:  Babylon Y-up mm  --RotationX(-90°)-->  3MF Z-up mm  (+ winding
//            reversed v1,v3,v2, + origin-centred, colour via m:colorgroup OR
//            full texture-uv via m:texture2dgroup + per-tri p1/p2/p3)
//   import:  3MF Z-up mm       --RotationX(+90°)-->  Babylon Y-up mm  (+ winding
//            restored, + colour → StandardMaterial.diffuseColor, OR texture
//            → StandardMaterial.diffuseTexture from the embedded PNG; mm
//            handled by the normal import-scale model exactly like STL —
//            DEFAULT_SOURCE_UNIT is mm)
//
// ONE parse: `meshImportCore.importThreeMFBuffer` (the SAX pass over the
// package, in workers/MeshImport.worker.js or inline here for the plugin)
// yields a pre-parsed package; `buildThreeMFContainerFromParsed` turns it into
// meshes. The pure steps live in import/threeMF*.js; this file walks the
// build/component tree and makes Babylon entities.
//
// Scale note: vertices are returned in raw mm and run through the standard
// `bakeImportTransform` (units/ratio) just like an STL — NOT bit-identical to
// the pre-export scene unless workingRatio == targetRatio, which is the same
// inherent ratio-model behaviour as re-importing an exported OBJ/STL.

import { importThreeMFBuffer } from './import/meshImportCore.js';
import { preparsedPackage, loosePackage, cleanPackagePath, resolvePackagePath } from './import/threeMFPackage.js';
import { readModelContext, materialKeyOf, createMaterial, releaseUnusedTextures } from './import/threeMFResources.js';
import { readSlicerHelpers } from './import/threeMFSlicerHelpers.js';
import {
  firstDirect, directChildren, matrixFor, multiplyMatrices, componentModelPath, instanceName,
} from './import/threeMFDom.js';
import {
  withoutTriangleRanges, placeVertices, groupTriangles, soupIndices, compactGroup,
} from './import/threeMFGeometry.js';
import { fromPrintSpace } from './print/PrintSpace.js';
import { IMPORT_LIMITS, assertImportFileSize, assertZipSafe, assertTriangleCapacity } from './import/ImportLimits.js';
import { caps } from './storage/capabilities.js';
import { Toast } from '../ui/Toast.js';
import { t } from '../i18n/index.js';

const BABYLON = window.BABYLON;

const PLUGIN_NAME = '3mf';
const EXT = '.3mf';

// fromPrintSpace as a 3x3 linear map (row-major), derived once from the basis
// so the per-vertex loop needs no array allocation and follows any change to
// the shared axis contract.
const PS = (() => {
  const ex = fromPrintSpace(1, 0, 0), ey = fromPrintSpace(0, 1, 0), ez = fromPrintSpace(0, 0, 1);
  return [ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]];
})();

let _registered = false;
let _splitSeq = 0;
let _loadJSZip = () => import('jszip').then(m => m.default);

/**
 * Build Babylon meshes inside an AssetContainer from a package reader.
 * One mesh per built object; a component-only assembly becomes a
 * TransformNode tree. Two material pathways, exactly matching the two writer
 * pipelines in PrintManager._serialize3MF:
 *   m:colorgroup (filament/Bambu)        → mat.diffuseColor
 *   m:texture2dgroup (Mimaki textured)   → mat.diffuseTexture from a PNG
 *                                          part inside the package
 * @param {BABYLON.Scene} scene
 * @param {import('./import/threeMFPackage.js').ThreeMFPackage} pkg
 */
async function _buildContainer(scene, pkg) {
  const contextCache = new Map();
  const loadContext = (modelPath) => {
    const cleanPath = cleanPackagePath(modelPath) || pkg.rootPath;
    if (!contextCache.has(cleanPath)) {
      contextCache.set(cleanPath, pkg.model(cleanPath).then(parsed => (parsed ? readModelContext(cleanPath, parsed, pkg) : null)));
    }
    return contextCache.get(cleanPath);
  };

  const rootContext = await loadContext(pkg.rootPath);
  if (!rootContext) throw new Error('3MF: no 3D model part found in package');
  const helpers = await readSlicerHelpers(pkg);
  const skippedOther = new Set();

  const container = new BABYLON.AssetContainer(scene);
  const usedTexIds = new Set();   // model path + texture2d ids actually bound to a material
  let made = 0;
  let placedTriangles = 0;
  const instanceCounts = new Map();

  const makeMaterial = (ctx, name, key) => createMaterial(scene, container, ctx, name, key, usedTexIds);

  const finishMesh = (mesh, positions, indices, uvs, material, parent) => {
    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    if (uvs) vd.uvs = uvs;
    const normals = new Float32Array(positions.length);
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);
    mesh.material = material;
    if (parent) mesh.setParent(parent);
    container.meshes.push(mesh);
  };

  const createMeshInstance = (ctx, objectId, obj, matrix, parentNode) => {
    const helperRanges = ctx === rootContext ? helpers.ranges.get(objectId) : null;
    const sourceGeometry = ctx.geometry.get(objectId);
    const geometry = helperRanges && sourceGeometry ? withoutTriangleRanges(sourceGeometry, helperRanges) : sourceGeometry;
    if (!geometry?.positions.length || !geometry.triangles.length) return 0;
    placedTriangles += geometry.triangles.length / 7;
    assertTriangleCapacity(placedTriangles, caps.triangleLimit, '3MF assembly');
    const positions = placeVertices(geometry.positions, ctx.unitScale, matrix?.m ?? null, PS, objectId);
    const pindex = parseInt(obj.getAttribute('pindex') || '0', 10);
    const { groups, singleSolid } = groupTriangles(geometry.triangles, positions.length / 3,
      { pid: obj.getAttribute('pid'), pindex: Number.isFinite(pindex) ? pindex : 0 },
      (pid, p1) => materialKeyOf(ctx, pid, p1), objectId);
    const baseName = instanceName(obj, objectId, instanceCounts);

    // 3MF triangles are counter-clockwise-outward in a right-handed space.
    // fromPrintSpace is a reflection, which makes the same index order read
    // clockwise — exactly Babylon's convention for a CounterClockWise-flagged
    // (default) mesh in a left-handed scene. So: keep the file's order.
    if (singleSolid) {
      // One solid material keeps the original vertex pool. Textured meshes
      // use (vertex, UV) compaction below, even with one material.
      const mesh = new BABYLON.Mesh(baseName, scene);
      finishMesh(mesh, positions, soupIndices(geometry.triangles), null, makeMaterial(ctx, mesh.name, groups[0].key), parentNode);
      return 1;
    }

    // Multi-material object — per-triangle `pid`/`p1` mixing several
    // property entries (our own writer does this for a logical unit made of
    // per-material sibling meshes; third-party files do it over one vertex
    // pool). One-mesh-one-shader (AGENTS.md rule 7): emit ONE Babylon mesh
    // per material key, each with a compacted vertex buffer, all parented to
    // a shared TransformNode and stamped with one sourceGroupId so
    // AssetRegistration / the validator treat them as ONE logical object.
    const multiple = groups.length > 1;
    const node = multiple ? new BABYLON.TransformNode(baseName, scene) : parentNode;
    if (multiple) {
      node.metadata = { ...(node.metadata ?? {}), threeMFObjectId: objectId, importHierarchy: true };
      if (parentNode) node.setParent(parentNode);
      container.transformNodes.push(node);
    }
    const sourceGroupId = `3mf:${ctx.path}:${objectId}:${++_splitSeq}`;
    groups.forEach(({ key, tris }, k) => {
      const sub = compactGroup(tris, positions, key.tg?.coords ?? null);
      const mesh = new BABYLON.Mesh(multiple ? `${baseName}__mat${k}` : baseName, scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), sourceGroupId, sourceMeshName: baseName, splitPartIndex: k, threeMFObjectId: objectId };
      finishMesh(mesh, sub.positions, sub.indices, sub.uvs, makeMaterial(ctx, mesh.name, key), node);
    });
    return groups.length;
  };

  // `ref` = 'item' | 'component': a dangling reference throws rather than
  // silently dropping the part — a partial assembly is a wrong print with no
  // notice (audit F10).
  const instantiateObject = async (ctx, objectId, matrix, parentNode, ref, stack = new Set()) => {
    const stackKey = `${ctx?.path || 'model'}:${objectId}`;
    if (stack.has(stackKey)) throw new Error(`3MF: component cycle at object ${objectId}`);
    const obj = ctx?.objectsById.get(objectId);
    if (!obj) throw new Error(`3MF: ${ref} references missing object "${objectId}" in ${ctx?.path || 'model'}`);
    if (obj.getAttribute('type') === 'other') {                         // Core ch.4: MUST NOT be built
      skippedOther.add(stackKey);
      return 0;
    }
    const nextStack = new Set(stack);
    nextStack.add(stackKey);
    if (firstDirect(obj, 'mesh')) return createMeshInstance(ctx, objectId, obj, matrix, parentNode);

    const componentsEl = firstDirect(obj, 'components');
    if (!componentsEl) return 0;
    const node = new BABYLON.TransformNode(instanceName(obj, objectId, instanceCounts), scene);
    node.metadata = { ...(node.metadata ?? {}), threeMFObjectId: objectId, importHierarchy: true };
    if (parentNode) node.setParent(parentNode);
    container.transformNodes.push(node);

    let childCount = 0;
    const helperParts = ctx === rootContext ? helpers.components.get(objectId) : null;
    for (const component of directChildren(componentsEl, 'component')) {
      const childObjectId = component.getAttribute('objectid');
      if (helperParts?.has(childObjectId)) continue;
      const childPath = componentModelPath(component);
      let childCtx = ctx;
      if (childPath) {
        childCtx = await loadContext(resolvePackagePath(childPath, ctx.path));
        if (!childCtx) throw new Error(`3MF: component path "${childPath}" not found in package`);
      }
      const childMatrix = multiplyMatrices(matrix, matrixFor(component, 'component', ctx.unitScale));
      childCount += await instantiateObject(childCtx, childObjectId, childMatrix, node, 'component', nextStack);
    }
    if (!childCount) {
      container.transformNodes = container.transformNodes.filter(n => n !== node);
      node.dispose();
    }
    return childCount;
  };

  // Build placements: prefer direct <build><item>; if absent, place every
  // resource object at identity.
  const buildEl = rootContext.doc.getElementsByTagName('build')[0];
  const buildItems = buildEl ? directChildren(buildEl, 'item') : [];
  const placements = buildItems.length
    ? buildItems.map(it => ({ id: it.getAttribute('objectid'), matrix: matrixFor(it, 'item', rootContext.unitScale) }))
    : [...rootContext.objectsById.keys()].map(id => ({ id, matrix: BABYLON.Matrix.Identity() }));
  for (const placement of placements) {
    made += await instantiateObject(rootContext, placement.id, placement.matrix, null, 'item');
  }

  // Hand entities to the container the way Babylon's own loaders do: detach
  // from the live scene now; AssetLoader calls addAllToScene().
  for (const mesh of container.meshes) scene.removeMesh?.(mesh);
  for (const mat of container.materials) scene.removeMaterial?.(mat);
  for (const node of container.transformNodes) scene.removeTransformNode?.(node);

  for (const ctxPromise of contextCache.values()) {
    const ctx = await ctxPromise;
    if (ctx) releaseUnusedTextures(ctx, usedTexIds);
  }

  if (!made) throw new Error('3MF: no importable mesh objects');
  const skipped = helpers.count + skippedOther.size;
  if (skipped) Toast.show(t('toast.threeMFHelperVolumesSkipped', { n: skipped }), 'warning', 8000);
  return container;
}

/**
 * The AssetContainer for a pre-parsed package (`importThreeMFBuffer`'s
 * result, from the worker or parsed inline).
 * @param {BABYLON.Scene} scene
 * @param {{ rootPath: string, models: object[], parts: [string, Uint8Array][] }} parsed
 */
export function buildThreeMFContainerFromParsed(scene, parsed) {
  return _buildContainer(scene, preparsedPackage(parsed));
}

/** Register the `.3mf` SceneLoader plugin exactly once. Idempotent. */
export function registerThreeMFLoader() {
  if (_registered || !BABYLON?.SceneLoader?.RegisterPlugin) return;
  _registered = true;

  // Same core as the worker, run inline: this is the ≤ 32 MiB fallback path.
  const parse = async (scene, data) => {
    const JSZip = await _loadJSZip();
    const { result } = await importThreeMFBuffer(data, { JSZip, triangleLimit: caps.triangleLimit });
    return buildThreeMFContainerFromParsed(scene, result);
  };

  BABYLON.SceneLoader.RegisterPlugin({
    name: PLUGIN_NAME,
    extensions: { [EXT]: { isBinary: true } },
    canDirectLoad: () => false,
    // AssetLoader only ever calls LoadAssetContainerAsync → this hook.
    loadAssetContainerAsync(scene, data) {
      return parse(scene, data);
    },
    async importMeshAsync(_meshNames, scene, data) {
      const c = await parse(scene, data);
      return { meshes: c.meshes, particleSystems: [], skeletons: [], animationGroups: [], transformNodes: [], geometries: [], lights: [] };
    },
    async loadAsync(scene, data) { (await parse(scene, data)).addAllToScene(); },
  });
}

registerThreeMFLoader();

/** Open a package and enforce the Decision 19 zip caps before any entry is read (test seam). */
async function _openZip(JSZip, data, limits = IMPORT_LIMITS) {
  assertImportFileSize(data?.byteLength, '3MF file', limits);
  const zip = await JSZip.loadAsync(data);
  assertZipSafe(zip, '3MF file', limits);
  return zip;
}

export const __test = {
  /** Build from a JSZip (or `{ file(path) }` stand-in) plus the root model XML, parsed on demand. */
  buildContainer: (scene, zip, modelXml, opts = {}) =>
    _buildContainer(scene, loosePackage(zip, modelXml, { rootPath: opts.modelPath, triangleLimit: caps.triangleLimit })),
  openZip: _openZip,
  /** Node maps `jszip` to a stub for the export tests; the plugin path needs the real one. */
  useJSZip: (JSZip) => { _loadJSZip = async () => JSZip; },
};
