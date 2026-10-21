/**
 * OBJ + MTL serializer (+ optional solid-color PNG synthesis for Mimaki).
 *
 * Format-specific code that used to sit inside PrintManager. The orchestrator
 * (PrintPipeline) calls `serializeOBJ(ctx)` and gets back the entries to
 * package; everything OBJ-shaped — geometry text, MTL writing, solid PNG
 * fallback — lives here.
 *
 * Geometry goes through PrintSpace like every other writer
 * (positionsToPrintSpace + printIndices: right-handed, Z-up, mm, outward),
 * then — when the axis is 'y-up' (Wavefront convention, the Mimaki default)
 * — through the proper rotation PrintSpace.zUpToYUp. Axis source:
 * `ctx.prefs.objAxis`, else the target printer's `export.obj.axis`, else
 * 'y-up'. UVs are written raw (bottom-left origin, TextureReadback
 * contract); MTL / texture packaging is axis-independent.
 */

import { collectTextureExportData, clamp255, hex2 } from './ExportTextures.js';
import { materialSrgbColor } from '../shaders/ColorSpace.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { positionsToPrintSpace, printIndices, bufferZUpToYUp } from './PrintSpace.js';
import { getPrinterProfile, PRINTER_OBJ_AXES } from './PrinterProfiles.js';
import { isFaceted } from '../scene/FlatShading.js';

const DEFAULT_OBJ_AXIS = 'y-up';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

/**
 * Build the OBJ+MTL output payload for the given ExportContext.
 *
 * @param {ExportContext} ctx
 * @returns {Promise<{kind:'zip', mime:string, filename:string, entries:Array}>}
 */
export async function serializeOBJ(ctx) {
  // Entries (not bare meshes): Decision 17 names a texture after its owning
  // logical object (`<object>_<slot>.png`), which only the entry knows.
  const {
    blobByFilename: textureBlobs,
    filenameByMesh: textureFilenameByMesh,
  } = await collectTextureExportData(ctx.meshes, ctx.state);
  const materialNames = _objMaterialNames(ctx.meshes);
  // Key by the SAME token the MTL `newmtl` / OBJ `usemtl` lines use, so
  // `map_Kd` always resolves — a raw `Base Color` key used to miss the
  // `Base_Color` lookup and silently drop the map.
  const textureFilenameByMaterialName = new Map();
  for (const [mesh, filename] of textureFilenameByMesh) {
    textureFilenameByMaterialName.set(materialNames.get(mesh.material ?? mesh), filename);
  }

  // OBJ-only fallback: every solid-colour material gets a tiny 4×4 RGBA PNG
  // so Mimaki UV-inkjet (texture-first) slicers receive an image even when
  // the artist set a flat diffuse colour with no map. Toggle is off by
  // default; enabling in the Export tab opts into synthesis. Read from the
  // ctx — the orchestrator captured the flag at ctx-build time so preview
  // and actual export cannot disagree if the user toggles mid-flight.
  const bakeSolids = !!ctx.prefs?.objBakeSolidTextures;
  const synth = bakeSolids
    ? await _synthesizeSolidShaderTextures(ctx.meshes, materialNames)
    : { blobByName: new Map(), filenameByMaterialName: new Map() };
  const filenameByMaterialName = new Map([
    ...textureFilenameByMaterialName,
    ...synth.filenameByMaterialName,
  ]);

  const axis = resolveObjAxis(ctx);
  const entries = [];
  // One token names the .obj/.mtl entries AND the `mtllib` line: a space
  // (incl. U+3000) kept in the entry path but `_` in `mtllib` left slicers
  // with no MTL and a grey model (cia C-02).
  if (ctx.individually) {
    // Unique (case-insensitively) BEFORE encoding: the zip packager's later
    // rename of `P_cube.obj` to `P_cube_2.obj` cannot reach the `mtllib` line
    // already written inside it, so `Cube` and `cube` swapped MTLs (cia C-08).
    const taken = new Set();
    for (const unit of ctx.cloneGroups) {
      const stem = objToken(perMeshBaseName(ctx, unit.name));
      let base = stem;
      for (let n = 2; taken.has(base.toLowerCase()); n++) base = `${stem}_${n}`;
      taken.add(base.toLowerCase());
      entries.push({ path: `${base}.obj`, data: encodeOBJ(unit.meshes, { axis, mtllib: base, materialNames }) });
      entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(unit.meshes, materialNames, filenameByMaterialName) });
    }
  } else {
    const base = objToken(exportBaseName(ctx));
    entries.push({ path: `${base}.obj`, data: encodeOBJ(ctx.meshes, { axis, mtllib: base, materialNames }) });
    entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(ctx.meshes, materialNames, filenameByMaterialName) });
  }

  for (const [filename, blob] of textureBlobs) entries.push({ path: `textures/${filename}`, data: blob });
  for (const [filename, blob] of synth.blobByName) entries.push({ path: `textures/${filename}`, data: blob });
  return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
}

