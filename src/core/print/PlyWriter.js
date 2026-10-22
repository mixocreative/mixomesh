/**
 * Binary PLY serializer (little-endian) with per-vertex colour.
 *
 * Layout (one file, every mesh of the file merged with index offsets):
 *   element vertex N : float x y z, float nx ny nz, uchar red green blue alpha
 *                      [+ float s t when any mesh in the file is textured]
 *   element face   F : list uchar int vertex_indices
 *
 * Geometry goes through PrintSpace exactly like StlWriter / ThreeMFWriter
 * (positionsToPrintSpace + printIndices): right-handed, Z-up, millimetres,
 * counter-clockwise-outward. Normals use the same linear map (it is
 * orthogonal, so M^-T = M); nothing here knows about handedness.
 *
 * Colour: a textured mesh (diffuse/albedo/base texture + UVs) is sampled
 * BILINEARLY at each vertex UV from the export-side PNG bytes that
 * ExportTextures.collectMimakiTextures hands the 3MF writer — the frozen
 * full-res source, never the (possibly capped) GPU copy. UVs are used raw
 * with a bottom-left origin, the same contract the 3MF/OBJ writers rely on
 * (TextureReadback.EXPORT_FLIP_Y). Solid meshes use the material's sRGB
 * colour (ColorSpace.materialSrgbColor) and alpha.
 */

import { collectMimakiTextures, clamp255 } from './ExportTextures.js';
import { materialSrgbColor } from '../shaders/ColorSpace.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { positionsToPrintSpace, printIndices, toPrintSpace } from './PrintSpace.js';
import { exportUVs } from './UvTransform.js';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

const NORMAL_KIND = 'normal';
const FALLBACK_RGB = { r: 0.8, g: 0.8, b: 0.8 };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// ── PNG decode (export-side texture bytes → RGBA) ────────

/**
 * Decode an image Blob to straight (un-premultiplied) RGBA bytes.
 *
 * 8/16-bit non-interlaced PNG — what textureToPngBlob / TextureSource produce —
 * is decoded in pure JS (DecompressionStream inflate), so the sampled bytes
 * are exactly the file's bytes: no canvas colour management, no premultiply
 * round-trip that would shift low-alpha colours. Anything else falls back to
 * createImageBitmap + canvas in the browser.
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @returns {Promise<{rgba:Uint8ClampedArray, width:number, height:number}>}
 */
export async function decodeImageRGBA(source) {
  const bytes = source instanceof Uint8Array ? source
    : source instanceof ArrayBuffer ? new Uint8Array(source)
      : new Uint8Array(await source.arrayBuffer());
  if (_isPng(bytes)) {
    const decoded = await _decodePng(bytes);
    if (decoded) return decoded;
  }
  return _decodeViaCanvas(source instanceof Blob ? source : new Blob([bytes]));
}

function _isPng(b) {
  return b.length > 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);
}

async function _decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (o + 8 <= bytes.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8); height = view.getUint32(o + 12);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!width || !height || !channels || interlace !== 0) return null;
  if (!(depth === 8 || (depth === 16 && colorType !== 3))) return null;
  if (typeof DecompressionStream !== 'function') return null;

  const raw = await _inflate(idat);
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PlyWriter: truncated PNG texture data');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const step = depth / 8;   // 16-bit: keep the high byte
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp, d = p * 4;
    const ch = (k) => px[s + k * step];
    if (colorType === 6) { rgba[d] = ch(0); rgba[d + 1] = ch(1); rgba[d + 2] = ch(2); rgba[d + 3] = ch(3); }
    else if (colorType === 2) { rgba[d] = ch(0); rgba[d + 1] = ch(1); rgba[d + 2] = ch(2); rgba[d + 3] = 255; }
    else if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = ch(0); rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = ch(0); rgba[d + 3] = ch(1); }
    else {
      const i = px[s];
      if (!palette || i * 3 + 2 >= palette.length) throw new Error('PlyWriter: PNG palette index out of range');
      rgba[d] = palette[i * 3]; rgba[d + 1] = palette[i * 3 + 1]; rgba[d + 2] = palette[i * 3 + 2];
      rgba[d + 3] = trns && i < trns.length ? trns[i] : 255;
    }
  }
  return { rgba, width, height };
}

