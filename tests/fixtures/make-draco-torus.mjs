// Generates tests/fixtures/draco-torus.glb: a 24 x 12 torus (576 triangles,
// outer radius 20 mm, tube radius 6 mm) whose only primitive is
// KHR_draco_mesh_compression, the encoding every real customer scan uses.
// tests/browser-draco-offline.mjs imports it with the Babylon CDN blocked.
//
//   node tests/fixtures/make-draco-torus.mjs
//
// The encoder is Google's draco3dgltf@1.5.7 (Apache-2.0, the same release as
// the vendored decoder in public/vendor/draco). It is not a project
// dependency: the npm tarball is downloaded once into .tmp/, checked against
// its registry sha512 integrity, and unpacked there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'draco-torus.glb');
const ENCODER_DIR = join(HERE, '..', '..', '.tmp', 'draco3dgltf-1.5.7');
const TARBALL = 'https://registry.npmjs.org/draco3dgltf/-/draco3dgltf-1.5.7.tgz';
const INTEGRITY = 'sha512-LeqcpmoHIyYUi0z70/H3tMkGj8QhqVxq6FJGPjlzR24BNkQ6jyMheMvFKJBI0dzGZrEOUyQEmZ8axM1xRrbRiw==';
const ENCODER_FILES = ['draco_encoder_gltf_nodejs.js', 'draco_encoder.wasm'];

const SEGMENTS = 24;
const SIDES = 12;
const TRIANGLES = SEGMENTS * SIDES * 2;

function untar(tar) {
  const files = new Map();
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim(), 8);
    files.set(name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function loadEncoderModule() {
  if (!ENCODER_FILES.every(f => existsSync(join(ENCODER_DIR, f)))) {
    const res = await fetch(TARBALL);
    if (!res.ok) throw new Error(`GET ${TARBALL}: HTTP ${res.status}`);
    const tgz = Buffer.from(await res.arrayBuffer());
    const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    if (got !== INTEGRITY) throw new Error(`draco3dgltf tarball integrity mismatch: ${got}`);
    const files = untar(gunzipSync(tgz));
    mkdirSync(ENCODER_DIR, { recursive: true });
    for (const f of ENCODER_FILES) writeFileSync(join(ENCODER_DIR, f), files.get(`package/${f}`));
  }
  // .tmp/ sits under this repo's "type": "module" package.json; the encoder is CommonJS.
  writeFileSync(join(ENCODER_DIR, 'package.json'), '{ "type": "commonjs" }\n');
  const createEncoderModule = createRequire(import.meta.url)(join(ENCODER_DIR, 'draco_encoder_gltf_nodejs.js'));
  return await createEncoderModule({});
}

function torus() {
  const R = 20, r = 6;
  const positions = [];
  const normals = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const u = (i / SEGMENTS) * 2 * Math.PI;
    for (let j = 0; j < SIDES; j++) {
      const v = (j / SIDES) * 2 * Math.PI;
      const n = [Math.cos(u) * Math.cos(v), Math.sin(v), Math.sin(u) * Math.cos(v)];
      normals.push(...n);
      positions.push(Math.cos(u) * R + n[0] * r, n[1] * r, Math.sin(u) * R + n[2] * r);
    }
  }
  const indices = [];
  const at = (i, j) => (i % SEGMENTS) * SIDES + (j % SIDES);
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      indices.push(a, d, b, b, d, c);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

function encode(M, { positions, normals, indices }) {
  const builder = new M.MeshBuilder();
  const mesh = new M.Mesh();
  const vertexCount = positions.length / 3;
  builder.AddFacesToMesh(mesh, indices.length / 3, indices);
  const position = builder.AddFloatAttributeToMesh(mesh, M.POSITION, vertexCount, 3, positions);
  const normal = builder.AddFloatAttributeToMesh(mesh, M.NORMAL, vertexCount, 3, normals);
  const encoder = new M.Encoder();
  encoder.SetAttributeQuantization(M.POSITION, 14);
  encoder.SetAttributeQuantization(M.NORMAL, 10);
  encoder.SetEncodingMethod(M.MESH_EDGEBREAKER_ENCODING);
  const out = new M.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  if (length <= 0) throw new Error('Draco encoding failed');
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = out.GetValue(i);
  for (const o of [out, encoder, mesh, builder]) M.destroy(o);
  return { bytes, attributes: { POSITION: position, NORMAL: normal }, vertexCount };
}

function glb(draco, positions, indexCount) {
  const min = [0, 1, 2].map(k => Math.min(...positions.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map(k => Math.max(...positions.filter((_, i) => i % 3 === k)));
  const pad = n => (4 - (n % 4)) % 4;
  const bin = Buffer.concat([draco.bytes, Buffer.alloc(pad(draco.bytes.length))]);
  const gltf = {
    asset: { version: '2.0', generator: 'mixomesh-test-fixture' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'DracoTorus' }],
    meshes: [{ name: 'DracoTorus', primitives: [{
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: 2,
      extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: draco.attributes } },
    }] }],
    accessors: [
      { componentType: 5126, count: draco.vertexCount, type: 'VEC3', min, max },
      { componentType: 5126, count: draco.vertexCount, type: 'VEC3' },
      { componentType: 5125, count: indexCount, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: draco.bytes.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc(pad(json.length), 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (type, body) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([header, chunk(0x4E4F534A, json), chunk(0x004E4942, bin)]);
}

const M = await loadEncoderModule();
const geometry = torus();
const bytes = glb(encode(M, geometry), Array.from(geometry.positions), geometry.indices.length);
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes, ${TRIANGLES} triangles, sha256 ${createHash('sha256').update(readFileSync(OUT)).digest('hex')})`);
