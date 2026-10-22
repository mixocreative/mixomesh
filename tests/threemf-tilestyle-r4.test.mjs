// The 3MF loader honours `tilestyleu/v` (Materials ext ch.6): a texture the
// writer emitted as clamped comes back clamped, mirror comes back mirrored,
// and the default is wrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;
URL.createObjectURL ??= () => 'blob:fake';
const JSZip = createRequire(import.meta.url)('jszip');
const { Texture } = BABYLON;
const Loader = await import('../src/core/ThreeMFLoader.js');
const { buildMaterialsExtEntries } = await import('../src/core/print/ThreeMFWriter.js');
const { setTextureSource } = await import('../src/core/assets/TextureSource.js');

const scene = new BABYLON.Scene(new BABYLON.NullEngine({ renderWidth: 8, renderHeight: 8, textureSize: 8 }));
const TEX_ID = 'r4-tile-tex';

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
function babylonTexture(over) {
  const t = Object.create(Texture.prototype);
  Object.assign(t, {
    name: 'paint', metadata: { mixoAssetId: TEX_ID },
    uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0, vAng: 0, wAng: 0,
    uRotationCenter: 0.5, vRotationCenter: 0.5, wRotationCenter: 0.5,
    homogeneousRotationInUVTransform: false, wrapU: 1, wrapV: 1,
  }, over);
  return t;
}

function texturedTri(over) {
  return {
    name: 'Part',
    material: { id: 'Paint', name: 'Paint', diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: babylonTexture(over) },
    getVerticesData: (k) => (k === 'uv' ? new Float32Array([0, 0, 1, 0, 0, 1])
      : k === 'position' ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
    getIndices: () => [0, 1, 2],
  };
}

async function roundTrip(mesh) {
  const entries = await buildMaterialsExtEntries([{ mesh }]);
  const zip = new JSZip();
  for (const { path, data } of entries) {
    zip.file(path, typeof data === 'string' ? data : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const opened = await Loader.__test.openZip(JSZip, bytes);
  const xml = await opened.file('3D/3dmodel.model').async('text');
  const container = await Loader.__test.buildContainer(scene, opened, xml, { modelPath: '3D/3dmodel.model' });
  const tex = container.materials[0]?.diffuseTexture;
  assert.ok(tex, 'textured material imported');
  return { xml, wrapU: tex.wrapU, wrapV: tex.wrapV };
}

test('a clamped texture round-trips through the writer and loader as clamped', async () => {
  const { xml, wrapU, wrapV } = await roundTrip(texturedTri({ wrapU: 0, wrapV: 0 }));
  assert.match(xml, /tilestyleu="clamp" tilestylev="clamp"/);
  assert.deepEqual([wrapU, wrapV], [Texture.CLAMP_ADDRESSMODE, Texture.CLAMP_ADDRESSMODE]);
});

test('a repeating texture round-trips as wrap (the Materials-extension default)', async () => {
  const { xml, wrapU, wrapV } = await roundTrip(texturedTri({}));
  assert.doesNotMatch(xml, /tilestyle/);
  assert.deepEqual([wrapU, wrapV], [Texture.WRAP_ADDRESSMODE, Texture.WRAP_ADDRESSMODE]);
});

test('mirror and none per axis, and an unknown style reads as wrap', async () => {
  const model = (u, v) => '<?xml version="1.0" encoding="UTF-8"?>'
    + '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
    + ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources>'
    + `<m:texture2d id="1" path="/3D/Texture/skin.png" contenttype="image/png" tilestyleu="${u}" tilestylev="${v}"/>`
    + '<m:texture2dgroup id="2" texid="1"><m:tex2coord u="0" v="0"/><m:tex2coord u="1" v="0"/><m:tex2coord u="0" v="1"/></m:texture2dgroup>'
    + '<object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>'
    + '<triangles><triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/></triangles></mesh></object>'
    + '</resources><build><item objectid="3"/></build></model>';
  const zip = { file: (p) => (p === '3D/Texture/skin.png' ? { async: async () => new Uint8Array([1, 2]) } : null) };
  const wraps = async (u, v) => {
    const c = await Loader.__test.buildContainer(scene, zip, model(u, v));
    return [c.materials[0].diffuseTexture.wrapU, c.materials[0].diffuseTexture.wrapV];
  };
  assert.deepEqual(await wraps('mirror', 'none'), [Texture.MIRROR_ADDRESSMODE, Texture.CLAMP_ADDRESSMODE]);
  assert.deepEqual(await wraps('Clamp', 'bogus'), [Texture.CLAMP_ADDRESSMODE, Texture.WRAP_ADDRESSMODE]);
});
