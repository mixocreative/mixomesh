// 3MF package writers (split from PrintManager.js — review L29).
// Two package shapes, chosen by export content in PrintManager:
//   buildColorGroupEntries    → solid-only: one colour per object via
//                               <m:colorgroup>.
//   buildMaterialsExtEntries  → textured: per-vertex UVs + embedded PNG
//                               textures via the Materials Extension.
// The `.3mf` loader (core/ThreeMFLoader.js) is the exact INVERSE of these
// writers — if either changes shape, mirror the other.
// Task 1.5 package options (ThreeMFWriterOptions, resolved by PrintPipeline):
// split-by-material parts (`<components>` parent → loader's TransformNode
// path), model `<metadata>` (loader ignores), `Metadata/thumbnail.png` (loader
// follows only the 3dmodel rel), colorgroup alpha (loader accepts #RRGGBBAA).
// Task 1.11 flavour switch: `options.flavour === 'bambu'` forces split-by-
// material, wraps EVERY logical object as parent + parts (Bambu's object →
// part model), flattens group hierarchy (Bambu has one object level) and
// hands the package to ThreeMFBambu.js (p:UUID, Metadata/*.config, plate
// thumbnail). 'core' / 'prusa' (Prusa stays core for now) = the 1.5 package.

import { collectMimakiTextures, clamp255, hex2 } from './ExportTextures.js';
import { materialSrgbColor } from '../shaders/ColorSpace.js';
import { positionsToPrintSpace, printIndices } from './PrintSpace.js';
import { applyBambuFlavour } from './ThreeMFBambu.js';

const BABYLON = window.BABYLON;

// Axis + winding: Babylon (left-handed, Y-up) → 3MF (right-handed, Z-up) is
// ONE shared map in PrintSpace.js, verified 2026-09-17 against a
// PrusaSlicer-written 3MF (tests/fixtures/prusa-tetra.3mf). Do not add a
// rotation or a blanket winding flip here — per-mesh winding is decided by
// PrintSpace.printIndices from Babylon's effective side orientation.
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

// Package thumbnail (3MF Core §6.1 / OPC): `Metadata/thumbnail.png`, linked
// from the ROOT rels so slicers / file browsers show a preview.
export const THUMBNAIL_PATH = 'Metadata/thumbnail.png';
export const THUMBNAIL_REL_TYPE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';
const RELS_WITH_THUMBNAIL = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/><Relationship Target="/${THUMBNAIL_PATH}" Id="rel1" Type="${THUMBNAIL_REL_TYPE}"/></Relationships>`;

const TEXTURE_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture';

/**
 * Solid diffuse colour of a mesh's material as 3MF #RRGGBBAA (sRGB). Standard
 * `diffuseColor` is read raw; PBR `albedoColor` is linear and is gamma-encoded
 * by `materialSrgbColor` (Blueprint §10 colour contract). Alpha is `FF`
 * unless `withAlpha` (printer profile `colour.alpha`, task 1.5), in which case
 * it carries the material's `alpha` (absent → opaque).
 */
function _materialHex(mesh, withAlpha = false) {
  const c = materialSrgbColor(mesh.material);
  const rawAlpha = Number(mesh.material?.alpha);
  const a = withAlpha && Number.isFinite(rawAlpha) ? hex2(clamp255(rawAlpha)) : 'FF';
  if (!c) return `#CCCCCC${a}`;
  return `#${hex2(clamp255(c.r))}${hex2(clamp255(c.g))}${hex2(clamp255(c.b))}${a}`;
}

