/**
 * OBJ + MTL serializer (+ optional solid-color PNG synthesis for Mimaki).
 *
 * Format-specific code that used to sit inside PrintManager. The orchestrator
 * (PrintPipeline) calls `serializeOBJ(ctx)` and gets back the entries to
 * package; everything OBJ-shaped — MTL writing, solid PNG fallback, mtllib
 * line rewrite — lives here.
 */

import { getState } from '../StateManager.js';
import { collectTextureExportData, clamp255, hex2 } from './ExportTextures.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

/**
 * Build the OBJ+MTL output payload for the given ExportContext.
 *
 * @param {ExportContext} ctx
 * @returns {Promise<{kind:'zip', mime:string, filename:string, entries:Array}>}
 */
export async function serializeOBJ(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  const {
    blobByFilename: textureBlobs,
    textureFilenameByMaterialName,
  } = await collectTextureExportData(meshes);

  // OBJ-only fallback: every solid-colour material gets a tiny 4×4 RGBA PNG
  // so Mimaki UV-inkjet (texture-first) slicers receive an image even when
  // the artist set a flat diffuse colour with no map. Toggle is off by
  // default; enabling in the Export tab opts into synthesis.
  const bakeSolids = !!getState().print?.objBakeSolidTextures;
  const synth = bakeSolids
    ? await _synthesizeSolidShaderTextures(ctx.meshes)
    : { blobByName: new Map(), filenameByMaterialName: new Map() };
  const filenameByMaterialName = new Map([
    ...textureFilenameByMaterialName,
    ...synth.filenameByMaterialName,
  ]);

  const entries = [];
  if (ctx.individually) {
    for (const unit of ctx.cloneGroups) {
      const meshesForUnit = unit.meshes.map(e => e.mesh);
      const base = perMeshBaseName(ctx, unit.name);
      const objData = BABYLON.OBJExport.OBJ(meshesForUnit, true, base, true);
      entries.push({ path: `${base}.obj`, data: _rewriteObjMtllib(objData, base) });
      entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(unit.meshes, filenameByMaterialName) });
    }
  } else {
    const base = exportBaseName(ctx);
    const objData = BABYLON.OBJExport.OBJ(meshes, true, base, true);
    entries.push({ path: `${base}.obj`, data: _rewriteObjMtllib(objData, base) });
    entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(ctx.meshes, filenameByMaterialName) });
  }

  for (const [filename, blob] of textureBlobs) entries.push({ path: `textures/${filename}`, data: blob });
  for (const [filename, blob] of synth.blobByName) entries.push({ path: `textures/${filename}`, data: blob });
  return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
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
async function _synthesizeSolidShaderTextures(meshList) {
  const blobByName = new Map();
  const filenameByMaterialName = new Map();
  const seenMaterials = new Set();
  for (const { mesh } of meshList) {
    const mat = mesh.material;
    if (!mat) continue;
    if (seenMaterials.has(mat)) continue;
    seenMaterials.add(mat);
    if (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture) continue;
    const c = mat.diffuseColor || mat.albedoColor || mat.baseColor || { r: 0.8, g: 0.8, b: 0.8 };
    const r = clamp255(c.r), g = clamp255(c.g), b = clamp255(c.b);
    const a = clamp255(_safeAlpha01(mat.alpha));
    const hex = `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`;
    const filename = `solid_${hex}.png`;
    const matName = _objMaterialName(mesh);
    if (matName) filenameByMaterialName.set(matName, filename);
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
function _safeAlpha01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function _objMaterialName(mesh) {
  const mat = mesh?.material;
  return String(mat?.id || mat?.name || mesh?.name || 'material');
}

function _mtlColor(mat) {
  return mat?.diffuseColor || mat?.albedoColor || mat?.baseColor || { r: 0.8, g: 0.8, b: 0.8 };
}

function _mtlLineColor(prefix, color) {
  const r = Number(color?.r ?? 0).toFixed(4);
  const g = Number(color?.g ?? 0).toFixed(4);
  const b = Number(color?.b ?? 0).toFixed(4);
  return `${prefix} ${r} ${g} ${b}`;
}

function _buildOBJMtl(meshEntries, filenameByMaterialName) {
  const blocks = [];
  const seen = new Set();
  for (const { mesh } of meshEntries) {
    const mat = mesh.material || {};
    const matName = _objMaterialName(mesh);
    if (seen.has(matName)) continue;
    seen.add(matName);
    const color = _mtlColor(mat);
    const alpha = _safeAlpha01(mat.alpha);
    const lines = [
      `newmtl ${matName}`,
      `Ns ${Number(mat.specularPower ?? 64).toFixed(4)}`,
      'Ni 1.5000',
      `d ${alpha.toFixed(4)}`,
      `Tr ${(1 - alpha).toFixed(4)}`,
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

function _rewriteObjMtllib(objString, base) {
  const desired = `mtllib ${base}.mtl`;
  const text = String(objString);
  if (/^mtllib\s+.+$/m.test(text)) return text.replace(/^mtllib\s+.+$/m, desired);
  return `${desired}\n${text}`;
}
