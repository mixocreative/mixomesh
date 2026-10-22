import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { installEnv } from './env.mjs';
installEnv();
const { Texture } = await import('@babylonjs/core/Materials/Textures/texture.js');
const { encodeOBJ } = await import('../src/core/print/ObjWriter.js');
const { encodeVRML } = await import('../src/core/print/WrlWriter.js');
const { encodeBinaryPLY } = await import('../src/core/print/PlyWriter.js');
const { buildMaterialsExtEntries } = await import('../src/core/print/ThreeMFWriter.js');
const { serializeOBJ } = await import('../src/core/print/ObjWriter.js');
const { setTextureSource } = await import('../src/core/assets/TextureSource.js');

const RAW_UV = [0, 0, 1, 0, 0, 1];
const TEX_ID = 'c04-tex';

function png2x2(rgba) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(2 * 9);
  for (let y = 0; y < 2; y++) Buffer.from(rgba.slice(y * 8, y * 8 + 8)).copy(raw, y * 9 + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
setTextureSource(TEX_ID, new Blob([png2x2([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])]), 2, 2);

// A real Babylon Texture's transform state (constructor defaults), without a scene.
function babylonTexture(transform) {
  const t = Object.create(Texture.prototype);
  Object.assign(t, {
    name: 'paint', metadata: { mixoAssetId: TEX_ID },
    uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0, vAng: 0, wAng: 0,
    uRotationCenter: 0.5, vRotationCenter: 0.5, wRotationCenter: 0.5,
    homogeneousRotationInUVTransform: false,
  }, transform);
  return t;
}

function texturedTri(transform) {
  return {
    name: 'Part',
    material: { id: 'Paint', name: 'Paint', diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: babylonTexture(transform) },
    getVerticesData: (k) => (k === 'uv' ? new Float32Array(RAW_UV)
      : k === 'position' ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
    getIndices: () => [0, 1, 2],
  };
}

const objUVs = (mesh) => encodeOBJ([{ mesh }]).split('\n')
  .filter(l => l.startsWith('vt ')).flatMap(l => l.slice(3).split(' ').map(Number));
const wrlUVs = (mesh) => {
  const block = encodeVRML([{ mesh }], new Map([[mesh, 'textures/paint.png']]))
    .match(/TextureCoordinate \{ point \[([^\]]*)\]/)[1];
  return block.split(',').flatMap(p => p.trim().split(/\s+/).map(Number));
};
const threeMfUVs = async (mesh) => {
  const entries = await buildMaterialsExtEntries([{ mesh }]);
  const model = String(entries.find(e => e.path === '3D/3dmodel.model').data);
  return [...model.matchAll(/<m:tex2coord u="([^"]+)" v="([^"]+)"\/>/g)].flatMap(m => [Number(m[1]), Number(m[2])]);
};
const plyST = (mesh) => {
  const u8 = encodeBinaryPLY([{ mesh }], new Map([[mesh, { rgba: [], width: 1, height: 1 }]]));
  const text = new TextDecoder('latin1').decode(u8);
  const end = text.indexOf('end_header\n') + 'end_header\n'.length;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return [0, 1, 2].flatMap(i => [view.getFloat32(end + i * 36 + 28, true), view.getFloat32(end + i * 36 + 32, true)]);
};

function assertClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: ${actual} vs ${expected}`);
  actual.forEach((a, i) => assert.ok(Math.abs(a - expected[i]) < 1e-5, `${label}: got [${actual}] expected [${expected}]`));
}

test('a UV Override offset reaches every writer that emits UVs', async () => {
  const mesh = texturedTri({ uOffset: 0.5 });
  const expected = [0.5, 0, 1.5, 0, 0.5, 1];
  assertClose(objUVs(mesh), expected, 'OBJ vt');
  assertClose(wrlUVs(mesh), expected, 'WRL texCoord');
  assertClose(await threeMfUVs(mesh), expected, '3MF tex2coord');
  assertClose(plyST(mesh), expected, 'PLY s/t');
});

test('offset + scale + rotation export the coordinates Babylon samples in the viewport', async () => {
  // Babylon 9 texture matrix for this transform maps (0,0) (1,0) (0,1) here.
  const mesh = texturedTri({ uOffset: 0.1, vOffset: 0.2, uScale: 2, vScale: 0.5, wAng: Math.PI / 2 });
  const expected = [1.35, -0.55, 1.35, 1.45, 0.85, -0.55];
  assertClose(objUVs(mesh), expected, 'OBJ vt');
  assertClose(wrlUVs(mesh), expected, 'WRL texCoord');
  assertClose(await threeMfUVs(mesh), expected, '3MF tex2coord');
  assertClose(plyST(mesh), expected, 'PLY s/t');
});

test('a glTF KHR_texture_transform atlas (rotation about the origin) exports its sub-rectangle', async () => {
  // Babylon's glTF loader sets rotation centres to 0 and wAng = -rotation.
  const mesh = texturedTri({ uOffset: 0.5, vOffset: 0, uScale: 0.5, vScale: 0.5,
    uRotationCenter: 0, vRotationCenter: 0, wRotationCenter: 0 });
  assertClose(objUVs(mesh), [0.5, 0, 1, 0, 0.5, 0.5], 'OBJ vt');
});

test('PLY vertex colours are sampled at the transformed UV', () => {
  // 2x2 image rows top-first: red green / blue white. UV (0,0) shifted to
  // (0.75, 0.25) is the centre of the bottom-right texel.
  const mesh = texturedTri({ uOffset: 0.75, vOffset: 0.25 });
  const img = { rgba: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], width: 2, height: 2 };
  const u8 = encodeBinaryPLY([{ mesh }], new Map([[mesh, img]]));
  const end = new TextDecoder('latin1').decode(u8).indexOf('end_header\n') + 'end_header\n'.length;
  assert.deepEqual([...u8.subarray(end + 24, end + 28)], [255, 255, 255, 255]);
});

test('an untransformed texture exports its UVs unchanged', async () => {
  const mesh = texturedTri({});
  assert.deepEqual(objUVs(mesh), RAW_UV);
  assert.deepEqual(await threeMfUVs(mesh), RAW_UV);
});

const CLAMP = { wrapU: 0, wrapV: 0 };
const IMG = { rgba: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], width: 2, height: 2 };

async function exportedFiles(mesh) {
  const out = await serializeOBJ({
    meshes: [{ mesh }], cloneGroups: [], individually: false,
    projectName: 'P', referenceRatio: 1, targetRatio: 1, prefs: {}, state: { print: {}, scene: { assetLibrary: {}, objects: {} } },
  });
  const files = Object.fromEntries(out.entries.map(e => [e.path, String(e.data)]));
  const threeMf = String((await buildMaterialsExtEntries([{ mesh }])).find(e => e.path === '3D/3dmodel.model').data);
  return {
    mtl: files['P_r1to1.mtl'],
    threeMf,
    wrl: encodeVRML([{ mesh }], new Map([[mesh, 'textures/paint.png']])),
  };
}

test('a clamped texture is written as clamped, so UVs past the edge print the edge texel', async () => {
  const { mtl, threeMf, wrl } = await exportedFiles(texturedTri({ uOffset: 0.25, ...CLAMP }));
  // No MTL `-clamp on`: trimesh takes the rest of the map_Kd line as the file
  // name and then loads no texture at all, which is worse than repeating.
  assert.match(mtl, /^map_Kd textures\/\S+\.png$/m);
  assert.match(threeMf, /<m:texture2d [^>]*tilestyleu="clamp" tilestylev="clamp"/);
  assert.match(wrl, /ImageTexture \{ url "textures\/paint\.png" repeatS FALSE repeatT FALSE \}/);
});

test('PLY samples a clamped texture at its edge texel instead of wrapping', () => {
  // Raw (1,0) shifted to (1.25, 0.25): repeat wraps to the bottom-left texel
  // (blue); clamp stays on the bottom-right texel (white), as the viewport does.
  const plyRgba = (mesh) => {
    const u8 = encodeBinaryPLY([{ mesh }], new Map([[mesh, IMG]]));
    const end = new TextDecoder('latin1').decode(u8).indexOf('end_header\n') + 'end_header\n'.length;
    return [...u8.subarray(end + 36 + 24, end + 36 + 28)];
  };
  assert.deepEqual(plyRgba(texturedTri({ uOffset: 0.25, vOffset: 0.25, ...CLAMP })), [255, 255, 255, 255]);
  assert.deepEqual(plyRgba(texturedTri({ uOffset: 0.25, vOffset: 0.25 })), [0, 0, 255, 255]);
});

test('a repeating texture carries no clamp flags', async () => {
  const { mtl, threeMf, wrl } = await exportedFiles(texturedTri({ uOffset: 0.25 }));
  assert.match(mtl, /^map_Kd textures\/\S+\.png$/m);
  assert.doesNotMatch(threeMf, /tilestyle/);
  assert.doesNotMatch(wrl, /repeat[ST]/);
});
