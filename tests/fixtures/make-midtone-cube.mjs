// Generates tests/fixtures/midtone-cube.glb: a closed 20 mm cube, 24 vertices
// (four per face, so every cube edge is a UV seam), textured with a 48x32 RGB
// PNG of six 16x16 mid-tone cells, one per face. Mid-tones matter: a double
// sRGB encode leaves 0 and 255 alone but moves every value in between, and
// split UV seams are exactly what a slicer reports as open edges.
//
//   node tests/fixtures/make-midtone-cube.mjs
//
// FACE_COLOURS is exported so tests can assert the colour at each face centre.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'midtone-cube.glb');

export const FACES = [
  { name: '+X', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { name: '-X', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { name: '+Y', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { name: '-Y', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { name: '+Z', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { name: '-Z', n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];
export const FACE_COLOURS = [
  [200, 134, 113], [90, 160, 200], [128, 128, 64],
  [60, 90, 40], [180, 100, 170], [110, 110, 110],
];
const CELL = 16, COLS = 3, ROWS = 2, W = CELL * COLS, H = CELL * ROWS, HALF = 10;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function buildPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const rgb = FACE_COLOURS[Math.floor(y / CELL) * COLS + Math.floor(x / CELL)];
      raw.set(rgb, y * (1 + W * 3) + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildGeometry() {
  const pos = [], uv = [], idx = [];
  FACES.forEach((f, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) pos.push(HALF * (f.n[k] + a * f.u[k] + b * f.v[k]));
      uv.push((col + 0.5 + 0.4 * a) / COLS, (row + 0.5 - 0.4 * b) / ROWS);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) };
}

function buildGlb() {
  const { pos, uv, idx } = buildGeometry();
  const png = buildPng();
  const pad = n => (4 - (n % 4)) % 4;
  const parts = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), png];
  const views = [];
  let off = 0;
  const chunks = [];
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: p.length });
    chunks.push(p, Buffer.alloc(pad(p.length)));
    off += p.length + pad(p.length);
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'mixomesh make-midtone-cube' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'midtone-cube' }],
    meshes: [{ name: 'midtone-cube', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'midtone', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: 3, mimeType: 'image/png', name: 'midtone' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-HALF, -HALF, -HALF], max: [HALF, HALF, HALF] },
      { bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length), 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT, buildGlb());
  console.log(`wrote ${OUT}`);
}
