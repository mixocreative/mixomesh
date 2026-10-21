// Textured 3MF orientation check (cia C-01). Renders the quadrant-quad glTF in
// the real app, exports it to 3MF and OBJ through the real PrintManager, re-
// imports the 3MF, renders that too, and compares the colour seen at the same
// four world-space spots on each quad. The glTF render is the reference: it
// comes through Babylon's own glTF loader, so a mismatch after the round trip
// means our 3MF writer or loader flipped the texture. Not part of `npm test`
// (needs Chrome + Vite):
//
//   node tests/browser-3mf-orientation-c01.mjs
//
// ORIENT_OUT=<dir> also writes the two renders and the exported 3MF/OBJ files
// there, so an independent consumer (trimesh, a slicer) can read the same bytes.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const FIXTURE = join(ROOT, 'tests/fixtures/quadrant-quad.glb');
const OUT = process.env.ORIENT_OUT ? resolve(process.env.ORIENT_OUT) : null;

const PAGE_HELPERS = `
  window.__orient = {
    b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
    async capture(exportFn) {
      let captured = null;
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async (d) => { captured = d; }, close: async () => {},
      }) });
      await exportFn();
      if (!captured) throw new Error('export captured no bytes');
      return new Uint8Array(captured.arrayBuffer ? await captured.arrayBuffer() : captured);
    },
    // Renders only \`mesh\` (and its children) head-on and returns the colour
    // class at world-space bbox fractions (fx, fy) of its XY extent, plus the PNG.
    async render(mesh) {
      const scene = mesh.getScene();
      const keep = new Set([mesh, ...mesh.getChildMeshes()]);
      const hidden = scene.meshes.filter(m => !keep.has(m) && m.isEnabled() && m.isVisible);
      hidden.forEach(m => { m.isVisible = false; });
      for (const m of keep) {
        const t = m.material?.diffuseTexture || m.material?.albedoTexture;
        for (let i = 0; i < 200 && t && !t.isReady(); i++) await new Promise(r => setTimeout(r, 25));
      }
      let prev = '';
      for (let i = 0; i < 100; i++) {
        mesh.computeWorldMatrix(true);
        const b = mesh.getHierarchyBoundingVectors(true);
        const sig = [b.min.x, b.min.y, b.max.x, b.max.y].map(n => n.toFixed(6)).join();
        if (sig === prev) break;
        prev = sig;
        await new Promise(r => setTimeout(r, 200));
      }
      const { min, max } = mesh.getHierarchyBoundingVectors(true);
      const c = min.add(max).scale(0.5);
      const span = Math.max(max.x - min.x, max.y - min.y);
      const cam = new BABYLON.ArcRotateCamera('orientCam', -Math.PI / 2, Math.PI / 2, span * 3, c, scene);
      cam.minZ = span / 100; cam.maxZ = span * 100;
      const W = 400, H = 400;
      try {
        const out = {};
        for (const side of ['front', 'back']) {
          cam.alpha = side === 'front' ? -Math.PI / 2 : Math.PI / 2;
          cam.computeWorldMatrix(true);
          scene.render();
          const url = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(scene.getEngine(), cam, { width: W, height: H });
          const img = new Image(); img.src = url; await img.decode();
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
          const vp = cam.viewport.toGlobal(W, H);
          const proj = BABYLON.Matrix.PerspectiveFovLH(cam.fov, W / H, cam.minZ, cam.maxZ);
          const vpm = cam.getViewMatrix().multiply(proj);
          const samples = {};
          for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const p = new BABYLON.Vector3(min.x + fx * (max.x - min.x), min.y + fy * (max.y - min.y), c.z);
            const s = BABYLON.Vector3.Project(p, BABYLON.Matrix.Identity(), vpm, vp);
            const d = g.getImageData(Math.round(s.x), Math.round(s.y), 1, 1).data;
            samples[fx + ',' + fy] = { px: [Math.round(s.x), Math.round(s.y)], rgb: [d[0], d[1], d[2]] };
          }
          out[side] = { samples, png: url.split(',')[1] };
        }
        return out;
      } finally {
        cam.dispose();
        hidden.forEach(m => { m.isVisible = true; });
      }
    },
  };
`;

function colourClass([r, g, b]) {
  const max = Math.max(r, g, b);
  if (max < 30) return 'dark';
  if (Math.min(r, g, b) > max * 0.75) return 'white';
  if (r === max && r > 1.6 * Math.max(g, b)) return 'red';
  if (g === max && g > 1.6 * Math.max(r, b)) return 'green';
  if (b === max && b > 1.6 * Math.max(r, g)) return 'blue';
  return `?${r},${g},${b}`;
}