async function _inflate(chunks) {
  const stream = new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function _decodeViaCanvas(blob) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('PlyWriter: texture is not a decodable PNG and no image decoder is available');
  }
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('PlyWriter: no 2d canvas context for texture decode');
  ctx2d.drawImage(bmp, 0, 0);
  bmp.close?.();
  const { data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  return { rgba: new Uint8ClampedArray(data), width: canvas.width, height: canvas.height };
}

// ── sampling ─────────────────────────────────────────────

/**
 * Bilinear RGBA sample with REPEAT wrap (Babylon's default address mode).
 * UV origin is bottom-left (row-from-top = (1 − v)·H), texel centres at +0.5.
 * @param {{rgba:ArrayLike<number>, width:number, height:number}} img
 * @returns {number[]} [r, g, b, a] bytes
 */
export function sampleBilinear(img, u, v) {
  const { rgba, width: w, height: h } = img;
  const x = (Number(u) || 0) * w - 0.5;
  const y = (1 - (Number(v) || 0)) * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (n, m) => ((n % m) + m) % m;
  const xa = wrap(x0, w), xb = wrap(x0 + 1, w), ya = wrap(y0, h), yb = wrap(y0 + 1, h);
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const top = rgba[(ya * w + xa) * 4 + k] * (1 - fx) + rgba[(ya * w + xb) * 4 + k] * fx;
    const bot = rgba[(yb * w + xa) * 4 + k] * (1 - fx) + rgba[(yb * w + xb) * 4 + k] * fx;
    out[k] = Math.max(0, Math.min(255, Math.round(top * (1 - fy) + bot * fy)));
  }
  return out;
}

// ── encode ───────────────────────────────────────────────

function _solidRgba(mat) {
  const c = materialSrgbColor(mat) || FALLBACK_RGB;
  const a = mat?.alpha == null || !Number.isFinite(Number(mat.alpha)) ? 1 : Number(mat.alpha);
  return [clamp255(c.r), clamp255(c.g), clamp255(c.b), clamp255(Math.max(0, Math.min(1, a)))];
}

/** Area-weighted vertex normals from print-space positions + print indices. */
function _computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (len > 0) { n[i] /= len; n[i + 1] /= len; n[i + 2] /= len; }
  }
  return n;
}

function _normalsToPrintSpace(raw, count) {
  if (!raw || raw.length !== count * 3) return null;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const [x, y, z] = toPrintSpace(raw[i], raw[i + 1], raw[i + 2]);
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
  }
  return out;
}

/**
 * Encode meshes as ONE binary little-endian PLY.
 * @param {Array<{mesh:object}>} meshEntries
 * @param {Map<object, {rgba:ArrayLike<number>, width:number, height:number}>} [imageByMesh]
 *   decoded texture per textured mesh (meshes absent here are solid colour)
 * @returns {Uint8Array}
 */
