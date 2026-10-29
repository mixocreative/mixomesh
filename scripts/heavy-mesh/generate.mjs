// Synthetic heavy-mesh fixtures for the heavy-mesh perf harness
// (docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md).
//
//   node scripts/heavy-mesh/generate.mjs [--out DIR] [--sizes 2,5,10] [--3mf 10] [--ascii 0.5] [--glb 2]
//
// Writes a closed "pillow" (wavy top grid + flat bottom grid sharing the rim)
// so the mesh is watertight and welds to ~T/2 vertices like a real scan.
// Big files are written in streamed chunks and NEVER go in git: the default
// output folder is .tmp/heavy-mesh (git-ignored) or $HEAVY_MESH_DIR.

import { createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHUNK_TRIS = 65_536;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** Grid side n so that 4·n² (top + bottom, 2 tris per quad) ≈ targetTris. */
export function gridForTriangles(targetTris) {
  return Math.max(2, Math.round(Math.sqrt(targetTris / 4)));
}

const onRim = (i, j, n) => i === 0 || j === 0 || i === n || j === n;
/** Top corner quads whose a–c diagonal lies on the rim use b–d, or top and
 *  bottom would share that diagonal (non-manifold, zero-volume sliver). */
const flipDiagonal = (i, j, n) => onRim(i, j, n) && onRim(i + 1, j + 1, n);

function height(i, j, n) {
  if (onRim(i, j, n)) return 0;
  const u = i / n, v = j / n;
  return 4 + 3 * Math.sin(u * 37.1) * Math.cos(v * 29.3) + 1.5 * Math.sin((u + v) * 113.7);
}

/** Yield triangles as [ax,ay,az,bx,by,bz,cx,cy,cz] (mm, Z up, CCW outward). */
export function* pillowTriangles(n, size = 100) {
  const s = size / n;
  const p = (i, j, top) => [i * s, j * s, top ? height(i, j, n) : 0];
  for (const top of [true, false]) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = p(i, j, top), b = p(i + 1, j, top), c = p(i + 1, j + 1, top), d = p(i, j + 1, top);
        if (top && flipDiagonal(i, j, n)) { yield [...a, ...b, ...d]; yield [...b, ...c, ...d]; }
        else if (top) { yield [...a, ...b, ...c]; yield [...a, ...c, ...d]; }
        else { yield [...a, ...c, ...b]; yield [...a, ...d, ...c]; }
      }
    }
  }
}

