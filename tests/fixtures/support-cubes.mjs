// Support spike fixtures (plan P2.1), in the ENGINE frame (mm, right-handed, Y up):
//  - cubeOverhang(): verbatim copy of mixo-geocore goldens/fixtures.ts `cubeWithOverhang` (the
//    `cube-overhang` golden; its counts are in support-golden-cube-overhang.json).
//  - seamCube({ split }): a 20 mm cube whose bottom face is a 4 x 4 grid. split: every bottom cell
//    and every side face has its own vertices and UVs (UV seams cross the bottom face, the way
//    mixomesh holds a textured import); plain: one welded vertex set, no UVs.
// Both are written as GLB too (`node tests/fixtures/support-cubes.mjs`) for the browser spike: the
// glTF holds (-x, y, -z) of the engine mesh, which Babylon's glTF import plus frame.ts turn back into
// the engine mesh (a 180 degree turn about Y: proper, winding kept counter-clockwise-outward).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

/** mixo-geocore goldens/fixtures.ts cubeWithOverhang (10 mm cube + 6 mm shelf, L profile extruded along z). */
export function cubeOverhang() {
  const profile = [[0, 0], [10, 0], [10, 6], [16, 6], [16, 10], [10, 10], [0, 10]];
  const cap = [[0, 1, 2], [0, 2, 5], [0, 5, 6], [2, 3, 4], [2, 4, 5]];
  const n = profile.length;
  const positions = [];
  for (const z of [-5, 5]) for (const [x, y] of profile) positions.push(x, y, z);
  const indices = [];
  for (const [a, b, c] of cap) {
    indices.push(n + a, n + b, n + c);
    indices.push(a, c, b);
  }
  for (let k = 0; k < n; k += 1) {
    const next = (k + 1) % n;
    indices.push(k, next, n + next, k, n + next, n + k);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * 20 mm cube [-10, 10] x [0, 20] x [-10, 10], counter-clockwise-outward, bottom face a G x G grid.
 * @param {{ split: boolean }} options
 * @returns {{ positions: Float32Array, indices: Uint32Array, uvs: Float32Array | null }}
 */
export function seamCube({ split }) {
  const G = 4, S = 10;
  const pos = [], uv = [], idx = [];
  const shared = new Map();
  const vertex = (p, t) => {
    if (!split) {
      const key = p.join(',');
      if (shared.has(key)) return shared.get(key);
      shared.set(key, pos.length / 3);
    }
    pos.push(...p);
    uv.push(...t);
    return pos.length / 3 - 1;
  };
  // A quad a-b-c-d counter-clockwise seen from outside.
  const quad = (a, b, c, d, uvs) => {
    const [ia, ib, ic, id] = [a, b, c, d].map((p, k) => vertex(p, uvs[k]));
    idx.push(ia, ib, ic, ia, ic, id);
  };
  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const step = (2 * S) / G, T = 2 * S;
  for (let i = 0; i < G; i++) {
    const a = -S + i * step, b = a + step;
    for (let j = 0; j < G; j++) {
      const c = -S + j * step, d = c + step;
      quad([a, 0, c], [b, 0, c], [b, 0, d], [a, 0, d], unit);   // bottom cell (-y): own UV island when split
      quad([a, T, c], [a, T, d], [b, T, d], [b, T, c], unit);   // top cell (+y)
    }
    // Side columns, so every side vertex on the bottom / top edge is a grid vertex (no T-junctions).
    quad([a, 0, S], [b, 0, S], [b, T, S], [a, T, S], unit);       // +z
    quad([b, 0, -S], [a, 0, -S], [a, T, -S], [b, T, -S], unit);   // -z
    quad([S, 0, b], [S, 0, a], [S, T, a], [S, T, b], unit);       // +x
    quad([-S, 0, a], [-S, 0, b], [-S, T, b], [-S, T, a], unit);   // -x
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: split ? new Float32Array(uv) : null };
}

// ── GLB writer ───────────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png2x2() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** GLB of an engine-frame mesh: glTF holds (-x, y, -z). With `uvs`, a 2x2 PNG base colour texture. */
export function glbOf(name, { positions, indices, uvs }) {
  const p = new Float32Array(positions.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = 0 - positions[i]; p[i + 1] = positions[i + 1]; p[i + 2] = 0 - positions[i + 2]; }
  const min = [0, 1, 2].map((a) => Math.min(...p.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...p.filter((_, i) => i % 3 === a)));
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const parts = [Buffer.from(p.buffer), Buffer.from(new Uint32Array(indices).buffer)];
  if (uvs) parts.push(Buffer.from(uvs.buffer), png2x2());
  const views = [];
  let offset = 0;
  const chunks = [];
  for (const part of parts) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.length });
    chunks.push(part, Buffer.alloc(pad4(part.length)));
    offset += part.length + pad4(part.length);
  }
  const bin = Buffer.concat(chunks);
  const attributes = { POSITION: 0 };
  const accessors = [
    { bufferView: 0, componentType: 5126, count: p.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
  ];
  const gltf = {
    asset: { version: '2.0', generator: 'mixomesh-test-fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices: 1, material: 0 }] }],
    materials: [{ name: `${name}-paint`, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  if (uvs) {
    attributes.TEXCOORD_0 = 2;
    accessors.push({ bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
    gltf.materials[0].pbrMetallicRoughness = { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 };
    gltf.textures = [{ source: 0 }];
    gltf.images = [{ bufferView: 3, mimeType: 'image/png', name: `${name}-paint` }];
  }
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546C67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4E4F534A, 16); json.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + json.length); glb.writeUInt32LE(0x004E4942, 24 + json.length);
  bin.copy(glb, 28 + json.length);
  return glb;
}

export const GLB_FILES = {
  'support-cube-overhang.glb': () => glbOf('CubeOverhang', { ...cubeOverhang(), uvs: null }),
  'support-seam-cube.glb': () => glbOf('SeamCube', seamCube({ split: true })),
  'support-plain-cube.glb': () => glbOf('PlainCube', seamCube({ split: false })),
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const [file, make] of Object.entries(GLB_FILES)) {
    const bytes = make();
    writeFileSync(join(DIR, file), bytes);
    console.log(`Wrote ${file} (${bytes.length} bytes)`);
  }
}