/**
 * Writer options (all optional; PrintPipeline resolves them from ctx.prefs +
 * the selected printer profile — this module never reads state/profiles):
 * @typedef {Object} ThreeMFWriterOptions
 * @property {Object}  [state]           StateManager snapshot (group hierarchy).
 * @property {boolean} [splitByMaterial] Multi-material logical object → one
 *   `<object>` per material part under a `<components>` parent (one build item
 *   per logical object). Off = one merged `<object>` with per-triangle colour.
 * @property {boolean} [alpha]           colorgroup colours carry material alpha.
 * @property {{title?:string, application?:string, creationDate?:string}|null} [metadata]
 *   Model-part `<metadata>` (Title / Application / CreationDate); null = none.
 * @property {Blob|Uint8Array|null} [thumbnailPng] PNG bytes → `Metadata/thumbnail.png`
 *   + root thumbnail relationship; absent = no thumbnail (never an error).
 * @property {'core'|'bambu'|'prusa'} [flavour] 'bambu' → Bambu/Orca package
 *   (ThreeMFBambu.js); anything else = core.
 * @property {(warning:{code:string,message:string}) => void} [onWarning]
 *   Non-fatal export warnings (e.g. more materials than Bambu filament slots).
 */

function _isBambu(options) {
  return options?.flavour === 'bambu';
}

/** Bambu flavour post-pass over a finished core package. */
function _finishFlavour(entries, options, bambuObjects) {
  if (!_isBambu(options)) return entries;
  return applyBambuFlavour(entries, bambuObjects, {
    seed: options.metadata?.title || 'MIXOMESH',
    thumbnailPng: options.thumbnailPng ?? null,
    onWarning: options.onWarning,
  });
}

/** OPC skeleton shared by both package shapes. */
function _packageEntries(modelXml, options, textured) {
  const thumb = options.thumbnailPng ?? null;
  const entries = [
    // PNG default content type whenever the package holds any PNG part.
    { path: '[Content_Types].xml', data: (textured || thumb) ? CONTENT_TYPES_TEXTURED : CONTENT_TYPES },
    { path: '_rels/.rels',         data: thumb ? RELS_WITH_THUMBNAIL : RELS },
    { path: '3D/3dmodel.model',    data: modelXml },
  ];
  if (thumb) entries.push({ path: THUMBNAIL_PATH, data: thumb });
  return entries;
}

/** Filament colorgroup package: [Content_Types] + rels + model XML. */
export function buildColorGroupEntries(meshList, options = {}) {
  const bambuObjects = [];
  const entries = _packageEntries(_buildColorGroupModel(meshList, options, bambuObjects), options, false);
  return _finishFlavour(entries, options, bambuObjects);
}

/** Mimaki Materials-Extension package incl. OPC texture parts + rels. */
export async function buildMaterialsExtEntries(meshList, options = {}) {
  const { blobByPath, pathByMesh } = await collectMimakiTextures(_flattenEntries(meshList), BABYLON, options.state ?? undefined);
  const bambuObjects = [];
  const modelXml = _buildMaterialsExtModel(meshList, pathByMesh, options, bambuObjects);
  const entries = _packageEntries(modelXml, options, true);
  if (blobByPath.size) {
    entries.push({ path: '3D/_rels/3dmodel.model.rels', data: _buildTextureRels(blobByPath) });
    for (const [path, blob] of blobByPath) entries.push({ path, data: blob });
  }
  return _finishFlavour(entries, options, bambuObjects);
}

function _normaliseUnits(list) {
  return (list ?? []).map(entry => {
    if (Array.isArray(entry?.meshes)) {
      return { logicalId: entry.logicalId ?? entry.meshes[0]?.logicalId ?? entry.meshes[0]?.meshId, name: entry.name, meshes: entry.meshes };
    }
    return { logicalId: entry?.logicalId ?? entry?.meshId, name: entry?.name, meshes: [entry] };
  }).filter(unit => unit.meshes.length);
}

function _flattenEntries(list) {
  return _normaliseUnits(list).flatMap(unit => unit.meshes);
}