/**
 * OBJ up-axis for this export: `ctx.prefs.objAxis`, else the target
 * printer profile's `export.obj.axis`, else 'y-up'. Unknown values fall
 * through to the next source.
 * @param {ExportContext} ctx
 * @returns {'y-up'|'z-up'}
 */
export function resolveObjAxis(ctx) {
  const pref = ctx?.prefs?.objAxis;
  if (PRINTER_OBJ_AXES.includes(pref)) return pref;
  const profileAxis = getPrinterProfile(ctx?.state?.print?.targetPrinterId ?? null)?.export?.obj?.axis;
  if (PRINTER_OBJ_AXES.includes(profileAxis)) return profileAxis;
  return DEFAULT_OBJ_AXIS;
}

/**
 * Encode meshes as ONE Wavefront OBJ text (positions in mm, flattened world).
 * One `o` block per mesh; `v`/`vt`/`vn` share each mesh's vertex indexing.
 * @param {Array<{mesh:object}>} meshEntries
 * @param {{axis?:'y-up'|'z-up', mtllib?:string, materialNames?:Map<object,string>}} [opts]
 *   `materialNames`: the whole export's material-token table (default: built from `meshEntries`).
 * @returns {string}
 */
export function encodeOBJ(meshEntries, { axis = DEFAULT_OBJ_AXIS, mtllib = null, materialNames = _objMaterialNames(meshEntries) } = {}) {
  const yUp = axis !== 'z-up';
  const lines = [];
  if (mtllib != null) lines.push(`mtllib ${objToken(mtllib)}.mtl`);
  lines.push(`# mixomesh export: millimetres, right-handed, ${yUp ? 'Y-up' : 'Z-up'}`);
  let vBase = 0, vtBase = 0;
  meshEntries.forEach(({ mesh }, j) => {
    const raw = mesh.getVerticesData?.('position');
    const idx = printIndices(mesh);
    if (!raw || !idx.length) return;
    const count = raw.length / 3;
    for (const i of idx) {
      if (!(i >= 0 && i < count)) throw new Error(`ObjWriter: triangle index out of range in "${mesh.name ?? '?'}"`);
    }
    const zPos = positionsToPrintSpace(raw);
    const pos = yUp ? bufferZUpToYUp(zPos) : zPos;
    // A faceted mesh (welded STL, Boolean result) writes no `vn`: its stored
    // normals are smooth, and OBJ consumers then use face normals — the look
    // the print has (review I1 / M10). Decided by the MESH only; the Smooth
    // shading view toggle never changes exported files (re-review minor 1).
    const nRaw = isFaceted(mesh) ? null : mesh.getVerticesData?.('normal');
    const zNrm = nRaw && nRaw.length === count * 3 ? positionsToPrintSpace(nRaw) : null;
    const nrm = zNrm && yUp ? bufferZUpToYUp(zNrm) : zNrm;
    const uvRaw = mesh.getVerticesData?.('uv');
    const uv = uvRaw && uvRaw.length === count * 2 ? uvRaw : null;

    lines.push(`o ${objToken(mesh.name || `mesh${j}`)}`);
    if (mesh.material) lines.push(`usemtl ${materialNames.get(mesh.material)}`);
    for (let i = 0; i < pos.length; i += 3) lines.push(`v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}`);
    if (uv) for (let i = 0; i < uv.length; i += 2) lines.push(`vt ${uv[i]} ${uv[i + 1]}`);
    if (nrm) for (let i = 0; i < nrm.length; i += 3) lines.push(`vn ${nrm[i]} ${nrm[i + 1]} ${nrm[i + 2]}`);
    const corner = (i) => {
      const v = vBase + i + 1;
      if (uv && nrm) return `${v}/${vtBase + i + 1}/${v}`;
      if (uv) return `${v}/${vtBase + i + 1}`;
      if (nrm) return `${v}//${v}`;
      return `${v}`;
    };
    for (let t = 0; t + 2 < idx.length; t += 3) {
      lines.push(`f ${corner(idx[t])} ${corner(idx[t + 1])} ${corner(idx[t + 2])}`);
    }
    vBase += count;
    if (uv) vtBase += count;
  });
  return `${lines.join('\n')}\n`;
}

// ── solid-colour PNG synthesis ─────────────────────────────

/**
 * Synthesise a 4×4 RGBA PNG per solid-colour material. Tiled sampling means a
 * 4×4 is acceptable for any UV (or none). Alpha = `material.alpha × 255` is
 * also written to the MTL `d` line so legacy slicers (which ignore PNG α)
 * see the same opacity.
 *
 * Dedup key is `${HEX_RRGGBBAA}` — one blob per unique (rgb, α) tuple.
 */
