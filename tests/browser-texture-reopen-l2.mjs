// Texture bytes survive save and reopen (L2-02). Imports the mid-tone cube
// glTF, exports 3MF and OBJ, round-trips the project through the real
// _buildDocument / _loadProject, exports again, and requires the packaged
// texture PNGs to be byte-identical. It then drops the captured sources and
// requires the GPU readback fallback to keep the colours. A double sRGB
// encode leaves 0 and 255 alone, so the fixture is all mid-tones. Needs
// Chrome + Vite:
//
//   node tests/browser-texture-reopen-l2.mjs
//
// TEX_REOPEN_GLB=<repo-relative .glb> runs the same check on another model.

import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { assert, launchApp } from './cdp-harness.mjs';
import { FACE_COLOURS } from './fixtures/make-midtone-cube.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_GLB = 'tests/fixtures/midtone-cube.glb';
const GLB = (process.env.TEX_REOPEN_GLB || DEFAULT_GLB).split('\\').join('/');
assert(existsSync(join(ROOT, GLB)), `${GLB} missing; run: node tests/fixtures/make-midtone-cube.mjs`);

const SCENARIO = `(async () => {
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const capture = async (fn) => {
    let got = null;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { got = d; }, close: async () => {} }) });
    await fn();
    if (!got) throw new Error('export captured no bytes');
    return b64(new Uint8Array(got.arrayBuffer ? await got.arrayBuffer() : got));
  };
  const until = async (pred, label, ms = 15000) => {
    const t0 = performance.now();
    while (!pred()) {
      if (performance.now() - t0 > ms) throw new Error('timeout: ' + label);
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const { PrintManager } = await import('/src/core/PrintManager.js');
  const { getTextureSource, clearTextureSource } = await import('/src/core/assets/TextureSource.js');
  const { getState } = await import('/src/core/StateManager.js');
  const pm = await import('/src/core/PersistenceManager.js');
  const texIds = () => Object.values(getState().scene.assetLibrary).filter(a => a.kind === 'texture').map(a => a.id);
  const exportBoth = async () => ({
    tmf: await capture(() => PrintManager.exportThreeMF({ acknowledgeWarnings: true })),
    obj: await capture(() => PrintManager.exportOBJ({ acknowledgeWarnings: true })),
  });

  const blob = await (await fetch('/${GLB}')).blob();
  await AssetLoader.loadFromBlob(blob, '${basename(GLB)}');
  await until(() => texIds().length > 0 && texIds().every(id => getTextureSource(id)), 'fresh texture sources', 120000);
  const tex = AssetLoader.getBabylonTexture(texIds()[0]);
  const live = { textures: texIds().length, gammaSpace: tex.gammaSpace, srgbBuffer: !!tex._texture?._useSRGBBuffer };
  const fresh = await exportBoth();

  const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
  await pm.__test._loadProject(doc);
  await until(() => texIds().length === live.textures && texIds().every(id => AssetLoader.getBabylonTexture(id)?.isReady?.()), 'reopened textures', 120000);
  const sourceAfterReopen = texIds().every(id => getTextureSource(id));
  const reopened = await exportBoth();
  texIds().forEach(clearTextureSource);
  const readback = await capture(() => PrintManager.exportThreeMF({ acknowledgeWarnings: true }));
  return { live, sourceAfterReopen, fresh, reopened, readback };
})()`;

const DECODE = (b64) => `(async () => {
  const bin = atob('${b64}'); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
  const n = d.length / 4;
  return { w: bmp.width, h: bmp.height, mean: sum.map(s => Math.round(s / n)) };
})()`;

async function texturePngs(b64) {
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const out = {};
  for (const name of Object.keys(zip.files).filter(n => /\.png$/i.test(n) && !/thumbnail/i.test(n))) {
    out[name] = Buffer.from(await zip.file(name).async('uint8array'));
  }
  return out;
}

async function main() {
  const app = await launchApp({ prefix: 'mixomesh-texreopen-' });
  try {
    const res = await app.run(SCENARIO);
    const expectedMean = GLB === DEFAULT_GLB
      ? [0, 1, 2].map(k => Math.round(FACE_COLOURS.reduce((sum, c) => sum + c[k], 0) / FACE_COLOURS.length))
      : null;
    console.log(JSON.stringify({ glb: GLB, live: res.live, sourceAfterReopen: res.sourceAfterReopen, expectedMean }));
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const freshMean = {};
    for (const kind of ['tmf', 'obj']) {
      const before = await texturePngs(res.fresh[kind]);
      const after = await texturePngs(res.reopened[kind]);
      const names = Object.keys(before).sort();
      assert(names.length === res.live.textures, `${kind}: fresh export should carry ${res.live.textures} textures, got ${names}`);
      assert(same(Object.keys(after).sort(), names), `${kind}: reopened texture names ${Object.keys(after)} differ from ${names}`);
      for (const name of names) {
        const a = await app.run(DECODE(before[name].toString('base64')));
        const b = await app.run(DECODE(after[name].toString('base64')));
        console.log(`${kind} ${name} fresh mean ${a.mean} reopened mean ${b.mean}`);
        if (kind === 'tmf') freshMean[name] = a.mean;
        if (expectedMean) assert(same(a.mean, expectedMean), `${kind}: fresh export mean ${a.mean} should equal the source ${expectedMean}`);
        assert(before[name].equals(after[name]), `${kind}: reopened ${name} bytes differ from the fresh export (mean ${a.mean} -> ${b.mean})`);
      }
    }
    for (const [name, png] of Object.entries(await texturePngs(res.readback))) {
      const rb = await app.run(DECODE(png.toString('base64')));
      console.log(`readback fallback ${name} mean ${rb.mean}`);
      assert(rb.mean.every((v, k) => Math.abs(v - freshMean[name][k]) <= 1),
        `readback fallback ${name} mean ${rb.mean} should equal the fresh export ${freshMean[name]}; an sRGB-buffer texture was encoded twice`);
    }
    assert(app.exceptions.length === 0, `page exceptions: ${app.exceptions.join(' | ')}`);
    console.log('PASS texture PNGs are byte-identical after save and reopen, for 3MF and OBJ, and the readback fallback keeps the colours');
  } finally {
    await app.close();
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
