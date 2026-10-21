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

import { parseThreeMFXml } from './import/ThreeMFXml.js';
import { zipEntryTextChunks } from './import/zipText.js';
import { fromPrintSpace } from './print/PrintSpace.js';
import { IMPORT_LIMITS, assertImportFileSize, assertZipSafe, assertTriangleCapacity } from './import/ImportLimits.js';

import { caps } from './storage/capabilities.js';

const BABYLON = window.BABYLON;

const PLUGIN_NAME = '3mf';
const EXT = '.3mf';
// Axis map lives in print/PrintSpace.js (shared with every writer). 3MF
// `unit` → millimetres, per 3MF Core §3.4 (default millimeter).
const UNIT_TO_MM = Object.freeze({
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
});

const NS_MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

// fromPrintSpace as a 3x3 linear map (row-major), derived once from the basis
// so the per-vertex loop needs no array allocation and follows any change to
// the shared axis contract.
const PS = (() => {
  const ex = fromPrintSpace(1, 0, 0), ey = fromPrintSpace(0, 1, 0), ez = fromPrintSpace(0, 0, 1);
  return [ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]];
})();

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

/**
 * Parse a 3MF `<item>`/transform 12-tuple → Babylon row-major Matrix.
 * Absent attribute → null (caller treats as identity, the spec default);
 * a present-but-malformed value (wrong count / NaN) THROWS — a placement we
 * cannot read must not silently collapse to identity (audit F11).
 */
function _itemMatrix(transformStr, where = 'item') {
  if (transformStr == null || transformStr === '') return null;
  const n = transformStr.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(x => !Number.isFinite(x))) {
    throw new Error(`3MF: malformed transform "${transformStr}" on ${where}`);
  }
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

function _matrixFor(componentOrItem, kind) {
  const where = `${kind} objectid=${componentOrItem?.getAttribute('objectid')}`;
  return _itemMatrix(componentOrItem?.getAttribute('transform'), where) ?? BABYLON.Matrix.Identity();
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
  // Streamed, not async('text'): a 10M-triangle part exceeds V8's string limit.
  return { path: target, source: zipEntryTextChunks(modelFile) };
}

/**
 * Read a PNG part out of the OPC zip and turn it into a blob URL that a
 * Babylon StandardMaterial.diffuseTexture can be constructed from.
 * Returns null on failure (parser already swallowed everything but path
 * lookups; we don't want a single bad texture to abort the whole load).
 */
