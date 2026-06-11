// Generates tests/fixtures/textured-quad.glb — a minimal valid glTF 2.0
// binary: one 50 mm quad (4 verts, 2 triangles) with UVs and a 2×2 RGBA PNG
// baseColor texture (red/green/blue/white texels). Node-only, no deps —
// the PNG is hand-assembled with zlib + CRC32.
//
//   node tests/fixtures/make-textured-quad.mjs
//
// Used by tests/browser-export-smoke.mjs (review C1 / Blueprint A2) so the
// textured export path can be verified in real Chrome without manual steps.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'textured-quad.glb');

// ── PNG (2×2 RGBA: red, green, blue, white) ─────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function buildPng() {
  const w = 2, h = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // Scanlines: filter byte 0 + RGBA pixels.
  const raw = Buffer.from([
    0, 255, 0, 0, 255,   0, 255, 0, 255,    // row 0: red, green
    0, 0, 0, 255, 255,   255, 255, 255, 255, // row 1: blue, white
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Binary buffer: positions | uvs | indices | png ──────────────────────
const positions = new Float32Array([0, 0, 0, 50, 0, 0, 50, 50, 0, 0, 50, 0]); // mm
const uvs       = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const indices   = new Uint16Array([0, 1, 2, 0, 2, 3]);
const png       = buildPng();

const pad4 = n => (4 - (n % 4)) % 4;
const posBytes = Buffer.from(positions.buffer);
const uvBytes  = Buffer.from(uvs.buffer);
const idxBytes = Buffer.from(indices.buffer);

const posOff = 0;
const uvOff  = posOff + posBytes.length;                       // 48
const idxOff = uvOff + uvBytes.length;                         // 80
const pngOff = idxOff + idxBytes.length + pad4(idxBytes.length); // 92 → 92 (12 bytes, pad 0) → 92
const pngOffAligned = pngOff + pad4(pngOff);
const bin = Buffer.alloc(pngOffAligned + png.length + pad4(png.length));
posBytes.copy(bin, posOff);
uvBytes.copy(bin, uvOff);
idxBytes.copy(bin, idxOff);
png.copy(bin, pngOffAligned);

// ── glTF JSON ────────────────────────────────────────────────────────────
const gltf = {
  asset: { version: '2.0', generator: 'mixomesh-test-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'TexturedQuad' }],
  meshes: [{ name: 'TexturedQuad', primitives: [{
    attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0,
  }] }],
  materials: [{
    name: 'QuadPaint',
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1,
    },
  }],
  textures: [{ source: 0 }],
  images: [{ bufferView: 3, mimeType: 'image/png', name: 'quad-paint' }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [50, 50, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
    { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: posOff, byteLength: posBytes.length },
    { buffer: 0, byteOffset: uvOff,  byteLength: uvBytes.length },
    { buffer: 0, byteOffset: idxOff, byteLength: idxBytes.length },
    { buffer: 0, byteOffset: pngOffAligned, byteLength: png.length },
  ],
  buffers: [{ byteLength: bin.length }],
};

// ── GLB container ────────────────────────────────────────────────────────
let json = Buffer.from(JSON.stringify(gltf), 'utf8');
if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);

const total = 12 + 8 + json.length + 8 + bin.length;
const glb = Buffer.alloc(total);
glb.writeUInt32LE(0x46546C67, 0);          // magic 'glTF'
glb.writeUInt32LE(2, 4);                   // version
glb.writeUInt32LE(total, 8);
glb.writeUInt32LE(json.length, 12);
glb.writeUInt32LE(0x4E4F534A, 16);         // 'JSON'
json.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + json.length);
glb.writeUInt32LE(0x004E4942, 24 + json.length); // 'BIN\0'
bin.copy(glb, 28 + json.length);

writeFileSync(OUT, glb);
console.log(`Wrote ${OUT} (${glb.length} bytes)`);
