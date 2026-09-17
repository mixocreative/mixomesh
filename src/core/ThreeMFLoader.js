// 3MF import — registers a Babylon SceneLoader plugin for `.3mf`, so every
// existing AssetLoader path (drop, re-instantiate, project restore) handles
// 3MF with zero branching. Babylon ships no 3MF loader (the npm loaders cover
// glTF/OBJ/STL only), so the parser is hand-rolled — and it is the exact
// INVERSE of PrintManager.exportThreeMF: read it back as we wrote it.
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
// Scale note: vertices are returned in raw mm and run through the standard
// `bakeImportTransform` (units/ratio) just like an STL — NOT bit-identical to
// the pre-export scene unless workingRatio == targetRatio, which is the same
// inherent ratio-model behaviour as re-importing an exported OBJ/STL.

import { fromPrintSpace } from './print/PrintSpace.js';

const BABYLON = window.BABYLON;

const PLUGIN_NAME = '3mf';
const EXT = '.3mf';
// Axis map lives in print/PrintSpace.js (shared with every writer). 3MF
// `unit` → millimetres, per 3MF Core §3.4 (default millimeter).
const UNIT_TO_MM = Object.freeze({
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
});

const NS_MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

let _registered = false;

function _hexToColor3(hex) {
  // Accept #RRGGBB or #RRGGBBAA (export emits 8-digit upper-case).
  const h = String(hex || '').replace(/^#/, '');
  const r = parseInt(h.slice(0, 2) || '80', 16) / 255;
  const g = parseInt(h.slice(2, 4) || '80', 16) / 255;
  const b = parseInt(h.slice(4, 6) || '80', 16) / 255;
  return new BABYLON.Color3(
    Number.isFinite(r) ? r : 0.5,
    Number.isFinite(g) ? g : 0.5,
    Number.isFinite(b) ? b : 0.5,
  );
}

/** Parse a 3MF `<item>`/transform 12-tuple → Babylon row-major Matrix. */
function _itemMatrix(transformStr) {
  if (!transformStr) return null;
  const n = transformStr.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(x => !Number.isFinite(x))) return null;
  // 3MF: row-major 4×3 (rotation/scale 3×3 then translation row).
  return BABYLON.Matrix.FromValues(
    n[0], n[1], n[2], 0,
    n[3], n[4], n[5], 0,
    n[6], n[7], n[8], 0,
    n[9], n[10], n[11], 1,
  );
}

function _localName(node) {
  return node?.localName || String(node?.tagName ?? '').split(':').pop();
}

function _directChildren(node, name) {
  const kids = node?.children ? [...node.children] : [...(node?.childNodes ?? [])].filter(n => n.nodeType === 1);
  return kids.filter(child => _localName(child) === name);
}

function _firstDirect(node, name) {
  return _directChildren(node, name)[0] ?? null;
}

function _parseModelXml(modelXml) {
  const doc = new DOMParser().parseFromString(modelXml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('3MF: malformed 3D model XML');
  }
  return doc;
}

function _objectsById(doc) {
  const objects = new Map();
  for (const obj of doc.getElementsByTagName('object')) {
    objects.set(obj.getAttribute('id'), obj);
  }
  return objects;
}

function _cleanPackagePath(path) {
  return String(path || '').trim().replace(/^\/+/, '');
}

function _resolvePackagePath(path, basePath = '') {
  const clean = _cleanPackagePath(path);
  if (!clean) return '';
  if (String(path || '').trim().startsWith('/')) return clean;
  const base = _cleanPackagePath(basePath);
  const slash = base.lastIndexOf('/');
  return `${slash >= 0 ? base.slice(0, slash + 1) : ''}${clean}`.replace(/\/+/g, '/');
}

function _componentModelPath(component) {
  return component?.getAttribute('p:path')
    || component?.getAttribute('path')
    || component?.getAttributeNS?.('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path')
    || '';
}