async function _texturePartToUrl(zip, partPath, contentType = 'image/png') {
  if (!zip || !partPath) return null;
  const clean = partPath.replace(/^\//, '');
  const file = zip.file(clean);
  if (!file) return null;
  try {
    const u8 = await file.async('uint8array');
    return URL.createObjectURL(new Blob([u8], { type: contentType }));
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
  // `opts.preparsed`: Map<cleanPath, { xml, geometry }> from the import worker
  // (MeshImport.worker.js) — the SAX pass already ran off the main thread.
  const makeContext = async (modelPath, xml) => {
    const preparsed = opts.preparsed?.get(_cleanPackagePath(modelPath) || '3D/3dmodel.model');
    const parsed = preparsed ?? await parseThreeMFXml(xml, { triangleBudget: caps.triangleBudget });
    const doc = _parseModelXml(parsed.xml);
    const cleanPath = _cleanPackagePath(modelPath) || '3D/3dmodel.model';
    const unitAttr = (doc.documentElement?.getAttribute?.('unit')
      ?? doc.getElementsByTagName('model')[0]?.getAttribute('unit') ?? 'millimeter').trim().toLowerCase();
    const unitScale = UNIT_TO_MM[unitAttr || 'millimeter'];
    if (!unitScale) throw new Error(`3MF: unsupported unit "${unitAttr}" (expected micron|millimeter|centimeter|inch|foot|meter)`);

    // colorgroup id → [Color3,…] (Materials extension; export writes group "1").
    const colorGroups = new Map();
    const colorAlphas = new Map();
    const alphaOf = hex => /^#[0-9a-f]{8}$/i.test(hex || '') ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
    for (const cg of doc.getElementsByTagNameNS(NS_MATERIAL, 'colorgroup')) {
      const cols = [...cg.getElementsByTagNameNS(NS_MATERIAL, 'color')]
        .map(c => _hexToColor3(c.getAttribute('color')));
      colorGroups.set(cg.getAttribute('id'), cols);
      colorAlphas.set(cg.getAttribute('id'), [...cg.getElementsByTagNameNS(NS_MATERIAL, 'color')]
        .map(c => alphaOf(c.getAttribute('color'))));
    }

    // Core base materials (Prusa/MixoTile and many third-party producers).
    for (const group of doc.getElementsByTagName('basematerials')) {
      colorGroups.set(group.getAttribute('id'),
        [...group.getElementsByTagName('base')].map(base => _hexToColor3(base.getAttribute('displaycolor'))));
      colorAlphas.set(group.getAttribute('id'), [...group.getElementsByTagName('base')]
        .map(base => alphaOf(base.getAttribute('displaycolor'))));
    }

    // texture2d id → { path, url } (resolved blob URLs from the OPC zip).
    const textures = new Map();
    for (const t of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2d')) {
      const id = t.getAttribute('id');
      const path = _resolvePackagePath(t.getAttribute('path') || '', cleanPath);
      const url = await _texturePartToUrl(zip, path, t.getAttribute('contenttype') || 'image/png');
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
      geometry: parsed.geometry,
      colorGroups,
      colorAlphas,
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
      if (text == null && !opts.preparsed?.has(cleanPath)) {
        const file = zip?.file(cleanPath);
        if (!file) return null;
        text = zipEntryTextChunks(file);
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
  let placedTriangles = 0;
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
        throw new Error(`3MF: referenced texture ${key.tg.texId} is missing or unreadable`);
      }
    } else {
      const group = key.pid != null ? ctx.colorGroups.get(key.pid) : null;
      mat.diffuseColor = (group && group[key.pindex]) ? group[key.pindex] : greyColor();
      mat.alpha = ctx.colorAlphas.get(key.pid)?.[key.pindex] ?? 1;
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
    const normals = new Float32Array(positions.length);
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);
    mesh.material = material;
    if (parent) mesh.setParent(parent);
    container.meshes.push(mesh);
  };

  const createMeshInstance = (ctx, objectId, obj, matrix, parentNode) => {
    const geometry = ctx.geometry.get(objectId);
    if (!geometry?.positions.length || !geometry.triangles.length) return 0;
    const vertexCount = geometry.positions.length / 3;
    const triangleCount = geometry.triangles.length / 7;
    placedTriangles += triangleCount;
    assertTriangleCapacity(placedTriangles, caps.triangleBudget, '3MF assembly');
    const positions = new Float32Array(geometry.positions.length);
    const unitScale = ctx.unitScale;
    // Same arithmetic as Vector3.TransformCoordinates + fromPrintSpace, without
    // two allocations per vertex (10M-triangle parts have ~5M vertices).
    const m = matrix?.m ?? null;
    for (let i = 0; i < vertexCount; i++) {
      const vx = geometry.positions[i * 3], vy = geometry.positions[i * 3 + 1], vz = geometry.positions[i * 3 + 2];
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
        throw new Error(`3MF: vertex ${i} of object ${objectId} has a non-numeric coordinate`);
      }
      let x = vx * unitScale, y = vy * unitScale, z = vz * unitScale;
      if (m) {                                                           // 3MF-space build/component placement
        const rx = x * m[0] + y * m[4] + z * m[8] + m[12];
        const ry = x * m[1] + y * m[5] + z * m[9] + m[13];
        const rz = x * m[2] + y * m[6] + z * m[10] + m[14];
        const rw = 1 / (x * m[3] + y * m[7] + z * m[11] + m[15]);
        x = rx * rw; y = ry * rw; z = rz * rw;
      }
      positions[i * 3]     = PS[0] * x + PS[1] * y + PS[2] * z;          // 3MF RH Z-up → Babylon LH Y-up
      positions[i * 3 + 1] = PS[3] * x + PS[4] * y + PS[5] * z;
      positions[i * 3 + 2] = PS[6] * x + PS[7] * y + PS[8] * z;
    }

    // Object-level property defaults (3MF Core §4.1: a triangle without
    // `pid` inherits the object's pid/pindex; `p2`/`p3` default to `p1`).
    const objPid = obj.getAttribute('pid');
    const objPindexRaw = parseInt(obj.getAttribute('pindex') || '0', 10);
    const objPindex = Number.isFinite(objPindexRaw) ? objPindexRaw : 0;

    // Triangles grouped by material key, first-seen order. Every entry keeps
    // the file's index order (see winding note below) plus the resolved
    // per-corner property index so textured groups can look up UVs.
    // Two passes over typed arrays (no per-triangle JS objects or arrays):
    // pass 1 assigns each triangle a group and counts, pass 2 packs.
    const keyCache = new Map();                    // pid → Map(p1 → group index)
    const groupList = [];                          // [{ key, count, tris: Int32Array }]
    const triGroup = new Uint32Array(triangleCount);
    const tri = geometry.triangles;
    for (let i = 0; i < triangleCount; i++) {
      const offset = i * 7;
      const a = tri[offset], b = tri[offset + 1], c = tri[offset + 2];
      if (!(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c))
          || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) {
        throw new Error(`3MF: triangle ${i} of object ${objectId} references a vertex outside 0..${vertexCount - 1}`);
      }
      const triPid = tri[offset + 3];
      const pid = triPid >= 0 ? String(triPid) : objPid;
      const rawP1 = tri[offset + 4];
      const p1 = rawP1 >= 0 ? rawP1 : objPindex;
      let byP1 = keyCache.get(pid);
      if (!byP1) { byP1 = new Map(); keyCache.set(pid, byP1); }
      let g = byP1.get(p1);
      if (g === undefined) {
        const key = _triangleMaterialKey(ctx, pid, p1);
        g = groupList.findIndex(e => e.key.str === key.str);
        if (g < 0) { g = groupList.length; groupList.push({ key, count: 0, tris: null }); }
        byP1.set(p1, g);
      }
      triGroup[i] = g;
      groupList[g].count++;
    }
    const singleSolid = groupList.length === 1 && !groupList[0].key.tg;
    if (!singleSolid) {
      const fillAt = new Uint32Array(groupList.length);
      for (const e of groupList) e.tris = new Int32Array(e.count * 6);
      for (let i = 0; i < triangleCount; i++) {
        const offset = i * 7;
        const g = triGroup[i];
        const rawP1 = tri[offset + 4];
        const p1 = rawP1 >= 0 ? rawP1 : objPindex;
        const p2 = tri[offset + 5];
        const p3 = tri[offset + 6];
        const t = groupList[g].tris;
        const o = fillAt[g]; fillAt[g] += 6;
        t[o] = tri[offset]; t[o + 1] = tri[offset + 1]; t[o + 2] = tri[offset + 2];
        t[o + 3] = p1; t[o + 4] = p2 >= 0 ? p2 : p1; t[o + 5] = p3 >= 0 ? p3 : p1;
      }
    }
    const groups = new Map();   // keyStr → { key, tris: Int32Array [a,b,c,p1,p2,p3, …] }
    for (const e of groupList) groups.set(e.key.str, { key: e.key, tris: e.tris });

    const baseName = _instanceName(obj, objectId, instanceCounts);

    // 3MF triangles are counter-clockwise-outward in a right-handed space.
    // fromPrintSpace is a reflection, which makes the same index order read
    // clockwise — exactly Babylon's convention for a CounterClockWise-flagged
    // (default) mesh in a left-handed scene. So: keep the file's order.

    if (singleSolid) {
      // Fast path for one solid material: keep the original vertex pool.
      // Textured meshes use (vertex, UV) compaction below, even with one material.
      const { key } = groups.values().next().value;
      const indices = new Uint32Array(triangleCount * 3);
      for (let i = 0, t = 0; i < triangleCount; i++, t += 3) {
        indices[t] = tri[i * 7]; indices[t + 1] = tri[i * 7 + 1]; indices[t + 2] = tri[i * 7 + 2];
      }
      const mesh = new BABYLON.Mesh(baseName, scene);
      finishMesh(mesh, positions, indices, null, makeMaterial(ctx, mesh.name, key), parentNode);
      return 1;
    }

    // Multi-material object — per-triangle `pid`/`p1` mixing several
    // property entries (our own writer does this for a logical unit made of
    // per-material sibling meshes; third-party files do it over one vertex
    // pool). One-mesh-one-shader (AGENTS.md rule 7): emit ONE Babylon mesh
    // per material key, each with a compacted vertex buffer, all parented to
    // a shared TransformNode and stamped with one sourceGroupId so
    // AssetRegistration / the validator treat them as ONE logical object.
    const multiple = groups.size > 1;
    const node = multiple ? new BABYLON.TransformNode(baseName, scene) : parentNode;
    if (multiple) {
      node.metadata = { ...(node.metadata ?? {}), threeMFObjectId: objectId, importHierarchy: true };
      if (parentNode) node.setParent(parentNode);
      container.transformNodes.push(node);
    }
    const sourceGroupId = `3mf:${ctx.path}:${objectId}:${++_splitSeq}`;

    let k = 0;
    for (const { key, tris } of groups.values()) {
      // Source vertex (+ tex2coord for textured) → compact index, in typed
      // arrays: a per-vertex head plus a chain of (coord, out index) entries,
      // so a 10M-triangle textured part makes no per-corner strings or Maps.
      // Textured groups key on (vertex, coord) so a UV seam at a shared vertex
      // splits exactly as the file describes it; solid groups key on the vertex.
      const textured = !!key.tg;
      const co = key.tg?.coords;
      const corners = tris.length / 2;
      const head = new Int32Array(vertexCount).fill(-1);
      const entCoord = textured ? new Int32Array(corners) : null;
      const entNext = textured ? new Int32Array(corners) : null;
      const entOut = textured ? new Int32Array(corners) : null;
      let entries = 0;
      let outCount = 0;
      const outVertex = new Int32Array(corners);   // compact index → source vertex
      const outCoordIdx = textured ? new Int32Array(corners) : null;
      const subIndices = new Uint32Array(corners);
      const compact = (v, p) => {
        if (!textured) {
          let idx = head[v];
          if (idx < 0) { idx = outCount++; head[v] = idx; outVertex[idx] = v; }
          return idx;
        }
        for (let e = head[v]; e >= 0; e = entNext[e]) if (entCoord[e] === p) return entOut[e];
        const idx = outCount++;
        outVertex[idx] = v;
        outCoordIdx[idx] = p;
        entCoord[entries] = p; entOut[entries] = idx; entNext[entries] = head[v]; head[v] = entries++;
        return idx;
      };
      for (let i = 0, t = 0; i < tris.length; i += 6, t += 3) {
        subIndices[t]     = compact(tris[i],     tris[i + 3]);
        subIndices[t + 1] = compact(tris[i + 1], tris[i + 4]);
        subIndices[t + 2] = compact(tris[i + 2], tris[i + 5]);
      }
      const subPositions = new Float32Array(outCount * 3);
      const subUvs = textured ? new Float32Array(outCount * 2) : null;
      for (let o = 0; o < outCount; o++) {
        const v = outVertex[o];
        subPositions[o * 3] = positions[v * 3]; subPositions[o * 3 + 1] = positions[v * 3 + 1]; subPositions[o * 3 + 2] = positions[v * 3 + 2];
        if (subUvs) { const uv = co[outCoordIdx[o]]; subUvs[o * 2] = uv ? uv.u : 0; subUvs[o * 2 + 1] = uv ? uv.v : 0; }
      }
      const mesh = new BABYLON.Mesh(multiple ? `${baseName}__mat${k}` : baseName, scene);
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

  // `ref` = 'item' | 'component': a dangling reference throws rather than
  // silently dropping the part — a partial assembly is a wrong print with no
  // notice (audit F10).
  const instantiateObject = async (ctx, objectId, matrix, parentNode, ref, stack = new Set()) => {
    const stackKey = `${ctx?.path || 'model'}:${objectId}`;
    if (stack.has(stackKey)) throw new Error(`3MF: component cycle at object ${objectId}`);
    const obj = ctx?.objectsById.get(objectId);
    if (!obj) throw new Error(`3MF: ${ref} references missing object "${objectId}" in ${ctx?.path || 'model'}`);
    const nextStack = new Set(stack);
    nextStack.add(stackKey);
    const meshEl = _firstDirect(obj, 'mesh');
    if (meshEl) return createMeshInstance(ctx, objectId, obj, matrix, parentNode);

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
      let childCtx = ctx;
      if (childPath) {
        const resolved = _resolvePackagePath(childPath, ctx.path);
        childCtx = await loadContext(resolved);
        if (!childCtx) throw new Error(`3MF: component path "${childPath}" not found in package`);
      }
      const childMatrix = _multiplyMatrices(matrix, _matrixFor(component, 'component'));
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
  const buildItems = buildEl ? _directChildren(buildEl, 'item') : [];
  const placements = buildItems.length
    ? buildItems.map(it => ({ id: it.getAttribute('objectid'), matrix: _matrixFor(it, 'item') }))
    : [...rootContext.objectsById.keys()].map(id => ({ id, matrix: BABYLON.Matrix.Identity() }));

  for (const placement of placements) {
    made += await instantiateObject(rootContext, placement.id, placement.matrix, null, 'item');
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

/** Open the package and enforce Decision 19 zip caps before any entry is read. */
async function _openZip(JSZip, data, limits = IMPORT_LIMITS) {
  assertImportFileSize(data?.byteLength, '3MF file', limits);
  const zip = await JSZip.loadAsync(data);
  assertZipSafe(zip, '3MF file', limits);
  return zip;
}

/** Register the `.3mf` SceneLoader plugin exactly once. Idempotent. */
export function registerThreeMFLoader() {
  if (_registered || !BABYLON?.SceneLoader?.RegisterPlugin) return;
  _registered = true;

  const parse = async (scene, data) => {
    const { default: JSZip } = await import('jszip');
    const zip = await _openZip(JSZip, data);          // data = ArrayBuffer (isBinary)
    // zip is threaded into _buildContainer so the Materials Extension path
    // can read embedded PNG texture parts directly out of the OPC package.
    const model = await _findModelXml(zip);
    return _buildContainer(scene, zip, model.source, { modelPath: model.path });
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
  openZip: _openZip,
};
