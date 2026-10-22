// Texture bytes survive save and reopen (L2-02). Imports the mid-tone cube
// glTF, exports 3MF and OBJ, round-trips the project through the real
// _buildDocument / _loadProject, exports again, and requires the packaged
// texture PNGs to be byte-identical. A double sRGB encode leaves 0 and 255
// alone, so the fixture is all mid-tones. Needs Chrome + Vite:
//
//   node tests/browser-texture-reopen-l2.mjs

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { assert, launchApp } from './cdp-harness.mjs';
import { FACE_COLOURS } from './fixtures/make-midtone-cube.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
assert(existsSync(join(ROOT, 'tests/fixtures/midtone-cube.glb')), 'Fixture missing; run: node tests/fixtures/make-midtone-cube.mjs');

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
  const { getTextureSource } = await import('/src/core/assets/TextureSource.js');
  const { getState } = await import('/src/core/StateManager.js');
  const pm = await import('/src/core/PersistenceManager.js');
  const texIds = () => Object.values(getState().scene.assetLibrary).filter(a => a.kind === 'texture').map(a => a.id);
  const exportBoth = async () => ({
    tmf: await capture(() => PrintManager.exportThreeMF({ acknowledgeWarnings: true })),
    obj: await capture(() => PrintManager.exportOBJ({ acknowledgeWarnings: true })),
  });

  const blob = await (await fetch('/tests/fixtures/midtone-cube.glb')).blob();
  await AssetLoader.loadFromBlob(blob, 'midtone-cube.glb');
  await until(() => texIds().length === 1 && getTextureSource(texIds()[0]), 'fresh texture source');
  const tex = AssetLoader.getBabylonTexture(texIds()[0]);
  const live = { gammaSpace: tex.gammaSpace, srgbBuffer: !!tex._texture?._useSRGBBuffer };
  const fresh = await exportBoth();

  const doc = JSON.parse(JSON.stringify(await pm.__test._buildDocument()));
  await pm.__test._loadProject(doc);
  await until(() => texIds().length === 1 && AssetLoader.getBabylonTexture(texIds()[0])?.isReady?.(), 'reopened texture');
  const sourceAfterReopen = !!getTextureSource(texIds()[0]);
  const reopened = await exportBoth();
  return { live, sourceAfterReopen, fresh, reopened };
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
    const expectedMean = [0, 1, 2].map(k => Math.round(FACE_COLOURS.reduce((s, c) => s + c[k], 0) / FACE_COLOURS.length));
    console.log(JSON.stringify({ live: res.live, sourceAfterReopen: res.sourceAfterReopen, expectedMean }));
    for (const kind of ['tmf', 'obj']) {
      const before = await texturePngs(res.fresh[kind]);
      const after = await texturePngs(res.reopened[kind]);
      const names = Object.keys(before);
      assert(names.length === 1, `${kind}: fresh export should carry one texture, got ${names}`);
      assert(JSON.stringify(Object.keys(after)) === JSON.stringify(names), `${kind}: reopened texture names ${Object.keys(after)} differ from ${names}`);
      const a = await app.run(DECODE(before[names[0]].toString('base64')));
      const b = await app.run(DECODE(after[names[0]].toString('base64')));
      console.log(`${kind} ${names[0]} fresh mean ${a.mean} reopened mean ${b.mean}`);
      assert(JSON.stringify(a.mean) === JSON.stringify(expectedMean), `${kind}: fresh export mean ${a.mean} should equal the source ${expectedMean}`);
      assert(before[names[0]].equals(after[names[0]]), `${kind}: reopened texture bytes differ from the fresh export (mean ${a.mean} -> ${b.mean})`);
    }
    assert(app.exceptions.length === 0, `page exceptions: ${app.exceptions.join(' | ')}`);
    console.log('PASS texture PNGs are byte-identical after save and reopen, for 3MF and OBJ');
  } finally {
    await app.close();
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