function _matrixFor(componentOrItem) {
  return _itemMatrix(componentOrItem?.getAttribute('transform')) ?? BABYLON.Matrix.Identity();
}

function _multiplyMatrices(a, b) {
  if (!a) return b ?? BABYLON.Matrix.Identity();
  if (!b) return a;
  return b.multiply(a);
}

function _instanceName(obj, objectId, counts) {
  const base = obj.getAttribute('name') || `Part_${objectId}`;
  const n = (counts.get(objectId) ?? 0) + 1;
  counts.set(objectId, n);
  return n === 1 ? base : `${base}.${String(n).padStart(3, '0')}`;
}

/** Locate the 3D model part: follow _rels/.rels, fall back to our export path. */
async function _findModelXml(zip) {
  let target = '3D/3dmodel.model';
  const relsFile = zip.file('_rels/.rels');
  if (relsFile) {
    try {
      const relsDoc = new DOMParser().parseFromString(await relsFile.async('text'), 'application/xml');
      for (const rel of relsDoc.getElementsByTagName('Relationship')) {
        const t = rel.getAttribute('Type') || '';
        if (t.includes('3dmodel')) { target = (rel.getAttribute('Target') || target).replace(/^\//, ''); break; }
      }
    } catch { /* malformed rels — use default path */ }
  }
  const modelFile = zip.file(target) || zip.file('3D/3dmodel.model');
  if (!modelFile) throw new Error('3MF: no 3D model part found in package');
  return { path: target, text: await modelFile.async('text') };
}

/**
 * Read a PNG part out of the OPC zip and turn it into a blob URL that a
 * Babylon StandardMaterial.diffuseTexture can be constructed from.
 * Returns null on failure (parser already swallowed everything but path
 * lookups; we don't want a single bad texture to abort the whole load).
 */
async function _texturePartToUrl(zip, partPath) {
  if (!zip || !partPath) return null;
  const clean = partPath.replace(/^\//, '');
  const file = zip.file(clean);
  if (!file) return null;
  try {
    const u8 = await file.async('uint8array');
    return URL.createObjectURL(new Blob([u8], { type: 'image/png' }));
  } catch { return null; }
}

let _splitSeq = 0;

/**
 * Material key for one triangle: a texture2dgroup is one material per group
 * (UVs vary per corner, the texture does not); a colorgroup (or any other
 * indexed property resource) is one material per (group, index).
 */
function _triangleMaterialKey(ctx, pid, pindex) {
  const tg = pid != null ? ctx.texGroups.get(pid) : null;
  if (tg) return { str: `t:${pid}`, pid, pindex: 0, tg };
  return { str: pid != null ? `c:${pid}:${pindex}` : '', pid, pindex, tg: null };
}

/**
 * Parse the 3MF model XML into Babylon meshes inside an AssetContainer.
 * One mesh per built object; component-only assemblies are skipped (we never
 * export those — one <object>+<mesh> per part).
 *
 * Two material pathways are supported, exactly matching the two writer
 * pipelines in PrintManager._serialize3MF:
 *   m:colorgroup (filament/Bambu)        → mat.diffuseColor
 *   m:texture2dgroup (Mimaki textured)   → mat.diffuseTexture from a PNG
 *                                          part inside the OPC zip
 */
async function _buildContainer(scene, zip, modelXml, opts = {}) {
  const makeContext = async (modelPath, xml) => {
    const doc = _parseModelXml(xml);
    const cleanPath = _cleanPackagePath(modelPath) || '3D/3dmodel.model';
    const unitAttr = (doc.documentElement?.getAttribute?.('unit')
      ?? doc.getElementsByTagName('model')[0]?.getAttribute('unit') ?? 'millimeter').trim().toLowerCase();
    const unitScale = UNIT_TO_MM[unitAttr || 'millimeter'];
    if (!unitScale) throw new Error(`3MF: unsupported unit "${unitAttr}" (expected micron|millimeter|centimeter|inch|foot|meter)`);

    // colorgroup id → [Color3,…] (Materials extension; export writes group "1").
    const colorGroups = new Map();
    for (const cg of doc.getElementsByTagNameNS(NS_MATERIAL, 'colorgroup')) {
      const cols = [...cg.getElementsByTagNameNS(NS_MATERIAL, 'color')]
        .map(c => _hexToColor3(c.getAttribute('color')));
      colorGroups.set(cg.getAttribute('id'), cols);
    }

    // texture2d id → { path, url } (resolved blob URLs from the OPC zip).
    const textures = new Map();
    for (const t of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2d')) {
      const id = t.getAttribute('id');
      const path = _resolvePackagePath(t.getAttribute('path') || '', cleanPath);
      const url = await _texturePartToUrl(zip, path);
      textures.set(id, { path, url });
    }

    // texture2dgroup id → { texId, coords[{u,v}, ...] }
    const texGroups = new Map();
    for (const tg of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2dgroup')) {
      const id = tg.getAttribute('id');
      const texId = tg.getAttribute('texid');
      const coords = [...tg.getElementsByTagNameNS(NS_MATERIAL, 'tex2coord')]
        .map(c => ({
          u: parseFloat(c.getAttribute('u')) || 0,
          v: parseFloat(c.getAttribute('v')) || 0,
        }));
      texGroups.set(id, { texId, coords });
    }

    return {
      path: cleanPath,
      doc,
      unitScale,
      objectsById: _objectsById(doc),
      colorGroups,
      textures,
      texGroups,
    };
  };

  const contextCache = new Map();
  const loadContext = async (modelPath, xml = null) => {
    const cleanPath = _cleanPackagePath(modelPath) || '3D/3dmodel.model';
    if (contextCache.has(cleanPath)) return contextCache.get(cleanPath);
    const promise = (async () => {
      let text = xml;
      if (text == null) {
        const file = zip?.file(cleanPath);
        if (!file) return null;
        text = await file.async('text');
      }
      return makeContext(cleanPath, text);
    })();
    contextCache.set(cleanPath, promise);
    return promise;
  };

  const rootContext = await loadContext(opts.modelPath || '3D/3dmodel.model', modelXml);

  const container = new BABYLON.AssetContainer(scene);
  const usedTexIds = new Set();   // model path + texture2d ids actually bound to a material

  let made = 0;
  const instanceCounts = new Map();

  const greyColor = () => new BABYLON.Color3(0.8, 0.8, 0.8);

  /**
   * Material for one triangle-group key (see _triangleMaterialKey). A
   * texture2dgroup key binds the embedded PNG; a colorgroup key resolves the
   * colour; anything else (no property, unknown group) is the grey fallback.
   */
  const makeMaterial = (ctx, name, key) => {
    const mat = new BABYLON.StandardMaterial(`${name}__3mf`, scene);
    if (key.tg) {
      const tex = ctx.textures.get(key.tg.texId);
      if (tex?.url) {
        const bt = new BABYLON.Texture(tex.url, scene, false, false);
        bt.name = `${name}__tex`;
        mat.diffuseTexture = bt;
        container.textures?.push?.(bt);
        usedTexIds.add(`${ctx.path}:${key.tg.texId}`);
      } else {
        mat.diffuseColor = greyColor();
      }
    } else {
      const group = key.pid != null ? ctx.colorGroups.get(key.pid) : null;
      mat.diffuseColor = (group && group[key.pindex]) ? group[key.pindex] : greyColor();
    }
    mat.backFaceCulling = false;
    container.materials.push(mat);
    return mat;
  };

  const finishMesh = (mesh, positions, indices, uvs, material, parent) => {
    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    if (uvs) vd.uvs = uvs;
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);
    mesh.material = material;
    if (parent) mesh.setParent(parent);
    container.meshes.push(mesh);
  };

  const createMeshInstance = (ctx, objectId, obj, meshEl, matrix, parentNode) => {
    const vEls = meshEl.getElementsByTagName('vertex');
    const tEls = meshEl.getElementsByTagName('triangle');
    if (!vEls.length || !tEls.length) return 0;

    const positions = new Array(vEls.length * 3);
    const unitScale = ctx.unitScale;
    for (let i = 0; i < vEls.length; i++) {
      const el = vEls[i];
      const vx = Number(el.getAttribute('x')), vy = Number(el.getAttribute('y')), vz = Number(el.getAttribute('z'));
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
        throw new Error(`3MF: vertex ${i} of object ${objectId} has a non-numeric coordinate`);
      }
      let p = new BABYLON.Vector3(vx * unitScale, vy * unitScale, vz * unitScale);
      if (matrix) p = BABYLON.Vector3.TransformCoordinates(p, matrix);   // 3MF-space build/component placement
      const [bx, by, bz] = fromPrintSpace(p.x, p.y, p.z);               // 3MF RH Z-up → Babylon LH Y-up
      positions[i * 3] = bx; positions[i * 3 + 1] = by; positions[i * 3 + 2] = bz;
    }
    const vertexCount = vEls.length;

    // Object-level property defaults (3MF Core §4.1: a triangle without
    // `pid` inherits the object's pid/pindex; `p2`/`p3` default to `p1`).
    const objPid = obj.getAttribute('pid');
    const objPindexRaw = parseInt(obj.getAttribute('pindex') || '0', 10);
    const objPindex = Number.isFinite(objPindexRaw) ? objPindexRaw : 0;

    // Triangles grouped by material key, first-seen order. Every entry keeps
    // the file's index order (see winding note below) plus the resolved
    // per-corner property index so textured groups can look up UVs.
    const groups = new Map();   // keyStr → { key, tris: [a,b,c,p1,p2,p3, …] }
    for (let i = 0; i < tEls.length; i++) {
      const tEl = tEls[i];
      const a = Number(tEl.getAttribute('v1'));
      const b = Number(tEl.getAttribute('v2'));
      const c = Number(tEl.getAttribute('v3'));
      if (!(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c))
          || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) {
        throw new Error(`3MF: triangle ${i} of object ${objectId} references a vertex outside 0..${vertexCount - 1}`);
      }
      const triPid = tEl.getAttribute('pid');
      const pid = triPid != null && triPid !== '' ? triPid : objPid;
      const p1Attr = tEl.getAttribute('p1');
      const hasP1 = p1Attr != null && p1Attr !== '';
      // A triangle that names no property of its own inherits the object's
      // pindex for all three corners; one that names pid/p1 uses those.
      const p1 = hasP1 ? (parseInt(p1Attr, 10) || 0) : objPindex;
      const p2 = parseInt(tEl.getAttribute('p2') ?? '', 10);
      const p3 = parseInt(tEl.getAttribute('p3') ?? '', 10);
      const key = _triangleMaterialKey(ctx, pid, p1);
      let g = groups.get(key.str);
      if (!g) { g = { key, tris: [] }; groups.set(key.str, g); }
      g.tris.push(a, b, c, p1, Number.isFinite(p2) ? p2 : p1, Number.isFinite(p3) ? p3 : p1);
    }

    const baseName = _instanceName(obj, objectId, instanceCounts);

    // 3MF triangles are counter-clockwise-outward in a right-handed space.
    // fromPrintSpace is a reflection, which makes the same index order read
    // clockwise — exactly Babylon's convention for a CounterClockWise-flagged
    // (default) mesh in a left-handed scene. So: keep the file's order.

    if (groups.size === 1) {
      // Fast path — one material for the whole object: full vertex pool as
      // written, per-vertex UVs from the (single) texture2dgroup.
      const { key, tris } = groups.values().next().value;
      const indices = new Array(tEls.length * 3);
      const uvs = key.tg ? new Array(vertexCount * 2).fill(0) : null;
      const co = key.tg?.coords;
      for (let i = 0, t = 0; i < tris.length; i += 6, t += 3) {
        const a = tris[i], b = tris[i + 1], c = tris[i + 2];
        indices[t] = a; indices[t + 1] = b; indices[t + 2] = c;
        // Exporter writes one tex2coord per vertex with p_i == v_i —
        // last-write-wins is harmless because every triangle covering
        // vertex k writes the same coord.
        if (uvs) {
          const p1 = tris[i + 3], p2 = tris[i + 4], p3 = tris[i + 5];
          if (co[p1]) { uvs[a * 2] = co[p1].u; uvs[a * 2 + 1] = co[p1].v; }
          if (co[p2]) { uvs[b * 2] = co[p2].u; uvs[b * 2 + 1] = co[p2].v; }
          if (co[p3]) { uvs[c * 2] = co[p3].u; uvs[c * 2 + 1] = co[p3].v; }
        }
      }
      const mesh = new BABYLON.Mesh(baseName, scene);
      finishMesh(mesh, positions, indices, uvs, makeMaterial(ctx, mesh.name, key), parentNode);
      return 1;
    }

    // Multi-material object — per-triangle `pid`/`p1` mixing several
    // property entries (our own writer does this for a logical unit made of
    // per-material sibling meshes; third-party files do it over one vertex
    // pool). One-mesh-one-shader (AGENTS.md rule 7): emit ONE Babylon mesh
    // per material key, each with a compacted vertex buffer, all parented to
    // a shared TransformNode and stamped with one sourceGroupId so
    // AssetRegistration / the validator treat them as ONE logical object.
    const node = new BABYLON.TransformNode(baseName, scene);
    node.metadata = { ...(node.metadata ?? {}), threeMFObjectId: objectId, importHierarchy: true };
    if (parentNode) node.setParent(parentNode);
    container.transformNodes.push(node);
    const sourceGroupId = `3mf:${ctx.path}:${objectId}:${++_splitSeq}`;

    let k = 0;
    for (const { key, tris } of groups.values()) {
      const remap = new Map();   // source vertex (+ tex2coord for textured) → compact index
      const subPositions = [];
      const subUvs = key.tg ? [] : null;
      const co = key.tg?.coords;
      const subIndices = new Array(tris.length / 2);
      const compact = (v, p) => {
        // Textured groups key on (vertex, coord) so a UV seam at a shared
        // vertex splits exactly as the file describes it; solid groups key
        // on the vertex alone.
        const rk = subUvs ? `${v}:${p}` : v;
        let idx = remap.get(rk);
        if (idx == null) {
          idx = subPositions.length / 3;
          remap.set(rk, idx);
          subPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
          if (subUvs) { const uv = co[p]; subUvs.push(uv ? uv.u : 0, uv ? uv.v : 0); }
        }
        return idx;
      };
      for (let i = 0, t = 0; i < tris.length; i += 6, t += 3) {
        subIndices[t]     = compact(tris[i],     tris[i + 3]);
        subIndices[t + 1] = compact(tris[i + 1], tris[i + 4]);
        subIndices[t + 2] = compact(tris[i + 2], tris[i + 5]);
      }
      const mesh = new BABYLON.Mesh(`${baseName}__mat${k}`, scene);
      mesh.metadata = {
        ...(mesh.metadata ?? {}),
        sourceGroupId,
        sourceMeshName: baseName,
        splitPartIndex: k,
        threeMFObjectId: objectId,
      };
      finishMesh(mesh, subPositions, subIndices, subUvs, makeMaterial(ctx, mesh.name, key), node);
      k++;
    }
    return k;
  };

  const instantiateObject = async (ctx, objectId, matrix, parentNode, stack = new Set()) => {
    const stackKey = `${ctx?.path || 'model'}:${objectId}`;
    if (stack.has(stackKey)) throw new Error(`3MF: component cycle at object ${objectId}`);
    const obj = ctx?.objectsById.get(objectId);
    if (!obj) return 0;
    const nextStack = new Set(stack);
    nextStack.add(stackKey);
    const meshEl = _firstDirect(obj, 'mesh');
    if (meshEl) return createMeshInstance(ctx, objectId, obj, meshEl, matrix, parentNode);

    const componentsEl = _firstDirect(obj, 'components');
    if (!componentsEl) return 0;
    const node = new BABYLON.TransformNode(_instanceName(obj, objectId, instanceCounts), scene);
    node.metadata = { ...(node.metadata ?? {}), threeMFObjectId: objectId, importHierarchy: true };
    if (parentNode) node.setParent(parentNode);
    container.transformNodes.push(node);

    let childCount = 0;
    for (const component of _directChildren(componentsEl, 'component')) {
      const childObjectId = component.getAttribute('objectid');
      const childPath = _componentModelPath(component);
      const childCtx = childPath
        ? await loadContext(_resolvePackagePath(childPath, ctx.path))
        : ctx;
      const childMatrix = _multiplyMatrices(matrix, _matrixFor(component));
      childCount += await instantiateObject(childCtx, childObjectId, childMatrix, node, nextStack);
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
  const buildItems = buildEl ? _directChildren(buildEl, 'item') : [];
  const placements = buildItems.length
    ? buildItems.map(it => ({ id: it.getAttribute('objectid'), matrix: _matrixFor(it) }))
    : [...rootContext.objectsById.keys()].map(id => ({ id, matrix: BABYLON.Matrix.Identity() }));

  for (const placement of placements) {
    made += await instantiateObject(rootContext, placement.id, placement.matrix, null);
  }

  // Hand entities to the container the way Babylon's own loaders do: detach
  // from the live scene now; AssetLoader calls addAllToScene().
  for (const mesh of container.meshes) scene.removeMesh?.(mesh);
  for (const mat of container.materials) scene.removeMaterial?.(mat);
  for (const node of container.transformNodes) scene.removeTransformNode?.(node);

  // Revoke blob URLs for texture2d parts that no built object referenced
  // (audit LOW #8) — used textures keep their URL alive for the live Babylon
  // texture; unused ones would otherwise leak for the page's lifetime.
  for (const ctxPromise of contextCache.values()) {
    const ctx = await ctxPromise;
    if (!ctx) continue;
    for (const [tid, t] of ctx.textures) {
      if (t.url && !usedTexIds.has(`${ctx.path}:${tid}`)) { try { URL.revokeObjectURL(t.url); } catch { /* */ } }
    }
  }

  if (!made) throw new Error('3MF: no importable mesh objects');
  return container;
}

/** Register the `.3mf` SceneLoader plugin exactly once. Idempotent. */
export function registerThreeMFLoader() {
  if (_registered || !BABYLON?.SceneLoader?.RegisterPlugin) return;
  _registered = true;

  const parse = async (scene, data) => {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(data);          // data = ArrayBuffer (isBinary)
    // zip is threaded into _buildContainer so the Materials Extension path
    // can read embedded PNG texture parts directly out of the OPC package.
    const model = await _findModelXml(zip);
    return _buildContainer(scene, zip, model.text, { modelPath: model.path });
  };

  BABYLON.SceneLoader.RegisterPlugin({
    name: PLUGIN_NAME,
    extensions: { [EXT]: { isBinary: true } },
    canDirectLoad: () => false,
    // AssetLoader only ever calls LoadAssetContainerAsync → this hook.
    loadAssetContainerAsync(scene, data) {
      return parse(scene, data);
    },
    // Provided for completeness if a path routes through ImportMesh instead.
    async importMeshAsync(_meshNames, scene, data) {
      const c = await parse(scene, data);
      return {
        meshes: c.meshes, particleSystems: [], skeletons: [],
        animationGroups: [], transformNodes: [], geometries: [], lights: [],
      };
    },
    async loadAsync(scene, data) {
      const c = await parse(scene, data);
      c.addAllToScene();
    },
  });
}

registerThreeMFLoader();

export const __test = {
  buildContainer: _buildContainer,
  itemMatrix: _itemMatrix,
};