/**
 * Build the 3MF `3D/3dmodel.model` XML. Each export mesh becomes its own
 * <object> (multi-shell hierarchy preserved, unlike STL's single blob) with a
 * solid colour via the Materials extension colorgroup — exactly the
 * one-colour-per-part model the filament pipeline produces.
 *
 * Vertices arrive world-space millimetre (from `flattenWorld`) in Babylon
 * Y-up; here they're mapped into 3MF Z-up right-handed space
 * (`PrintSpace.toPrintSpace`), each mesh's triangles oriented outward
 * (`PrintSpace.printIndices`), then the whole build is centred on the
 * origin so it lands on the slicer bed. `unit="millimeter"` is literal.
 */
function _xmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _unitId(unit) {
  return unit.logicalId ?? unit.meshes.find(entry => entry.logicalId)?.logicalId
    ?? unit.meshes.find(entry => entry.meshId)?.meshId
    ?? null;
}

/** Model-part `<metadata>` elements (3MF Core §3.4.1 well-known names). */
function _metadataXml(metadata) {
  if (!metadata) return '';
  const rows = [
    ['Title', metadata.title],
    ['Application', metadata.application],
    ['CreationDate', metadata.creationDate],
  ];
  return rows
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => `<metadata name="${name}">${_xmlAttr(value)}</metadata>`)
    .join('');
}

function _meshObjectXml(objId, nameAttr, built) {
  return `<object id="${objId}" type="model"${nameAttr}${built.objectAttrs}>` +
    `<mesh><vertices>${built.vertices}</vertices><triangles>${built.triangles}</triangles></mesh></object>`;
}

/**
 * Emit the resource object(s) for ONE logical unit and record the object id
 * that stands for the unit (the build item / group component target).
 *
 *  - default / single-material: one `<object>` holding the merged mesh
 *    (per-triangle colour when it has several materials) — today's shape.
 *  - `split` and >1 material part (task 1.5): one `<object>` per part, then a
 *    parent `<object name=unit><components>` referencing them at identity
 *    (all parts share the build's centring, so no per-part offset). Slicers
 *    (PrusaSlicer / Bambu / Orca) read this as one object with N parts, each
 *    assignable to its own filament.
 *
 * `buildMesh(unit)` returns `{vertices, triangles, objectAttrs}` or null.
 * `record` (Bambu flavour only): always parent + parts, even for ONE
 * material, and receives `{objectId, name, parts:[{objectId, name, mesh}]}`.
 * @returns {number} next free object id
 */
function _emitUnitObjects({ unit, buildMesh, split, objs, meshObjectIds, objId, record = null }) {
  if (split && (unit.meshes.length > 1 || record)) {
    const parts = [];
    unit.meshes.forEach((entry, k) => {
      const built = buildMesh({ ...unit, meshes: [entry] });
      if (!built) return;
      const partName = entry.name ?? entry.mesh?.name ?? `${unit.name ?? 'part'} ${k + 1}`;
      objs.push(_meshObjectXml(objId, ` name="${_xmlAttr(partName)}"`, built));
      parts.push({ objectId: objId++, name: partName, mesh: entry.mesh });
    });
    if (!parts.length) return objId + 1;
    const components = parts
      .map(p => `<component objectid="${p.objectId}" transform="${THREEMF_IDENTITY}"/>`).join('');
    objs.push(`<object id="${objId}" type="model" name="${_xmlAttr(unit.name ?? '')}"><components>${components}</components></object>`);
    meshObjectIds.set(unit, objId);
    record?.({ objectId: objId, name: unit.name ?? parts[0].name, parts });
    return objId + 1;
  }
  const built = buildMesh(unit);
  if (!built) return objId + 1;
  objs.push(_meshObjectXml(objId, '', built));
  meshObjectIds.set(unit, objId);
  return objId + 1;
}

/**
 * Bambu flavour: collect `{objectId, name, parts:[{objectId, name, key, colour}]}`
 * per build object (key = material identity for the extruder slot map).
 * Null for every other flavour.
 */
function _bambuRecorder(options, bambuObjects, materialOf) {
  if (!_isBambu(options)) return null;
  return ({ objectId, name, parts }) => {
    bambuObjects.push({
      objectId, name,
      parts: parts.map(p => ({ objectId: p.objectId, name: p.name, ...materialOf(p.mesh) })),
    });
  };
}