async function _synthesizeSolidShaderTextures(meshList, materialNames) {
  const blobByName = new Map();
  const filenameByMaterialName = new Map();
  const seenMaterials = new Set();
  for (const { mesh } of meshList) {
    const mat = mesh.material;
    if (!mat) continue;
    if (seenMaterials.has(mat)) continue;
    seenMaterials.add(mat);
    if (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture) continue;
    const c = _mtlColor(mat);
    const r = clamp255(c.r), g = clamp255(c.g), b = clamp255(c.b);
    const a = clamp255(_safeAlpha01(mat.alpha));
    const hex = `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`;
    const filename = `solid_${hex}.png`;
    filenameByMaterialName.set(materialNames.get(mat), filename);
    if (!blobByName.has(filename)) {
      try { blobByName.set(filename, await _solidColorBlob(r, g, b, a)); }
      catch (err) { console.error(`Solid PNG synthesis failed for ${hex}:`, err); }
    }
  }
  return { blobByName, filenameByMaterialName };
}

async function _solidColorBlob(r, g, b, a) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 4; canvas.height = 4;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) throw new Error('Failed to get canvas context');
      const imageData = ctx2d.createImageData(4, 4);
      const px = imageData.data;
      for (let i = 0; i < 16; i++) {
        px[i * 4]     = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = a;
      }
      ctx2d.putImageData(imageData, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('toBlob produced no blob')); return; }
        resolve(blob);
      }, 'image/png');
    } catch (err) { reject(err); }
  });
}

// Treat null/undefined/NaN alpha as fully opaque so PNG α and MTL d agree.
// Number(null) === 0 (finite!), so a bare isFinite check would let null
// become transparent — the explicit nullish guard runs FIRST.
function _safeAlpha01(v) {
  if (v == null) return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

// One `newmtl` / `usemtl` token per distinct shader, keyed by the material
// object (or the mesh when it has none; ShaderLibrary holds one material per
// shader). The id is only the token's text: Babylon keeps the source file's
// material name there, so two imported "Paint" shaders share an id and used
// to merge into one MTL colour (cia C-03). Case-insensitive repeats get `_2`.
function _objMaterialNames(meshEntries) {
  const names = new Map();
  const taken = new Set();
  for (const { mesh } of meshEntries ?? []) {
    const key = mesh?.material ?? mesh;
    if (!key || names.has(key)) continue;
    const mat = mesh.material;
    const base = objToken(String(mat?.id ?? mat?.name ?? mesh.name ?? 'material'));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    taken.add(name.toLowerCase());
    names.set(key, name);
  }
  return names;
}

/**
 * Wavefront `o` / `g` / `usemtl` / `newmtl` / `mtllib` arguments are
 * whitespace-delimited tokens. A material id such as `Base Color` becomes
 * `usemtl Base` in most parsers (Mimaki prep tool, MeshLab, Blender) and the
 * texture silently drops. Collapse whitespace to `_`; keep everything else.
 */
export function objToken(name) {
  const t = String(name ?? '').replace(/\s+/g, '_');
  return t || 'material';
}

// MTL colour is sRGB: Standard `diffuseColor` raw, PBR `albedoColor` (linear)
// gamma-encoded once via `materialSrgbColor` (Blueprint §10 colour contract).
function _mtlColor(mat) {
  return materialSrgbColor(mat) || { r: 0.8, g: 0.8, b: 0.8 };
}

function _mtlLineColor(prefix, color) {
  const c01 = (v) => Math.max(0, Math.min(1, Number(v ?? 0) || 0)).toFixed(4);
  return `${prefix} ${c01(color?.r)} ${c01(color?.g)} ${c01(color?.b)}`;
}

function _buildOBJMtl(meshEntries, materialNames, filenameByMaterialName) {
  const blocks = [];
  const seen = new Set();
  for (const { mesh } of meshEntries) {
    const mat = mesh.material || {};
    const matName = materialNames.get(mesh.material ?? mesh);
    if (seen.has(matName)) continue;
    seen.add(matName);
    const color = _mtlColor(mat);
    const alpha = _safeAlpha01(mat.alpha);
    const lines = [
      `newmtl ${matName}`,
      `Ns ${Number(mat.specularPower ?? 64).toFixed(4)}`,
      'Ni 1.5000',
      // Opacity as `d` ONLY. `Tr` is read as transparency by some parsers
      // and as opacity by others (Blender historically); writing both lets
      // the two disagree on the same material.
      `d ${alpha.toFixed(4)}`,
      'illum 2',
      _mtlLineColor('Ka', mat.ambientColor || { r: 0, g: 0, b: 0 }),
      _mtlLineColor('Kd', color),
      _mtlLineColor('Ks', mat.specularColor || { r: 0, g: 0, b: 0 }),
      _mtlLineColor('Ke', mat.emissiveColor || { r: 0, g: 0, b: 0 }),
    ];
    const map = filenameByMaterialName.get(matName);
    if (map) lines.push(`map_Kd textures/${map}`);
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}
