/**
 * VRML 2.0 (VRML97) serializer.
 *
 * One `Shape` per export clone (one-mesh-one-shader invariant ⇒ one material
 * per Shape), each an `IndexedFaceSet` with `coord` + `coordIndex`, plus
 * `texCoord` + `texCoordIndex` when the clone is textured.
 *
 * Geometry goes through PrintSpace like every other writer
 * (positionsToPrintSpace + printIndices): right-handed, Z-up, millimetres,
 * counter-clockwise-outward (`ccw TRUE`). VRML's nominal Y-up/metre
 * convention is deliberately NOT applied — full-colour print front-ends that
 * read WRL (and this app's other formats) expect the printer's Z-up mm frame,
 * stated in the file header comment.
 *
 * Appearance: textured → `ImageTexture { url "textures/<name>.png" }` with
 * the PNG packaged beside the .wrl in a zip (same `textures/` layout as the
 * OBJ zip) from the export-side bytes ExportTextures hands the 3MF writer
 * (full-res source, fail-closed). UVs are written raw — VRML texture space is
 * bottom-left origin like 3MF, so the TextureReadback.EXPORT_FLIP_Y contract
 * holds unchanged. Solid → `Material { diffuseColor transparency }` in sRGB.
 */

import { collectMimakiTextures } from './ExportTextures.js';
import { materialSrgbColor } from '../shaders/ColorSpace.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { positionsToPrintSpace, printIndices } from './PrintSpace.js';
import { exportUVs } from './UvTransform.js';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

const FALLBACK_RGB = { r: 0.8, g: 0.8, b: 0.8 };

const _num = (v, digits) => String(+Number(v).toFixed(digits));

/** VRML DEF names: ASCII letters/digits/_ only, must not start with a digit. */
export function vrmlName(name) {
  const t = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '_') || 'part';
  return /^[0-9]/.test(t) ? `_${t}` : t;
}

function _alpha01(mat) {
  if (mat?.alpha == null) return 1;
  const n = Number(mat.alpha);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function _shape(mesh, texUrl, usedNames) {
  const raw = mesh.getVerticesData?.('position');
  const idx = printIndices(mesh);
  if (!raw || !idx.length) return '';
  const count = raw.length / 3;
  for (const i of idx) {
    if (!(i >= 0 && i < count)) throw new Error(`WrlWriter: triangle index out of range in "${mesh.name ?? '?'}"`);
  }
  const pos = positionsToPrintSpace(raw);
  const uvs = texUrl ? exportUVs(mesh) : null;
  const textured = !!(uvs && uvs.length === count * 2);

  let def = vrmlName(mesh.name);
  for (let n = 2; usedNames.has(def); n++) def = `${vrmlName(mesh.name)}_${n}`;
  usedNames.add(def);

  const points = [];
  for (let i = 0; i < pos.length; i += 3) points.push(`${_num(pos[i], 5)} ${_num(pos[i + 1], 5)} ${_num(pos[i + 2], 5)}`);
  const faces = [];
  for (let i = 0; i + 2 < idx.length; i += 3) faces.push(`${idx[i]} ${idx[i + 1]} ${idx[i + 2]} -1`);

  const mat = mesh.material;
  const alpha = _alpha01(mat);
  let appearance;
  if (textured) {
    appearance = 'Appearance {\n'
      + '      material Material { diffuseColor 1 1 1 }\n'
      + `      texture ImageTexture { url "${texUrl}" }\n`
      + '    }';
  } else {
    const c = materialSrgbColor(mat) || FALLBACK_RGB;
    const c01 = (v) => _num(Math.max(0, Math.min(1, Number(v) || 0)), 4);
    appearance = 'Appearance {\n'
      + `      material Material { diffuseColor ${c01(c.r)} ${c01(c.g)} ${c01(c.b)} transparency ${_num(1 - alpha, 4)} }\n`
      + '    }';
  }

  let geometry = 'IndexedFaceSet {\n'
    + '      solid TRUE\n      ccw TRUE\n'
    + `      coord Coordinate { point [\n        ${points.join(',\n        ')}\n      ] }\n`
    + `      coordIndex [\n        ${faces.join(',\n        ')}\n      ]\n`;
  if (textured) {
    const tc = [];
    for (let i = 0; i < uvs.length; i += 2) tc.push(`${_num(uvs[i], 6)} ${_num(uvs[i + 1], 6)}`);
    // vertex i ↔ UV i (seams survive: textured clones are never position-only welded)
    geometry += `      texCoord TextureCoordinate { point [\n        ${tc.join(',\n        ')}\n      ] }\n`
      + `      texCoordIndex [\n        ${faces.join(',\n        ')}\n      ]\n`;
  }
  geometry += '    }';
  return `DEF ${def} Shape {\n    appearance ${appearance}\n    geometry ${geometry}\n  }`;
}

/**
 * Encode meshes as one VRML 2.0 document.
 * @param {Array<{mesh:object}>} meshEntries
 * @param {Map<object,string>} [urlByMesh] texture url (relative to the .wrl) per textured mesh
 * @returns {string}
 */
export function encodeVRML(meshEntries, urlByMesh = new Map()) {
  const used = new Set();
  const shapes = meshEntries.map(({ mesh }) => _shape(mesh, urlByMesh.get(mesh) ?? null, used)).filter(Boolean);
  return '#VRML V2.0 utf8\n'
    + '# mixomesh export: units millimetres, right-handed, Z-up (printer frame)\n'
    + `Group {\n  children [\n  ${shapes.join(',\n  ')}\n  ]\n}\n`;
}

/**
 * Pipeline serializer. Textured content → zip (`.wrl` + `textures/*.png`,
 * the OBJ layout); solid-only → a single `.wrl`. Individually → zip of one
 * `.wrl` per logical unit sharing one `textures/` folder (OBJ behaviour).
 * @param {ExportContext} ctx
 */
export async function serializeWRL(ctx) {
  const { blobByPath, pathByMesh } = await collectMimakiTextures(ctx.meshes, window.BABYLON, ctx.state);
  const urlByMesh = new Map();
  const textureEntries = [];
  const urlByPath = new Map();
  for (const [path, blob] of blobByPath) {
    const url = `textures/${path.split('/').pop()}`;
    urlByPath.set(path, url);
    textureEntries.push({ path: url, data: blob });
  }
  for (const [mesh, path] of pathByMesh) urlByMesh.set(mesh, urlByPath.get(path));

  const base = exportBaseName(ctx);
  if (ctx.individually) {
    const entries = ctx.cloneGroups.map(unit => ({
      path: `${perMeshBaseName(ctx, unit.name)}.wrl`, data: encodeVRML(unit.meshes, urlByMesh),
    }));
    return { kind: 'zip', mime: 'application/zip', filename: `${base}.zip`, entries: [...entries, ...textureEntries] };
  }
  const wrl = encodeVRML(ctx.meshes, urlByMesh);
  if (textureEntries.length) {
    return {
      kind: 'zip', mime: 'application/zip', filename: `${base}.zip`,
      entries: [{ path: `${base}.wrl`, data: wrl }, ...textureEntries],
    };
  }
  return { kind: 'blob', mime: 'model/vrml', filename: `${base}.wrl`, data: wrl };
}
