// Generates tests/fixtures/open-tetra.glb — a minimal valid glTF 2.0 binary:
// a tetrahedron (4 verts) with only THREE of its four faces, leaving one
// triangular hole (the boundary loop [1,2,3]). Positions in mm:
//   v0=(0,0,0) v1=(10,0,0) v2=(0,20,0) v3=(0,0,30)
// Faces: [0,2,1] [0,1,3] [0,3,2] — closing the missing 4th face [1,2,3]
// with the same winding convention yields a CLOSED, outward-wound solid of
// volume +1000 mm³ (right tetrahedron, legs 10/20/30: (1/6)*10*20*30). No
// UVs, no material — pure topology fixture for watertight-repair-and-cost
// task 8's live repair probe (tests/browser-repair-smoke.mjs).
//
//   node tests/fixtures/make-open-tetra.mjs
//
// Structure mirrors tests/fixtures/make-textured-quad.mjs (hand-assembled
// GLB container, no deps), minus the PNG/UV/material chunks.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'open-tetra.glb');

// ── Binary buffer: positions | indices ──────────────────────────────────
const positions = new Float32Array([
  0, 0, 0,
  10, 0, 0,
  0, 20, 0,
  0, 0, 30,
]);
const indices = new Uint16Array([
  0, 2, 1,
  0, 1, 3,
  0, 3, 2,
]);

const pad4 = n => (4 - (n % 4)) % 4;
const posBytes = Buffer.from(positions.buffer);
const idxBytes = Buffer.from(indices.buffer);

const posOff = 0;
const idxOff = posOff + posBytes.length; // 48
const bin = Buffer.alloc(idxOff + idxBytes.length + pad4(idxBytes.length));
posBytes.copy(bin, posOff);
idxBytes.copy(bin, idxOff);

// ── glTF JSON ────────────────────────────────────────────────────────────
const gltf = {
  asset: { version: '2.0', generator: 'mixomesh-test-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'OpenTetra' }],
  meshes: [{ name: 'OpenTetra', primitives: [{
    attributes: { POSITION: 0 }, indices: 1,
  }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [10, 20, 30] },
    { bufferView: 1, componentType: 5123, count: 9, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: posOff, byteLength: posBytes.length },
    { buffer: 0, byteOffset: idxOff, byteLength: idxBytes.length },
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
