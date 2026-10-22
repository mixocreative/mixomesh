// UV transform export check (cia C-04). Loads the quadrant-quad glTF in the
// real app, gives it a UV Override (offset + scale + rotation) through
// ShaderLibrary, renders it, and reads the viewport colour at barycentric
// points on each triangle. Then it exports OBJ through the real PrintManager
// (repair off, so vertex order is kept) and has python trimesh (an independent
// consumer) sample the exported texture at the same barycentric points. Every point away from a quadrant edge must
// show the same colour in both. The same points sampled at the untransformed
// UVs must disagree, so the check can tell a lost transform from a kept one.
// Not part of `npm test` (needs Chrome + Vite + python trimesh):
//
//   node tests/browser-uv-transform-c04.mjs
//
// UV_OUT=<dir> keeps the render and the exported OBJ zip there.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget, resolveCommand,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const FIXTURE = join(ROOT, 'tests/fixtures/quadrant-quad.glb');
const SAMPLER = join(ROOT, 'tests/fixtures/obj-uv-sample.py');
const OUT = process.env.UV_OUT ? resolve(process.env.UV_OUT) : null;
const UV_OVERRIDE = { offsetX: 0.3, offsetY: 0.15, scaleX: 1.7, scaleY: 1.3, rotation: 0.6 };

const PAGE = (uvOverride) => `(async () => {
  try {
    const { AssetLoader } = await import('/src/core/AssetLoader.js');
    const { PrintManager } = await import('/src/core/PrintManager.js');
    const { setUVOverride } = await import('/src/core/ShaderLibrary.js');
    const blob = await (await fetch('/tests/fixtures/quadrant-quad.glb')).blob();
    const [id] = await AssetLoader.loadFromBlob(blob, 'quadrant-quad.glb');
    setUVOverride(id, ${JSON.stringify(uvOverride)});
    const root = AssetLoader.getBabylonMesh(id);
    const mesh = root.getTotalVertices?.() > 0 ? root : root.getChildMeshes().find(m => m.getTotalVertices() > 0);
    const scene = mesh.getScene();
    const tex = mesh.material.diffuseTexture || mesh.material.albedoTexture;
    for (let i = 0; i < 400 && !(tex.isReady() && mesh.isReady(true)); i++) await new Promise(r => setTimeout(r, 25));
    await scene.whenReadyAsync();
    let prev = '';
    for (let i = 0; i < 100; i++) {
      root.computeWorldMatrix(true);
      const b = root.getHierarchyBoundingVectors(true);
      const sig = [b.min.x, b.min.y, b.max.x, b.max.y].map(n => n.toFixed(6)).join();
      if (sig === prev) break;
      prev = sig;
      await new Promise(r => setTimeout(r, 200));
    }
    const keep = new Set([root, ...root.getChildMeshes()]);
    const hidden = scene.meshes.filter(m => !keep.has(m) && m.isEnabled());
    hidden.forEach(m => m.setEnabled(false));

    mesh.computeWorldMatrix(true);
    const W = mesh.getWorldMatrix();
    const pos = mesh.getVerticesData('position');
    const idx = Array.from(mesh.getIndices());
    const world = i => BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.FromArray(pos, i * 3), W);
    const samples = [];
    const N = 8;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      for (let a = 1; a < N; a++) for (let b = 1; a + b < N; b++) {
        const bary = [a / N, b / N, 1 - (a + b) / N];
        const verts = [idx[t], idx[t + 1], idx[t + 2]];
        const p = world(verts[0]).scale(bary[0]).add(world(verts[1]).scale(bary[1])).add(world(verts[2]).scale(bary[2]));
        samples.push({ verts, bary, p });
      }
    }
    const { min, max } = root.getHierarchyBoundingVectors(true);
    const c = min.add(max).scale(0.5);
    const span = Math.max(max.x - min.x, max.y - min.y);
    const cam = new BABYLON.ArcRotateCamera('uvCam', -Math.PI / 2, Math.PI / 2, span * 3, c, scene);
    cam.minZ = span / 100; cam.maxZ = span * 100;
    const SIZE = 600;
    const shoot = async (side) => {
      cam.alpha = side === 'front' ? -Math.PI / 2 : Math.PI / 2;
      cam.computeWorldMatrix(true);
      scene.render();
      const url = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(scene.getEngine(), cam, { width: SIZE, height: SIZE });
      const img = new Image(); img.src = url; await img.decode();
      const cv = document.createElement('canvas'); cv.width = SIZE; cv.height = SIZE;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
      const vp = cam.viewport.toGlobal(SIZE, SIZE);
      const vpm = cam.getViewMatrix().multiply(BABYLON.Matrix.PerspectiveFovLH(cam.fov, 1, cam.minZ, cam.maxZ));
      return { png: url.split(',')[1], rgb: samples.map(s => {
        const q = BABYLON.Vector3.Project(s.p, BABYLON.Matrix.Identity(), vpm, vp);
        return [...g.getImageData(Math.round(q.x), Math.round(q.y), 1, 1).data.slice(0, 3)];
      }) };
    };
    const sides = {};
    try {
      for (const side of ['front', 'back']) sides[side] = await shoot(side);
      // Overlays (axes, cursor) draw on top of the quad; a render without the
      // quad shows which sample pixels they cover.
      root.setEnabled(false);
      for (const side of ['front', 'back']) sides[side].overlay = (await shoot(side)).rgb;
      root.setEnabled(true);
    } finally {
      cam.dispose();
      hidden.forEach(m => m.setEnabled(true));
    }
    let captured = null;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { captured = d; }, close: async () => {} }) });
    await PrintManager.exportOBJ({ acknowledgeWarnings: true, repair: false });
    const u8 = new Uint8Array(captured.arrayBuffer ? await captured.arrayBuffer() : captured);
    let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return {
      sides, samples: samples.map(({ verts, bary }) => ({ verts, bary })),
      rawUV: Array.from(mesh.getVerticesData('uv')),
      worldPos: Array.from({ length: pos.length / 3 }, (_, i) => world(i).asArray()),
      textureMatrix: Array.from(tex.getTextureMatrix().m), obj: btoa(bin),
    };
  } catch (err) { return { error: String(err?.stack ?? err) }; }
})()`;