async function writeChunks(path, chunks) {
  const out = createWriteStream(path);
  for (const chunk of chunks) {
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
}

export function* binaryStlChunks(n) {
  const tris = 4 * n * n;
  const header = Buffer.alloc(84);
  header.write('mixomesh heavy-mesh fixture', 0, 'ascii');
  header.writeUInt32LE(tris, 80);
  yield header;
  let buf = Buffer.alloc(CHUNK_TRIS * 50);
  let k = 0;
  for (const t of pillowTriangles(n)) {
    const o = k * 50;
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    for (let q = 0; q < 9; q++) buf.writeFloatLE(t[q], o + 12 + q * 4);
    buf.writeUInt16LE(0, o + 48);
    if (++k === CHUNK_TRIS) { yield buf; buf = Buffer.alloc(CHUNK_TRIS * 50); k = 0; }
  }
  if (k) yield buf.subarray(0, k * 50);
}

export function* asciiStlChunks(n) {
  yield 'solid heavy\n';
  let parts = [];
  for (const t of pillowTriangles(n)) {
    parts.push(`facet normal 0 0 0\nouter loop\nvertex ${t[0]} ${t[1]} ${t[2]}\nvertex ${t[3]} ${t[4]} ${t[5]}\nvertex ${t[6]} ${t[7]} ${t[8]}\nendloop\nendfacet\n`);
    if (parts.length === 4096) { yield parts.join(''); parts = []; }
  }
  if (parts.length) yield parts.join('');
  yield 'endsolid heavy\n';
}

/** 3MF model XML for the pillow: indexed vertices, streamed as text chunks. */
export function* threeMFModelChunks(n) {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n<object id="1" type="model"><mesh><vertices>\n';
  const s = 100 / n;
  const row = n + 1;
  let parts = [];
  // Top grid then bottom grid; the rim (height 0) is shared by referencing top vertices.
  for (const top of [true, false]) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        parts.push(`<vertex x="${(i * s).toFixed(4)}" y="${(j * s).toFixed(4)}" z="${(top ? height(i, j, n) : 0).toFixed(4)}"/>\n`);
        if (parts.length === 8192) { yield parts.join(''); parts = []; }
      }
    }
  }
  if (parts.length) { yield parts.join(''); parts = []; }
  yield '</vertices><triangles>\n';
  const base = row * row;
  const vid = (i, j, top) => {
    const rim = i === 0 || j === 0 || i === n || j === n;
    return (top || rim) ? j * row + i : base + j * row + i;
  };
  for (const top of [true, false]) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = vid(i, j, top), b = vid(i + 1, j, top), c = vid(i + 1, j + 1, top), d = vid(i, j + 1, top);
        if (top && flipDiagonal(i, j, n)) parts.push(`<triangle v1="${a}" v2="${b}" v3="${d}"/>\n<triangle v1="${b}" v2="${c}" v3="${d}"/>\n`);
        else if (top) parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>\n<triangle v1="${a}" v2="${c}" v3="${d}"/>\n`);
        else parts.push(`<triangle v1="${a}" v2="${c}" v3="${b}"/>\n<triangle v1="${a}" v2="${d}" v3="${c}"/>\n`);
        if (parts.length === 4096) { yield parts.join(''); parts = []; }
      }
    }
  }
  if (parts.length) yield parts.join('');
  yield '</triangles></mesh></object>\n</resources>\n<build><item objectid="1"/></build>\n</model>\n';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

async function write3MF(path, n) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('3D/3dmodel.model', Readable.from(threeMFModelChunks(n)), { binary: false });
  const out = createWriteStream(path);
  zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 1 } }).pipe(out);
  await once(out, 'finish');
}

const CRC_T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** size x size RGB PNG (default 4096): checker + sines + hash noise, so it neither compresses to nothing nor looks flat. */
export function texturePng(size = 4096) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0, h = 12345;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;   // filter: none
    for (let x = 0; x < size; x++) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      const chk = ((x >> 7) + (y >> 7)) & 1 ? 40 : 0;
      raw[o++] = (128 + 100 * Math.sin(x * 0.011) + chk + (h >>> 29)) & 255;
      raw[o++] = (128 + 100 * Math.cos(y * 0.013) + chk + ((h >>> 26) & 7)) & 255;
      raw[o++] = (128 + 100 * Math.sin((x + y) * 0.007) + ((h >>> 23) & 7)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Textured pillow as one GLB: positions (m), UV (u=i/n, v=j/n) and a 4096^2 PNG base-colour texture. */
export function pillowGlb(n, texSize = 4096) {
  const row = n + 1, base = row * row, nv = 2 * base;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const s = 100 / n;
  for (const [t, top] of [[0, true], [1, false]]) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = t * base + j * row + i;
    pos.set([i * s / 1000, j * s / 1000, (top ? height(i, j, n) : 0) / 1000], k * 3);   // mm -> m (glTF)
    uv.set([i / n, 1 - j / n], k * 2);
  }
  const idx = new Uint32Array(4 * n * n * 3);
  const vid = (i, j, top) => (top || i === 0 || j === 0 || i === n || j === n) ? j * row + i : base + j * row + i;
  let q = 0;
  for (const top of [true, false]) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = vid(i, j, top), b = vid(i + 1, j, top), c = vid(i + 1, j + 1, top), d = vid(i, j + 1, top);
    const tri = top && flipDiagonal(i, j, n) ? [a, b, d, b, c, d] : top ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    idx.set(tri, q); q += 6;
  }
  const png = texturePng(texSize);
  const pad = b => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)]);
  const parts = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), png].map(pad);
  const offs = []; let off = 0; for (const p of parts) { offs.push(off); off += p.length; }
  const mn = [1e9, 1e9, 1e9]; const mx = [-1e9, -1e9, -1e9];
  for (let k = 0; k < nv; k++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], pos[k * 3 + a]); mx[a] = Math.max(mx[a], pos[k * 3 + a]); }
  const json = {
    asset: { version: '2.0', generator: 'mixomesh heavy-mesh fixture' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: nv, type: 'VEC2' },
      { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' }],
    bufferViews: [[0, pos.byteLength, 34962], [1, uv.byteLength, 34962], [2, idx.byteLength, 34963], [3, png.length]]
      .map(([i, len, target]) => ({ buffer: 0, byteOffset: offs[i], byteLength: len, ...(target ? { target } : {}) })),
    buffers: [{ byteLength: off }],
  };
  const js = pad(Buffer.from(JSON.stringify(json))).fill(0x20, Buffer.byteLength(JSON.stringify(json)));
  const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + off, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(off, 0x004e4942), ...parts]);
}

async function main() {
  const outDir = resolve(arg('out', process.env.HEAVY_MESH_DIR ?? join(ROOT, '.tmp/heavy-mesh')));
  mkdirSync(outDir, { recursive: true });
  const sizes = String(arg('sizes', '2,5,10')).split(',').filter(Boolean).map(Number);
  const threeMF = Number(arg('3mf', '10'));
  const ascii = Number(arg('ascii', '0.5'));
  const glb = Number(arg('glb', '2'));
  for (const m of sizes) {
    const n = gridForTriangles(m * 1e6);
    const path = join(outDir, `pillow-${m}M.stl`);
    await writeChunks(path, binaryStlChunks(n));
    console.log(`${path}  ${(4 * n * n).toLocaleString('en-US')} tris  ${(statSync(path).size / 2 ** 20).toFixed(0)} MiB`);
  }
  if (ascii > 0) {
    const n = gridForTriangles(ascii * 1e6);
    const path = join(outDir, `pillow-${ascii}M-ascii.stl`);
    await writeChunks(path, asciiStlChunks(n));
    console.log(`${path}  ${(4 * n * n).toLocaleString('en-US')} tris  ${(statSync(path).size / 2 ** 20).toFixed(0)} MiB`);
  }
  if (threeMF > 0) {
    const n = gridForTriangles(threeMF * 1e6);
    const path = join(outDir, `pillow-${threeMF}M.3mf`);
    await write3MF(path, n);
    console.log(`${path}  ${(4 * n * n).toLocaleString('en-US')} tris  ${(statSync(path).size / 2 ** 20).toFixed(0)} MiB`);
  }
  if (glb > 0) {
    const n = gridForTriangles(glb * 1e6);
    const path = join(outDir, `pillow-textured-${glb}M.glb`);
    writeFileSync(path, pillowGlb(n));
    console.log(`${path}  ${(4 * n * n).toLocaleString('en-US')} tris  4096x4096 texture  ${(statSync(path).size / 2 ** 20).toFixed(0)} MiB`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
