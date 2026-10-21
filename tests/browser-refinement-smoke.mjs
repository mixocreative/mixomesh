// Refinement UI smoke: import a real Mixo GLB through AssetLoader, assert the
// Properties refinement section starts Off (no automatic subdivision), build
// level 1 manually, preview it, and check ExportContext selects the refined
// part for export (source hidden) and the original again after switching back.
//   node tests/browser-refinement-smoke.mjs   (or: npm run test:refinement)

import { existsSync, mkdtempSync } from 'node:fs';
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

const SECTION_TEXT = "(document.querySelector('.mixo-refine-section')?.innerText ?? '')";
const click = selector => `document.querySelector('.mixo-refine-section ${selector}').click()`;

const IMPORT_TETRA = `(async () => {
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]);
  const indices = new Uint16Array([0,2,1, 0,1,3, 0,3,2, 1,2,3]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, extras: { mixo_print_refinement: {
      version: 1, creaseByVertex: [0,0,0,0], sharpEdges: [[0,1,1]] } } }] }],
    nodes: [{ mesh: 0, name: 'Mixo tetrahedron', extras: { mixo_origin: 'mixo3d', mixo_marker_version: 1,
      mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2 } }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (4 - json.length % 4) % 4;
  const jsonChunk = new Uint8Array(json.length + jsonPad).fill(0x20);
  jsonChunk.set(json);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(jsonChunk, 20);
  const o = 20 + jsonChunk.length;
  dv.setUint32(o, bin.length, true); dv.setUint32(o + 4, 0x004E4942, true); out.set(bin, o + 8);
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  return AssetLoader.loadFromBlob(new Blob([out], { type: 'model/gltf-binary' }), 'mixo-tetra.glb');
})()`;

const exportSelection = sourceId => `(async () => {
  const { getState } = await import('/src/core/StateManager.js');
  const { collectPrintUnits, buildExportContext } = await import('/src/core/print/ExportContext.js');
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const state = getState();
  const unit = buildExportContext({ state, units: collectPrintUnits(state, false) }).units[0];
  return {
    representation: unit.representation,
    level: unit.parts[0].mesh.metadata?.level ?? null,
    pickedVisible: unit.parts[0].mesh.isVisible,
    sourceVisible: AssetLoader.getBabylonMesh(${JSON.stringify(sourceId)}).isVisible,
  };
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-refinement-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle',
    '--enable-unsafe-swiftshader', '--window-size=1600,950', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.exceptionThrown') failures.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete' && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader`), 30000, 'app boot');

    const ids = await evaluate(cdp, IMPORT_TETRA);
    assert(Array.isArray(ids) && ids.length > 0, 'import returned no scene object');
    await waitFor(() => evaluate(cdp, "!!document.querySelector('.mixo-refine-section')"), 15000, 'refinement section');
    const initial = await evaluate(cdp, SECTION_TEXT);
    assert(initial.includes('Mixo 3D'), `section names the Mixo 3D origin: ${initial}`);
    assert(initial.includes('Off'), `refinement starts Off: ${initial}`);
    assert(await evaluate(cdp, "!document.querySelector('.mixo-refine-section progress')"), 'import started subdivision automatically');

    await evaluate(cdp, click('[data-action="refine-level"][data-level="1"]'));
    await evaluate(cdp, click('[data-action="refine-build"]'));
    await waitFor(() => evaluate(cdp, `(() => { const t = ${SECTION_TEXT}; return t.includes('Ready') || t.includes('failed'); })()`),
      30000, 'refinement build result');
    const built = await evaluate(cdp, SECTION_TEXT);
    assert(built.includes('Ready'), `build did not become Ready: ${built}`);

    await evaluate(cdp, click('[data-action="refine-preview"][data-preview="refined"]'));
    const preview = await evaluate(cdp, SECTION_TEXT);
    assert(preview.includes('Temporary refined preview'), `preview banner missing: ${preview}`);
    const refined = await evaluate(cdp, exportSelection(ids[0]));
    assert(JSON.stringify(refined) === JSON.stringify({ representation: 'refined', level: 1, pickedVisible: true, sourceVisible: false }),
      `refined export selection: ${JSON.stringify(refined)}`);

    await evaluate(cdp, click('[data-action="refine-preview"][data-preview="original"]'));
    const original = await evaluate(cdp, exportSelection(ids[0]));
    assert(original.representation === 'original' && original.sourceVisible === true,
      `original export selection: ${JSON.stringify(original)}`);

    assert(failures.length === 0, `page exceptions: ${failures.join(' | ')}`);
    console.log('PASS browser refinement smoke: import, manual build, both export representations');
    cdp.close?.();
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
