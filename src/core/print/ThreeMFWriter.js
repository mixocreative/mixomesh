// 3MF package writers (split from PrintManager.js — review L29).
// Two package shapes, chosen by export content in PrintManager:
//   buildColorGroupEntries    → solid-only: one colour per object via
//                               <m:colorgroup>.
//   buildMaterialsExtEntries  → textured: per-vertex UVs + embedded PNG
//                               textures via the Materials Extension.
// The `.3mf` loader (core/ThreeMFLoader.js) is the exact INVERSE of these
// writers — if either changes shape, mirror the other.

import { collectMimakiTextures, clamp255, hex2 } from './ExportTextures.js';

const BABYLON = window.BABYLON;

// Babylon is Y-up (and, after the import bake, left-handed). 3MF / slicers
// are Z-up right-handed. This rotation maps Babylon (x,y,z) → 3MF; the
// winding flip restores outward normals for the RH consumer. Both are single
// switches: if a live test shows the model lying down / mirrored, this is the
// one place to adjust (LH↔RH reasoning is unreliable on paper — verify in a
// slicer, same lesson as the nav-cube convention).
const Y_UP_TO_Z_UP = BABYLON.Matrix.RotationX(-Math.PI / 2);
const THREEMF_REVERSE_WINDING = true;
// 3MF 3×4 row-major identity — emitted on every build item so placement is
// driven solely by the baked vertices, never a viewer-guessed transform.
const THREEMF_IDENTITY = '1 0 0 0 1 0 0 0 1 0 0 0';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

// Adds the PNG default content type for the Mimaki textured pipeline.
// Plain colorgroup packages don't carry binaries, so we keep the lean
// version for filament exports and only emit this one when textures are
// in the package.
const CONTENT_TYPES_TEXTURED = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

const TEXTURE_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture';

/** Solid diffuse colour of a mesh's material as 3MF #RRGGBBFF. */
function _materialHex(mesh) {
  const m = mesh.material || {};
  const c = m.diffuseColor || m.albedoColor || m.baseColor;
  if (!c) return '#CCCCCCFF';
  return `#${hex2(clamp255(c.r))}${hex2(clamp255(c.g))}${hex2(clamp255(c.b))}FF`;
}

/** Filament colorgroup package: [Content_Types] + rels + model XML. */
export function buildColorGroupEntries(meshList) {
  return [
    { path: '[Content_Types].xml', data: CONTENT_TYPES },
    { path: '_rels/.rels',         data: RELS },
    { path: '3D/3dmodel.model',    data: _buildColorGroupModel(meshList) },
  ];
}

/** Mimaki Materials-Extension package incl. OPC texture parts + rels. */
export async function buildMaterialsExtEntries(meshList) {
  const { blobByPath, pathByMesh } = await collectMimakiTextures(meshList, BABYLON);
  const modelXml = _buildMaterialsExtModel(meshList, pathByMesh);
  const entries = [
    { path: '[Content_Types].xml', data: CONTENT_TYPES_TEXTURED },
    { path: '_rels/.rels',         data: RELS },
    { path: '3D/3dmodel.model',    data: modelXml },
  ];
  if (blobByPath.size) {
    entries.push({ path: '3D/_rels/3dmodel.model.rels', data: _buildTextureRels(blobByPath) });
    for (const [path, blob] of blobByPath) entries.push({ path, data: blob });
  }
  return entries;
}

/**
 * Build the 3MF `3D/3dmodel.model` XML. Each export mesh becomes its own
 * <object> (multi-shell hierarchy preserved, unlike STL's single blob) with a
 * solid colour via the Materials extension colorgroup — exactly the
 * one-colour-per-part model the filament pipeline produces.
 *
 * Vertices arrive world-space millimetre (from `flattenWorld`) in Babylon
 * Y-up; here they're rotated into 3MF Z-up (`Y_UP_TO_Z_UP`), winding flipped
 * for the right-handed consumer, then the whole build is centred on the
 * origin so it lands on the slicer bed. `unit="millimeter"` is literal.
 */