function classify(render) {
  const distinct = side => new Set(Object.values(render[side].samples).map(s => colourClass(s.rgb))).size;
  const side = distinct('front') >= distinct('back') ? 'front' : 'back';
  const map = {};
  for (const [k, s] of Object.entries(render[side].samples)) map[k] = colourClass(s.rgb);
  return { side, map, raw: render[side].samples };
}

async function main() {
  assert(existsSync(FIXTURE), 'Fixture missing; run: node tests/fixtures/make-quadrant-quad.mjs');
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge executable not found.');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-orient-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete'
      && location.pathname.endsWith('/index.html') && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')`), 30000, 'app boot');
    await evaluate(cdp, PAGE_HELPERS);

    const res = await evaluate(cdp, `(async () => {
      try {
        const O = window.__orient;
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const { PrintManager } = await import('/src/core/PrintManager.js');
        const blob = await (await fetch('/tests/fixtures/quadrant-quad.glb')).blob();
        const [origId] = await AssetLoader.loadFromBlob(blob, 'quadrant-quad.glb');
        const orig = await O.render(AssetLoader.getBabylonMesh(origId));
        const tmf = await O.capture(() => PrintManager.exportThreeMF({ acknowledgeWarnings: true }));
        const obj = await O.capture(() => PrintManager.exportOBJ({ acknowledgeWarnings: true }));
        const rtIds = await AssetLoader.loadFromBlob(new Blob([tmf]), 'roundtrip.3mf');
        const rtMesh = AssetLoader.getBabylonMesh(rtIds[0]);
        const rt = await O.render(rtMesh);
        const tex = rtMesh.material?.diffuseTexture;
        const again = await O.capture(() => PrintManager.exportThreeMF({ acknowledgeWarnings: true }));
        return { orig, rt, again: O.b64(again), tmf: O.b64(tmf), obj: O.b64(obj), rtInvertY: tex?.invertY ?? tex?._invertY ?? null };
      } catch (err) { return { error: String(err?.stack ?? err) }; }
    })()`);
    if (res?.error) throw new Error(res.error);

    const orig = classify(res.orig);
    const rt = classify(res.rt);
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'orig.png'), Buffer.from(res.orig[orig.side].png, 'base64'));
      writeFileSync(join(OUT, 'roundtrip.png'), Buffer.from(res.rt[rt.side].png, 'base64'));
      writeFileSync(join(OUT, 'export.3mf'), Buffer.from(res.tmf, 'base64'));
      writeFileSync(join(OUT, 'export-obj.zip'), Buffer.from(res.obj, 'base64'));
    }
    console.log(JSON.stringify({ orig, roundtrip: rt, rtInvertY: res.rtInvertY }, null, 1));
    const corners = Object.values(orig.map);
    assert(new Set(corners).size === 4 && corners.every(c => ['red', 'green', 'blue', 'white'].includes(c)),
      `reference glTF render should show four distinct texel colours, got ${JSON.stringify(orig.map)}`);
    for (const k of Object.keys(orig.map)) {
      assert(rt.map[k] === orig.map[k],
        `3MF round trip shows ${rt.map[k]} at world bbox (${k}) where the glTF shows ${orig.map[k]}; texture flipped`);
    }
    const { default: JSZip } = await import('jszip');
    const againZip = await JSZip.loadAsync(Buffer.from(res.again, 'base64'));
    const pngNames = Object.keys(againZip.files).filter(n => n.startsWith('3D/Textures/') && n.endsWith('.png'));
    const reexportPngs = [];
    for (const name of pngNames) {
      const b64 = Buffer.from(await againZip.file(name).async('uint8array')).toString('base64');
      reexportPngs.push({ name, ...await evaluate(cdp, `(async () => {
        const bin = atob('${b64}'); const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
        const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
        const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0);
        const at = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
        return { topLeft: at(0, 0), bottomLeft: at(0, bmp.height - 1) };
      })()`) });
    }
    assert(reexportPngs.length === 2, `re-export should carry the glTF's and the re-imported 3MF's textures, got ${reexportPngs.length}`);
    for (const png of reexportPngs) {
      assert(colourClass(png.bottomLeft) === 'red' && colourClass(png.topLeft) === 'blue',
        `re-exported ${png.name} should keep the source's red texel at the PNG bottom-left (3MF origin), got bottom-left ${png.bottomLeft} top-left ${png.topLeft}`);
    }
    await cdp.close();
    console.log('PASS 3MF texture orientation matches the glTF render at all four corners, and a re-export keeps it');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
