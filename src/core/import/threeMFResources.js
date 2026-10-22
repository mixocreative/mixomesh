// A model part's resources as the loader needs them: unit scale, colour
// groups (Materials extension `m:colorgroup` and Core `basematerials`),
// `m:texture2d` parts as blob URLs and `m:texture2dgroup` UV tables. One
// context per model part; `materialKeyOf` says which resource a triangle's
// property pair resolves to.

import { parseModelXml, objectsById } from './threeMFDom.js';
import { resolvePackagePath } from './threeMFPackage.js';

const BABYLON = window.BABYLON;

export const NS_MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

// 3MF `unit` → millimetres, per 3MF Core §3.4 (default millimeter).
export const UNIT_TO_MM = Object.freeze({
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
});

/** Accept #RRGGBB or #RRGGBBAA (export emits 8-digit upper-case); a bad channel reads mid-grey. */
export function hexToColor3(hex) {
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

const alphaOf = hex => (/^#[0-9a-f]{8}$/i.test(hex || '') ? parseInt(hex.slice(7, 9), 16) / 255 : 1);

// Materials ext ch.6 `tilestyleu/v` → Babylon address mode. The writer emits
// what the viewport sampled (UvTransform.textureAddressing), so a clamped
// texture comes back clamped. `none` (no tiling, nothing drawn outside 0..1)
// has no Babylon mode; clamp is the nearest.
const TILE_STYLE_TO_WRAP = { wrap: 1, mirror: 2, clamp: 0, none: 0 };
const tileStyleOf = (value) => {
  const style = String(value ?? 'wrap').trim().toLowerCase();
  return style in TILE_STYLE_TO_WRAP ? style : 'wrap';
};

/**
 * Read a texture part out of the package and turn it into a blob URL that a
 * Babylon StandardMaterial.diffuseTexture can be constructed from. Returns
 * null on failure, so one bad texture never aborts the whole load.
 */
async function texturePartToUrl(pkg, partPath, contentType = 'image/png') {
  if (!partPath) return null;
  try {
    const u8 = await pkg.partBytes(partPath);
    if (!u8) return null;
    return URL.createObjectURL(new Blob([u8], { type: contentType }));
  } catch { return null; }
}

/**
 * The loader's view of one model part.
 * @param {string} path  clean package path of the part
 * @param {{ xml: string, geometry: Map<string, object> }} parsed  from ThreeMFXml
 * @param {import('./threeMFPackage.js').ThreeMFPackage} pkg
 */
export async function readModelContext(path, parsed, pkg) {
  const doc = parseModelXml(parsed.xml);
  const unitAttr = (doc.documentElement?.getAttribute?.('unit')
    ?? doc.getElementsByTagName('model')[0]?.getAttribute('unit') ?? 'millimeter').trim().toLowerCase();
  const unitScale = UNIT_TO_MM[unitAttr || 'millimeter'];
  if (!unitScale) throw new Error(`3MF: unsupported unit "${unitAttr}" (expected micron|millimeter|centimeter|inch|foot|meter)`);

  // group id → [Color3,…] and → [alpha,…]; export writes colorgroup "1".
  const colorGroups = new Map();
  const colorAlphas = new Map();
  for (const cg of doc.getElementsByTagNameNS(NS_MATERIAL, 'colorgroup')) {
    const cols = [...cg.getElementsByTagNameNS(NS_MATERIAL, 'color')];
    colorGroups.set(cg.getAttribute('id'), cols.map(c => hexToColor3(c.getAttribute('color'))));
    colorAlphas.set(cg.getAttribute('id'), cols.map(c => alphaOf(c.getAttribute('color'))));
  }
  // Core base materials (Prusa/MixoTile and many third-party producers).
  for (const group of doc.getElementsByTagName('basematerials')) {
    const bases = [...group.getElementsByTagName('base')];
    colorGroups.set(group.getAttribute('id'), bases.map(base => hexToColor3(base.getAttribute('displaycolor'))));
    colorAlphas.set(group.getAttribute('id'), bases.map(base => alphaOf(base.getAttribute('displaycolor'))));
  }

  // texture2d id → { path, url, tileStyleU, tileStyleV } (blob URLs resolved from the package).
  const textures = new Map();
  for (const t of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2d')) {
    const texPath = resolvePackagePath(t.getAttribute('path') || '', path);
    const url = await texturePartToUrl(pkg, texPath, t.getAttribute('contenttype') || 'image/png');
    textures.set(t.getAttribute('id'), {
      path: texPath, url,
      tileStyleU: tileStyleOf(t.getAttribute('tilestyleu')), tileStyleV: tileStyleOf(t.getAttribute('tilestylev')),
    });
  }

  // texture2dgroup id → { texId, coords[{u,v}, ...] }
  const texGroups = new Map();
  for (const tg of doc.getElementsByTagNameNS(NS_MATERIAL, 'texture2dgroup')) {
    const coords = [...tg.getElementsByTagNameNS(NS_MATERIAL, 'tex2coord')]
      .map(c => ({ u: parseFloat(c.getAttribute('u')) || 0, v: parseFloat(c.getAttribute('v')) || 0 }));
    texGroups.set(tg.getAttribute('id'), { texId: tg.getAttribute('texid'), coords });
  }

  return { path, doc, unitScale, objectsById: objectsById(doc), geometry: parsed.geometry, colorGroups, colorAlphas, textures, texGroups };
}

/**
 * Material key for one triangle: a texture2dgroup is one material per group
 * (UVs vary per corner, the texture does not); a colorgroup (or any other
 * indexed property resource) is one material per (group, index).
 */
export function materialKeyOf(ctx, pid, pindex) {
  const tg = pid != null ? ctx.texGroups.get(pid) : null;
  if (tg) return { str: `t:${pid}`, pid, pindex: 0, tg };
  return { str: pid != null ? `c:${pid}:${pindex}` : '', pid, pindex, tg: null };
}

/**
 * Material for one triangle-group key (see materialKeyOf), registered in the
 * container. A texture2dgroup key binds the embedded PNG; a colorgroup key
 * resolves the colour; anything else (no property, unknown group) is the grey
 * fallback. `usedTexIds` records `path:texId` for every texture bound.
 */
export function createMaterial(scene, container, ctx, name, key, usedTexIds) {
  const mat = new BABYLON.StandardMaterial(`${name}__3mf`, scene);
  if (key.tg) {
    const tex = ctx.textures.get(key.tg.texId);
    if (!tex?.url) throw new Error(`3MF: referenced texture ${key.tg.texId} is missing or unreadable`);
    // Materials 1.2.1 ch.3: tex2coord (0,0) is the image's LOWER-left
    // corner, so upload with invertY=true (the OBJ/MTL convention), not
    // the glTF top-left one (cia C-01).
    const bt = new BABYLON.Texture(tex.url, scene, false, true);
    bt.name = `${name}__tex`;
    bt.wrapU = TILE_STYLE_TO_WRAP[tex.tileStyleU];
    bt.wrapV = TILE_STYLE_TO_WRAP[tex.tileStyleV];
    mat.diffuseTexture = bt;
    container.textures?.push?.(bt);
    usedTexIds.add(`${ctx.path}:${key.tg.texId}`);
  } else {
    const group = key.pid != null ? ctx.colorGroups.get(key.pid) : null;
    mat.diffuseColor = (group && group[key.pindex]) ? group[key.pindex] : new BABYLON.Color3(0.8, 0.8, 0.8);
    mat.alpha = ctx.colorAlphas.get(key.pid)?.[key.pindex] ?? 1;
  }
  mat.backFaceCulling = false;
  container.materials.push(mat);
  return mat;
}

/** Revoke the blob URLs of texture parts no built object bound (audit LOW #8). */
export function releaseUnusedTextures(ctx, usedTexIds) {
  for (const [tid, tex] of ctx.textures) {
    if (tex.url && !usedTexIds.has(`${ctx.path}:${tid}`)) { try { URL.revokeObjectURL(tex.url); } catch { /* stub URL */ } }
  }
}
