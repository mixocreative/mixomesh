import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateStl, estimateObj, threeMFModelBytes, countGltfJsonTriangles, glbJsonChunkLength,
  estimateFileTriangles, THREEMF_BYTES_PER_TRIANGLE, gltfEstimate,
} from '../src/core/import/TriangleEstimate.js';
import { assertPreParseCapacity } from '../src/core/import/ImportLimits.js';
import { binaryStlChunks, asciiStlChunks, threeMFModelChunks } from '../scripts/heavy-mesh/generate.mjs';

const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

test('binary STL: exact count from (size − 84) / 50 when the header agrees', () => {
  const bytes = u8(Buffer.concat([...binaryStlChunks(10)]));
  assert.deepEqual(estimateStl(bytes.subarray(0, 4096), bytes.length), { triangles: 400, confidence: 'exact' });
});

test('binary STL with a lying header: size-based, not exact', () => {
  const bytes = Buffer.concat([...binaryStlChunks(4)]);
  bytes.writeUInt32LE(7, 80);
  const r = estimateStl(u8(bytes), bytes.length);
  assert.equal(r.triangles, 64);
  assert.equal(r.confidence, 'sampled');
});

test('ASCII STL: sampled facet density within 5 %', () => {
  const text = Buffer.from([...asciiStlChunks(60)].join(''));
  const r = estimateStl(u8(text).subarray(0, 64 * 1024), text.length, u8(text).subarray(text.length - 64 * 1024));
  assert.equal(r.confidence, 'sampled');
  assert.ok(Math.abs(r.triangles - 14400) / 14400 < 0.05, String(r.triangles));
  assert.deepEqual(estimateStl(u8(text), text.length), { triangles: 14400, confidence: 'exact' });
});

test('OBJ: n-gons count n−2, scaled by size', () => {
  const obj = Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3\nf 1 2 3 4\nf\t1/1 2/2 3/3\n');
  assert.deepEqual(estimateObj(u8(obj), obj.length), { triangles: 4, confidence: 'exact' });
  const half = estimateObj(u8(obj), obj.length * 2);
  assert.equal(half.triangles, 8);
  assert.equal(half.confidence, 'sampled');
});

test('glTF JSON: indices / positions of TRIANGLES primitives only', () => {
  const json = {
    accessors: [{ count: 300 }, { count: 90 }, { count: 6 }],
    meshes: [
      { primitives: [{ indices: 0, attributes: { POSITION: 1 } }] },
      { primitives: [{ attributes: { POSITION: 1 } }, { mode: 1, indices: 2, attributes: { POSITION: 1 } }] },
    ],
  };
  assert.equal(countGltfJsonTriangles(json), 130, 'no nodes: every mesh once');
  // Nodes: instancing counts per referencing node; unreferenced meshes count nothing (review M9).
  assert.equal(countGltfJsonTriangles({ ...json, nodes: [{ mesh: 0 }, { mesh: 0 }, { children: [0] }] }), 200);
  assert.equal(gltfEstimate({ ...json, nodes: [{ mesh: 1 }] }).triangles, 30);
  assert.deepEqual(gltfEstimate({ ...json, extensionsUsed: ['EXT_mesh_gpu_instancing'] }).confidence, 'rough');
});

test('GLB: JSON chunk length from the header', () => {
  const json = Buffer.from(JSON.stringify({ accessors: [{ count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }));
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  assert.equal(glbJsonChunkLength(u8(head)), json.length);
  return estimateFileTriangles(new Blob([head, json]), '.glb').then(r => assert.deepEqual(r, { triangles: 1, confidence: 'exact' }));
});

test('3MF: model part size from the central directory → estimate near the truth', async () => {
  const { default: JSZip } = await import('../node_modules/jszip/lib/index.js');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('3D/3dmodel.model', [...threeMFModelChunks(80)].join(''));
  const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const tail = buf.subarray(Math.max(0, buf.length - 66 * 1024));
  const modelBytes = await threeMFModelBytes(tail, buf.length, async (o, l) => buf.subarray(o, o + l));
  const truth = 4 * 80 * 80;
  const est = modelBytes / THREEMF_BYTES_PER_TRIANGLE;
  assert.ok(est > truth * 0.6 && est < truth * 1.4, `${est} vs ${truth}`);
  const r = await estimateFileTriangles(new Blob([buf]), '.3mf');
  assert.equal(r.confidence, 'rough', '3MF estimates never refuse');
});

test('pre-parse capacity: exact refuses above 4×, estimates only far above it, 3MF never; warn above 1×', () => {
  const ctx = { budget: 1_000_000, filename: 'big.stl' };
  assert.throws(() => assertPreParseCapacity({ triangles: 4_000_001, confidence: 'exact' }, ctx),
    /"big\.stl" has 4,000,001 triangles; this web build handles up to 4,000,000\. Simplify or split the model, or use the desktop app\./);
  assert.equal(assertPreParseCapacity({ triangles: 7_900_000, confidence: 'sampled' }, ctx), 'warn');
  assert.throws(() => assertPreParseCapacity({ triangles: 8_000_001, confidence: 'sampled' }, ctx), /has about 8,000,001/);
  assert.equal(assertPreParseCapacity({ triangles: 50_000_000, confidence: 'rough' }, ctx), 'warn');
  assert.equal(assertPreParseCapacity({ triangles: 900_000, confidence: 'exact' }, ctx), 'ok');
  assert.equal(assertPreParseCapacity({ triangles: 900_000, confidence: 'exact' }, { ...ctx, sceneTriangles: 200_000 }), 'warn');
  assert.equal(assertPreParseCapacity(null, ctx), 'unknown');
  assert.throws(() => assertPreParseCapacity({ triangles: 30e6, confidence: 'exact' }, { ...ctx, budget: 6e6, desktop: true }),
    /desktop build handles up to 24,000,000\. Simplify or split the model before importing\.$/);
});
