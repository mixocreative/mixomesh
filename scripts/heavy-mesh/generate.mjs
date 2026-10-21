// Synthetic heavy-mesh fixtures for the heavy-mesh perf harness
// (docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md).
//
//   node scripts/heavy-mesh/generate.mjs [--out DIR] [--sizes 2,5,10] [--3mf 10] [--ascii 0.5]
//
// Writes a closed "pillow" (wavy top grid + flat bottom grid sharing the rim)
// so the mesh is watertight and welds to ~T/2 vertices like a real scan.
// Big files are written in streamed chunks and NEVER go in git: the default
// output folder is .tmp/heavy-mesh (git-ignored) or $HEAVY_MESH_DIR.

import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

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

async function main() {
  const outDir = resolve(arg('out', process.env.HEAVY_MESH_DIR ?? join(ROOT, '.tmp/heavy-mesh')));
  mkdirSync(outDir, { recursive: true });
  const sizes = String(arg('sizes', '2,5,10')).split(',').filter(Boolean).map(Number);
  const threeMF = Number(arg('3mf', '10'));
  const ascii = Number(arg('ascii', '0.5'));
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