function colourClass([r, g, b]) {
  const max = Math.max(r, g, b);
  if (max < 30) return 'dark';
  if (Math.min(r, g, b) > max * 0.75) return 'white';
  if (r === max && r > 1.6 * Math.max(g, b)) return 'red';
  if (g === max && g > 1.6 * Math.max(r, b)) return 'green';
  if (b === max && b > 1.6 * Math.max(r, g)) return 'blue';
  return `?${r},${g},${b}`;
}

// A uv within this distance of a quadrant edge (0 or 0.5 after wrapping) can
// legitimately differ between bilinear (viewport) and nearest (trimesh).
function nearQuadrantEdge([u, v]) {
  const d = x => { const f = ((x % 0.5) + 0.5) % 0.5; return Math.min(f, 0.5 - f); };
  return d(u) < 0.04 || d(v) < 0.04;
}

// With repair off the textured export clone keeps the scene's vertex order.
// Prove it: one signed axis permutation must map every scene vertex i onto OBJ
// vertex i (both centred and normalised).
function assertSameVertexOrder(scene, obj) {
  assert(scene.length === obj.length, `OBJ has ${obj.length} vertices, the scene mesh ${scene.length}`);
  const norm = pts => {
    const c = [0, 1, 2].map(a => pts.reduce((s, p) => s + p[a], 0) / pts.length);
    const r = Math.max(...pts.flatMap(p => p.map((x, a) => Math.abs(x - c[a])))) || 1;
    return pts.map(p => p.map((x, a) => (x - c[a]) / r));
  };
  const S = norm(scene), O = norm(obj);
  const ok = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].some(perm =>
    Array.from({ length: 8 }, (_, signs) => signs).some(signs => S.every((p, i) =>
      perm.every((a, k) => Math.abs(p[a] * ((signs >> k) & 1 ? -1 : 1) - O[i][k]) < 1e-4))));
  assert(ok, 'exported OBJ vertices are not in scene vertex order');
}