export function encodeBinaryPLY(meshEntries, imageByMesh = new Map()) {
  const parts = [];
  for (const { mesh } of meshEntries) {
    const raw = mesh.getVerticesData?.('position');
    const idx = printIndices(mesh);
    if (!raw || !idx.length) continue;
    const count = raw.length / 3;
    for (const i of idx) {
      if (!(i >= 0 && i < count)) throw new Error(`PlyWriter: triangle index out of range in "${mesh.name ?? '?'}"`);
    }
    const pos = positionsToPrintSpace(raw);
    const nrm = _normalsToPrintSpace(mesh.getVerticesData?.(NORMAL_KIND), count) ?? _computeNormals(pos, idx);
    const img = imageByMesh.get(mesh) ?? null;
    const uvRaw = exportUVs(mesh);
    const uv = uvRaw && uvRaw.length === count * 2 ? uvRaw : null;
    parts.push({ pos, nrm, idx, count, img: uv ? img : null, uv, solid: _solidRgba(mesh.material) });
  }
  const textured = parts.some(p => p.img);
  const vertexCount = parts.reduce((s, p) => s + p.count, 0);
  const faceCount = parts.reduce((s, p) => s + p.idx.length / 3, 0);

  const props = ['float x', 'float y', 'float z', 'float nx', 'float ny', 'float nz',
    'uchar red', 'uchar green', 'uchar blue', 'uchar alpha'];
  if (textured) props.push('float s', 'float t');
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment mixomesh export: millimetres, right-handed, Z-up',
    `element vertex ${vertexCount}`,
    ...props.map(p => `property ${p}`),
    `element face ${faceCount}`,
    'property list uchar int vertex_indices',
    'end_header',
  ].join('\n') + '\n';

  const vStride = 6 * 4 + 4 + (textured ? 8 : 0);
  const headerBytes = new TextEncoder().encode(header);
  const bytes = new Uint8Array(headerBytes.length + vertexCount * vStride + faceCount * 13);
  bytes.set(headerBytes, 0);
  const view = new DataView(bytes.buffer);
  let o = headerBytes.length;
  for (const p of parts) {
    for (let v = 0; v < p.count; v++) {
      for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, p.pos[v * 3 + k], true);
      for (let k = 0; k < 3; k++) view.setFloat32(o + 12 + k * 4, p.nrm[v * 3 + k], true);
      const s = p.uv ? p.uv[v * 2] : 0;
      const t = p.uv ? p.uv[v * 2 + 1] : 0;
      const rgba = p.img ? sampleBilinear(p.img, s, t) : p.solid;
      bytes[o + 24] = rgba[0]; bytes[o + 25] = rgba[1]; bytes[o + 26] = rgba[2]; bytes[o + 27] = rgba[3];
      if (textured) { view.setFloat32(o + 28, s, true); view.setFloat32(o + 32, t, true); }
      o += vStride;
    }
  }
  let base = 0;
  for (const p of parts) {
    for (let i = 0; i < p.idx.length; i += 3) {
      bytes[o] = 3;
      view.setInt32(o + 1, p.idx[i] + base, true);
      view.setInt32(o + 5, p.idx[i + 1] + base, true);
      view.setInt32(o + 9, p.idx[i + 2] + base, true);
      o += 13;
    }
    base += p.count;
  }
  return bytes;
}

/**
 * Decode every textured clone's export PNG once (shared textures decode once).
 * @returns {Promise<Map<object, {rgba:Uint8ClampedArray, width:number, height:number}>>}
 */
async function _decodedImagesByMesh(ctx) {
  const BABYLON = window.BABYLON;
  const { blobByPath, pathByMesh } = await collectMimakiTextures(ctx.meshes, BABYLON, ctx.state);
  const imageByPath = new Map();
  for (const [path, blob] of blobByPath) imageByPath.set(path, await decodeImageRGBA(blob));
  const out = new Map();
  for (const [mesh, path] of pathByMesh) out.set(mesh, imageByPath.get(path));
  return out;
}

/**
 * Pipeline serializer: combined PLY blob, or one PLY per logical unit in a zip
 * (same packaging shape as StlWriter).
 * @param {ExportContext} ctx
 */
export async function serializePLY(ctx) {
  const images = await _decodedImagesByMesh(ctx);
  if (ctx.individually) {
    const entries = [];
    for (const unit of ctx.cloneGroups) {
      entries.push({ path: `${perMeshBaseName(ctx, unit.name)}.ply`, data: encodeBinaryPLY(unit.meshes, images) });
    }
    return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
  }
  return {
    kind: 'blob', mime: 'application/octet-stream',
    filename: `${exportBaseName(ctx)}.ply`, data: encodeBinaryPLY(ctx.meshes, images),
  };
}