function _hierarchyPlan(units, state, meshObjectIds) {
  const scene = state?.scene;
  const groups = scene?.groups ?? {};
  const objects = scene?.objects ?? {};
  const includedGroups = new Set();
  const unitParent = new Map();

  for (const unit of units) {
    if (!meshObjectIds.has(unit)) continue;
    const id = _unitId(unit);
    const parentId = id ? objects[id]?.parentId ?? null : null;
    unitParent.set(unit, parentId);
    let cursor = parentId;
    const seen = new Set();
    while (cursor && groups[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      includedGroups.add(cursor);
      cursor = groups[cursor].parentId ?? null;
    }
  }
  if (!includedGroups.size) return null;
  return {
    groups,
    includedGroups,
    orderedGroupIds: Object.keys(groups).filter(id => includedGroups.has(id)),
    unitParent,
  };
}

function _componentResourceOrder(plan) {
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  const childGroupsByParent = new Map();
  for (const group of Object.values(plan.groups)) {
    if (!plan.includedGroups.has(group.id)) continue;
    const parentId = group.parentId ?? null;
    if (!childGroupsByParent.has(parentId)) childGroupsByParent.set(parentId, []);
    childGroupsByParent.get(parentId).push(group.id);
  }

  const visit = (groupId) => {
    if (!plan.includedGroups.has(groupId) || visited.has(groupId)) return;
    if (visiting.has(groupId)) throw new Error(`Invalid hierarchy: component cycle at "${groupId}"`);
    visiting.add(groupId);
    for (const childId of childGroupsByParent.get(groupId) ?? []) visit(childId);
    visiting.delete(groupId);
    visited.add(groupId);
    order.push(groupId);
  };

  for (const groupId of plan.orderedGroupIds) visit(groupId);
  return order;
}

function _appendComponentHierarchy({ objs, items, units, state, meshObjectIds, nextObjectId }) {
  const plan = _hierarchyPlan(units, state, meshObjectIds);
  if (!plan) {
    for (const objectId of meshObjectIds.values()) {
      items.push(`<item objectid="${objectId}" transform="${THREEMF_IDENTITY}"/>`);
    }
    return nextObjectId;
  }

  const groupObjectIds = new Map();
  for (const groupId of plan.orderedGroupIds) groupObjectIds.set(groupId, nextObjectId++);

  for (const groupId of _componentResourceOrder(plan)) {
    const group = plan.groups[groupId];
    const components = [];
    for (const childGroup of Object.values(plan.groups)) {
      if ((childGroup.parentId ?? null) === groupId && groupObjectIds.has(childGroup.id)) {
        components.push(`<component objectid="${groupObjectIds.get(childGroup.id)}" transform="${THREEMF_IDENTITY}"/>`);
      }
    }
    for (const unit of units) {
      if ((plan.unitParent.get(unit) ?? null) === groupId && meshObjectIds.has(unit)) {
        components.push(`<component objectid="${meshObjectIds.get(unit)}" transform="${THREEMF_IDENTITY}"/>`);
      }
    }
    objs.push(`<object id="${groupObjectIds.get(groupId)}" type="model" name="${_xmlAttr(group?.name ?? groupId)}"><components>${components.join('')}</components></object>`);
  }

  for (const groupId of plan.orderedGroupIds) {
    const parentId = plan.groups[groupId]?.parentId ?? null;
    if (!plan.includedGroups.has(parentId)) {
      items.push(`<item objectid="${groupObjectIds.get(groupId)}" transform="${THREEMF_IDENTITY}"/>`);
    }
  }
  for (const unit of units) {
    const parentId = plan.unitParent.get(unit) ?? null;
    if (!plan.includedGroups.has(parentId) && meshObjectIds.has(unit)) {
      items.push(`<item objectid="${meshObjectIds.get(unit)}" transform="${THREEMF_IDENTITY}"/>`);
    }
  }
  return nextObjectId;
}

function _buildColorGroupModel(list, options = {}, bambuObjects = []) {
  const units = _normaliseUnits(list);
  const flat = _flattenEntries(units);
  const hexOf = mesh => _materialHex(mesh, !!options.alpha);
  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of flat) {
    const hex = hexOf(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }

  const { converted, cx, cy, cz } = _convertVertices(flat);

  const objs = [];
  const items = [];
  const meshObjectIds = new Map();
  let objId = 2;                                  // id 1 = colorgroup
  const buildMesh = u => _buildUnitColorMeshXml(u, converted, cx, cy, cz, colorIndex, hexOf);
  const record = _bambuRecorder(options, bambuObjects, mesh => {
    const hex = hexOf(mesh);
    return { key: hex, colour: hex };
  });
  for (const unit of units) {
    objId = _emitUnitObjects({ unit, buildMesh, split: !!options.splitByMaterial || !!record, objs, meshObjectIds, objId, record });
  }
  // Bambu: flat build (one object level) — group hierarchy is not emitted.
  _appendComponentHierarchy({ objs, items, units, state: record ? null : options.state, meshObjectIds, nextObjectId: objId });

  const colorXml = colors.map(c => `<m:color color="${c}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
${_metadataXml(options.metadata)}<resources><m:colorgroup id="1">${colorXml}</m:colorgroup>${objs.join('')}</resources>
<build>${items.join('')}</build>
  </model>`;
}

function _buildUnitColorMeshXml(unit, converted, cx, cy, cz, colorIndex, hexOf) {
  const single = unit.meshes.length === 1;
  let vertices = '';
  let triangles = '';
  let vertexOffset = 0;
  let objectAttrs = '';

  for (const { mesh } of unit.meshes) {
    const pos = converted.get(mesh);
    const idx = printIndices(mesh);   // outward in 3MF's right-handed space
    if (!pos || idx.length === 0) continue;
    for (let i = 0; i < pos.length; i += 3) {
      vertices += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    const pidx = colorIndex.get(hexOf(mesh)) ?? 0;
    if (single) objectAttrs = ` pid="1" pindex="${pidx}"`;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] + vertexOffset;
      const b = idx[i + 1] + vertexOffset;
      const c = idx[i + 2] + vertexOffset;
      triangles += single
        ? `<triangle v1="${a}" v2="${b}" v3="${c}"/>`
        : `<triangle v1="${a}" v2="${b}" v3="${c}" pid="1" p1="${pidx}" p2="${pidx}" p3="${pidx}"/>`;
    }
    vertexOffset += pos.length / 3;
  }

  return triangles ? { vertices, triangles, objectAttrs } : null;
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
    const out = positionsToPrintSpace(p);
    for (let i = 0; i < out.length; i += 3) {
      const x = out[i], y = out[i + 1], z = out[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    converted.set(mesh, out);
  }
  return {
    converted,
    cx: Number.isFinite(mnx) ? (mnx + mxx) / 2 : 0,
    cy: Number.isFinite(mny) ? (mny + mxy) / 2 : 0,
    // Z is UP in 3MF: rest the build on the bed (min z → 0) instead of
    // centring it, which put half the part below the plate.
    cz: Number.isFinite(mnz) ? mnz : 0,
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
 *       <m:color color="#RRGGBBAA"/> × distinct (AA = FF unless options.alpha)
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
function _buildMaterialsExtModel(list, pathByMesh, options = {}, bambuObjects = []) {
  const units = _normaliseUnits(list);
  const flat = _flattenEntries(units);
  // Pass 1: assign resource ids, gather distinct solid colours.
  let nextId = 1;
  const tex2dIdByPath = new Map();
  for (const p of new Set([...pathByMesh.values()])) tex2dIdByPath.set(p, nextId++);

  const tex2dGroupIdByMesh = new Map();
  for (const { mesh } of flat) if (pathByMesh.has(mesh)) tex2dGroupIdByMesh.set(mesh, nextId++);

  const hexOf = mesh => _materialHex(mesh, !!options.alpha);
  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of flat) {
    if (pathByMesh.has(mesh)) continue;
    const hex = hexOf(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }
  const colorGroupId = colors.length ? nextId++ : null;

  // Pass 2: rotate vertices into 3MF space and find union bounds.
  const { converted, cx, cy, cz } = _convertVertices(flat);

  // Resources — texture2d.
  const tex2dXml = [...tex2dIdByPath.entries()]
    .map(([path, id]) => `<m:texture2d id="${id}" path="/${path}" contenttype="image/png"/>`)
    .join('');

  // Resources — texture2dgroup (one per textured mesh, coord per vertex).
  const tex2dGroupXmls = [];
  for (const { mesh } of flat) {
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
  const meshObjectIds = new Map();
  let objId = nextId;
  const buildMesh = u => _buildUnitMaterialsMeshXml(
    u, converted, cx, cy, cz,
    tex2dGroupIdByMesh, colorGroupId, colorIndex, hexOf
  );
  const record = _bambuRecorder(options, bambuObjects, mesh => {
    const hex = hexOf(mesh);
    return { key: pathByMesh.has(mesh) ? `tex:${pathByMesh.get(mesh)}` : hex, colour: hex };
  });
  for (const unit of units) {
    objId = _emitUnitObjects({ unit, buildMesh, split: !!options.splitByMaterial || !!record, objs, meshObjectIds, objId, record });
  }
  _appendComponentHierarchy({ objs, items, units, state: record ? null : options.state, meshObjectIds, nextObjectId: objId });

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
${_metadataXml(options.metadata)}<resources>${tex2dXml}${tex2dGroupXmls.join('')}${colorXml}${objs.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
}

function _buildUnitMaterialsMeshXml(unit, converted, cx, cy, cz, tex2dGroupIdByMesh, colorGroupId, colorIndex, hexOf) {
  const single = unit.meshes.length === 1;
  let vertices = '';
  let triangles = '';
  let vertexOffset = 0;
  let objectAttrs = '';

  for (const { mesh } of unit.meshes) {
    const pos = converted.get(mesh);
    const idx = printIndices(mesh);   // outward in 3MF's right-handed space
    if (!pos || idx.length === 0) continue;
    for (let i = 0; i < pos.length; i += 3) {
      vertices += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    const texGroupId = tex2dGroupIdByMesh.get(mesh);
    const solidPidx = colorIndex.get(hexOf(mesh)) ?? 0;
    if (single) {
      // 3MF Core §4.1: `pindex` is REQUIRED whenever `pid` is present, even
      // for a texture2dgroup (strict consumers such as lib3mf reject it).
      if (texGroupId) objectAttrs = ` pid="${texGroupId}" pindex="0"`;
      else if (colorGroupId != null) objectAttrs = ` pid="${colorGroupId}" pindex="${solidPidx}"`;
    }
    for (let i = 0; i < idx.length; i += 3) {
      const localA = idx[i];
      const localB = idx[i + 1];
      const localC = idx[i + 2];
      const a = localA + vertexOffset;
      const b = localB + vertexOffset;
      const c = localC + vertexOffset;
      if (single) {
        triangles += texGroupId
          ? `<triangle v1="${a}" v2="${b}" v3="${c}" p1="${localA}" p2="${localB}" p3="${localC}"/>`
          : `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
      } else if (texGroupId) {
        triangles += `<triangle v1="${a}" v2="${b}" v3="${c}" pid="${texGroupId}" p1="${localA}" p2="${localB}" p3="${localC}"/>`;
      } else if (colorGroupId != null) {
        triangles += `<triangle v1="${a}" v2="${b}" v3="${c}" pid="${colorGroupId}" p1="${solidPidx}" p2="${solidPidx}" p3="${solidPidx}"/>`;
      } else {
        triangles += `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
      }
    }
    vertexOffset += pos.length / 3;
  }

  return triangles ? { vertices, triangles, objectAttrs } : null;
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