function trimeshSample(objPath, samples, dir, name) {
  const py = resolveCommand('python') ?? resolveCommand('python3');
  assert(py, 'python not found (needs trimesh)');
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(samples));
  const r = spawnSync(py, ['-I', SAMPLER, objPath, file], { encoding: 'utf8' });
  assert(r.status === 0, `trimesh sampler failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function main() {
  assert(existsSync(FIXTURE), 'Fixture missing; run: node tests/fixtures/make-quadrant-quad.mjs');
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge executable not found.');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-uv-'));
  const work = OUT ?? mkdtempSync(join(tmpdir(), 'mixomesh-uv-out-'));
  mkdirSync(work, { recursive: true });
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
    const target = await openTarget(debugPort, 'about:blank');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // Other sessions edit src/ while this runs; Vite's HMR socket would reload
    // the page mid-check, so the page never gets one.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
      const Real = WebSocket;
      window.WebSocket = function (url, protocols) {
        if (String(protocols).includes('vite-hmr')) return { readyState: 0, addEventListener() {}, send() {}, close() {} };
        return new Real(url, protocols);
      };
    }` });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/index.html` });
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete'
      && location.pathname.endsWith('/index.html') && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')`), 30000, 'app boot');
    const res = await evaluate(cdp, PAGE(UV_OVERRIDE));
    if (res?.error) throw new Error(res.error);
    await cdp.close();

    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(Buffer.from(res.obj, 'base64'));
    const objName = Object.keys(zip.files).find(n => n.endsWith('.obj'));
    for (const [name, f] of Object.entries(zip.files)) {
      if (f.dir) continue;
      mkdirSync(join(work, name, '..'), { recursive: true });
      writeFileSync(join(work, name), await f.async('uint8array'));
    }
    if (OUT) writeFileSync(join(work, 'export-obj.zip'), Buffer.from(res.obj, 'base64'));
    const objText = String(await zip.file(objName).async('string'));
    const objPos = objText.split('\n').filter(l => l.startsWith('v ')).map(l => l.slice(2).trim().split(/\s+/).map(Number));
    assertSameVertexOrder(res.worldPos, objPos);
    const exported = trimeshSample(join(work, objName), res.samples, work, 'samples');
    // The quad is single-sided; the side that shows it shows several colours,
    // the other shows only background.
    const distinct = s => new Set(res.sides[s].rgb.map(colourClass)).size;
    const side = distinct('front') >= distinct('back') ? 'front' : 'back';
    if (OUT) writeFileSync(join(work, 'viewport.png'), Buffer.from(res.sides[side].png, 'base64'));

    // Untransformed control: the same OBJ with its vt lines replaced by the raw UVs.
    let k = 0;
    const rawObj = objText.split('\n').map(l => {
      if (!l.startsWith('vt ')) return l;
      const i = k++;
      return `vt ${res.rawUV[i * 2]} ${res.rawUV[i * 2 + 1]}`;
    }).join('\n');
    const rawPath = join(work, objName.replace(/\.obj$/, '_rawuv.obj'));
    writeFileSync(rawPath, rawObj);
    const control = trimeshSample(rawPath, res.samples, work, 'control');

    let compared = 0, controlDiffers = 0;
    const mismatches = [];
    const covered = rgb => Math.max(...rgb) - Math.min(...rgb) > 40;
    res.samples.forEach((s, i) => {
      if (nearQuadrantEdge(exported[i].uv) || covered(res.sides[side].overlay[i])) return;
      const view = colourClass(res.sides[side].rgb[i]);
      const file = colourClass(exported[i].rgba);
      compared++;
      if (view !== file) mismatches.push({ bary: s.bary, verts: s.verts, uv: exported[i].uv, view, file });
      if (!nearQuadrantEdge(control[i].uv) && colourClass(control[i].rgba) !== view) controlDiffers++;
    });
    console.log(JSON.stringify({ side, textureMatrix: res.textureMatrix, compared, mismatches: mismatches.length, controlDiffers }, null, 1));
    assert(compared >= 20, `only ${compared} samples away from quadrant edges`);
    assert(controlDiffers >= 5, `the untransformed UVs agree with the viewport too (${controlDiffers} differ); the check cannot see a lost transform`);
    assert(mismatches.length === 0, `exported OBJ texture differs from the viewport at ${mismatches.length}/${compared} points: ${JSON.stringify(mismatches.slice(0, 5))}`);
    console.log(`PASS trimesh reads the exported OBJ texture with the viewport's colour at all ${compared} points (untransformed UVs disagree at ${controlDiffers})`);
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
    if (!OUT) removeTempDir(work);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