function _buildColorGroupModel(list) {
  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of list) {
    const hex = _materialHex(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }

  const { converted, cx, cy, cz } = _convertVertices(list);

  const objs = [];
  const items = [];
  let objId = 2;                                  // id 1 = colorgroup
  for (const { mesh } of list) {
    const pos = converted.get(mesh);
    const idx = mesh.getIndices();
    if (!pos || !idx || idx.length === 0) { objId++; continue; }

    let v = '';
    for (let i = 0; i < pos.length; i += 3) {
      v += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    let t = '';
    for (let i = 0; i < idx.length; i += 3) {
      const [b, c] = THREEMF_REVERSE_WINDING ? [idx[i + 2], idx[i + 1]] : [idx[i + 1], idx[i + 2]];
      t += `<triangle v1="${idx[i]}" v2="${b}" v3="${c}"/>`;
    }
    const pidx = colorIndex.get(_materialHex(mesh)) ?? 0;
    objs.push(
      `<object id="${objId}" type="model" pid="1" pindex="${pidx}">` +
      `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`
    );
    // Geometry is fully baked into the vertices (flattenWorld → absolute,
    // origin-centred). The build item therefore carries an EXPLICIT identity
    // matrix (3MF 3×4 row-major) — no viewer/slicer can place the object
    // anywhere but exactly where its vertices say. Placement is consistent
    // across every 3MF consumer.
    items.push(`<item objectid="${objId}" transform="${THREEMF_IDENTITY}"/>`);
    objId++;
  }

  const colorXml = colors.map(c => `<m:color color="${c}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources><m:colorgroup id="1">${colorXml}</m:colorgroup>${objs.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
}

// Pass: rotate every mesh's vertices into 3MF space and find the union
// bounds (for origin-centering) over the *converted* coordinates.
function _convertVertices(list) {
  const converted = new Map();   // mesh → Float32Array (3MF-space xyz)
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const { mesh } of list) {
    const p = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    if (!p) continue;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const w = BABYLON.Vector3.TransformCoordinates(
        new BABYLON.Vector3(p[i], p[i + 1], p[i + 2]), Y_UP_TO_Z_UP);
      out[i] = w.x; out[i + 1] = w.y; out[i + 2] = w.z;
      if (w.x < mnx) mnx = w.x; if (w.x > mxx) mxx = w.x;
      if (w.y < mny) mny = w.y; if (w.y > mxy) mxy = w.y;
      if (w.z < mnz) mnz = w.z; if (w.z > mxz) mxz = w.z;
    }
    converted.set(mesh, out);
  }
  return {
    converted,
    cx: Number.isFinite(mnx) ? (mnx + mxx) / 2 : 0,
    cy: Number.isFinite(mny) ? (mny + mxy) / 2 : 0,
    cz: Number.isFinite(mnz) ? (mnz + mxz) / 2 : 0,
  };
}

/**
 * Build the model XML for the Materials Extension pipeline. Layout:
 *
 *   <resources>
 *     <m:texture2d id="1" path="/3D/Textures/a.png" contenttype="image/png"/>
 *     ...                                                — one per unique texture
 *     <m:texture2dgroup id="N" texid="1">                — one per textured mesh
 *       <m:tex2coord u=".." v=".."/> × verts
 *     </m:texture2dgroup>
 *     <m:colorgroup id="K">                              — only if any solid mesh
 *       <m:color color="#RRGGBBFF"/> × distinct
 *     </m:colorgroup>
 *     <object id="..." type="model" pid="K" pindex="P">  — solid path
 *     <object id="..." type="model" pid="N">             — textured path
 *       <triangle v1=".." v2=".." v3=".." p1=".." p2=".." p3=".."/>
 *   </resources>
 *
 * The texture writer is the exact inverse of the loader's parse path. To
 * keep round-trip trivial we emit ONE <m:tex2coord> per vertex in
 * vertex-order, and every triangle's `p1/p2/p3` index simply re-states its
 * `v1/v2/v3` — vertex i ↔ UV i. Welding is skipped on textured meshes (see
 * PREP_STEPS.weldSolidOnly) so UV seams survive into this writer.
 */
function _buildMaterialsExtModel(list, pathByMesh) {
  // Pass 1: assign resource ids, gather distinct solid colours.
  let nextId = 1;
  const tex2dIdByPath = new Map();
  for (const p of new Set([...pathByMesh.values()])) tex2dIdByPath.set(p, nextId++);

  const tex2dGroupIdByMesh = new Map();
  for (const { mesh } of list) if (pathByMesh.has(mesh)) tex2dGroupIdByMesh.set(mesh, nextId++);

  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of list) {
    if (pathByMesh.has(mesh)) continue;
    const hex = _materialHex(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }
  const colorGroupId = colors.length ? nextId++ : null;

  // Pass 2: rotate vertices into 3MF space and find union bounds.
  const { converted, cx, cy, cz } = _convertVertices(list);

  // Resources — texture2d.
  const tex2dXml = [...tex2dIdByPath.entries()]
    .map(([path, id]) => `<m:texture2d id="${id}" path="/${path}" contenttype="image/png"/>`)
    .join('');

  // Resources — texture2dgroup (one per textured mesh, coord per vertex).
  const tex2dGroupXmls = [];
  for (const { mesh } of list) {
    const groupId = tex2dGroupIdByMesh.get(mesh);
    if (!groupId) continue;
    const texPath = pathByMesh.get(mesh);
    const texId = tex2dIdByPath.get(texPath);
    const uvs = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind) || [];
    let coords = '';
    for (let i = 0; i < uvs.length; i += 2) {
      coords += `<m:tex2coord u="${+uvs[i].toFixed(6)}" v="${+uvs[i + 1].toFixed(6)}"/>`;
    }
    tex2dGroupXmls.push(`<m:texture2dgroup id="${groupId}" texid="${texId}">${coords}</m:texture2dgroup>`);
  }

  // Resources — colorgroup (only when any solid meshes exist).
  const colorXml = colorGroupId
    ? `<m:colorgroup id="${colorGroupId}">${colors.map(c => `<m:color color="${c}"/>`).join('')}</m:colorgroup>`
    : '';

  // Objects + build items.
  const objs = [];
  const items = [];
  let objId = nextId;
  for (const { mesh } of list) {
    const pos = converted.get(mesh);
    const idx = mesh.getIndices();
    if (!pos || !idx || idx.length === 0) { objId++; continue; }

    let v = '';
    for (let i = 0; i < pos.length; i += 3) {
      v += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    let t = '';
    const isTextured = tex2dGroupIdByMesh.has(mesh);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i];
      const [b, c] = THREEMF_REVERSE_WINDING ? [idx[i + 2], idx[i + 1]] : [idx[i + 1], idx[i + 2]];
      // Textured: per-triangle p1/p2/p3 mirror v1/v2/v3 because we emit one
      // tex2coord per vertex in vertex order. The loader inverts this 1:1.
      t += isTextured
        ? `<triangle v1="${a}" v2="${b}" v3="${c}" p1="${a}" p2="${b}" p3="${c}"/>`
        : `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
    }
    let pidAttrs;
    if (isTextured) {
      pidAttrs = ` pid="${tex2dGroupIdByMesh.get(mesh)}"`;
    } else if (colorGroupId != null) {
      const pidx = colorIndex.get(_materialHex(mesh)) ?? 0;
      pidAttrs = ` pid="${colorGroupId}" pindex="${pidx}"`;
    } else {
      pidAttrs = '';
    }
    objs.push(
      `<object id="${objId}" type="model"${pidAttrs}>` +
      `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`
    );
    items.push(`<item objectid="${objId}" transform="${THREEMF_IDENTITY}"/>`);
    objId++;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources>${tex2dXml}${tex2dGroupXmls.join('')}${colorXml}${objs.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
}

/** Per-part rels file. One Relationship per unique texture path. */
function _buildTextureRels(blobByPath) {
  const rels = [];
  let n = 0;
  for (const path of blobByPath.keys()) {
    rels.push(`<Relationship Id="texRel${n}" Target="/${path}" Type="${TEXTURE_REL_TYPE}"/>`);
    n++;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}
