// Functional browser smoke: import an OPEN tetrahedron (3 of 4 faces) →
// assert the validator caches a `holes` result → run the real one-click
// repair (`MeshValidator.repairObject`) → assert it filled the hole →
// export 3MF through the real pipeline → unzip and verify the solid is
// actually watertight (signed volume ≈ +1000 mm³, every edge used exactly
// twice) → assert the triangle-budget HUD and the cost-quote block both
// render live numbers for this solid.
//
// Launch/CDP plumbing copied from tests/browser-export-smoke.mjs (same
// conventions). Run separately from the Node test suite:
//
//   node tests/fixtures/make-open-tetra.mjs   # once, regenerates fixture
//   node tests/browser-repair-smoke.mjs
//
// watertight-repair-and-cost task 8.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const FIXTURE = join(ROOT, 'tests/fixtures/open-tetra.glb');
const CDP_COMMAND_TIMEOUT_MS = 30000;
const EXPECTED_VOLUME_MM3 = 1000;
const VOLUME_TOLERANCE = 0.01; // 1%

async function main() {
  if (!existsSync(FIXTURE)) {
    throw new Error('Fixture missing — run: node tests/fixtures/make-open-tetra.mjs');
  }
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-repair-smoke-'));

  const vite = spawn(process.execPath, [
    VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));

  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--enable-experimental-web-platform-features',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`,
    'about:blank',
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
      if (msg.method === 'Runtime.exceptionThrown') {
        failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text ?? 'unknown'}`);
      }
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && location.pathname.endsWith('/index.html')
      && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader
      && !!document.querySelector('#renderCanvas')
    `), 30000, 'app boot completion');

    // Import the open-tetra fixture through the REAL AssetLoader path, then
    // validate → repair → export through the REAL MeshValidator/PrintManager,
    // all inside one page-context script so intermediate state (the mesh,
    // the validation cache) never has to cross the CDP boundary.
    const result = await evaluate(cdp, `(async () => {
      try {
        const fixtureRes = await fetch('/tests/fixtures/open-tetra.glb');
        if (!fixtureRes.ok) return { error: 'fixture fetch failed: ' + fixtureRes.status };
        const blob = await fixtureRes.blob();

        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const meshIds = await AssetLoader.loadFromBlob(blob, 'open-tetra.glb');
        if (meshIds.length !== 1) return { error: 'expected 1 imported mesh, got ' + meshIds.length };
        const meshId = meshIds[0];
        const mesh = AssetLoader.getBabylonMesh(meshId);
        if (!mesh) return { error: 'imported mesh not registered' };

        // Validate BEFORE repair — the cache must carry a 'holes' result
        // (this is the CIA finding this task closes: "no hole filling").
        const { MeshValidator } = await import('/src/core/MeshValidator.js');
        const { getState } = await import('/src/core/StateManager.js');
        const before = await MeshValidator.validateMesh(mesh);
        const cacheBefore = getState().scene.validation?.[meshId];
        const holesResultBefore = cacheBefore?.results?.find(r => r.type === 'holes');
        if (!holesResultBefore) {
          return { error: 'validation cache has no holes result before repair: ' + JSON.stringify(before) };
        }

        // Repair through the shared one-click entry point (same path as the
        // import toast / Outliner badge / context menu / Print panel).
        const repair = await MeshValidator.repairObject(meshId);
        if (!(repair.holesFilled >= 1)) {
          return { error: 'repairObject did not report holesFilled >= 1: ' + JSON.stringify(repair) };
        }

        // Live-mesh diagnostics (fix round 1) — pins the exact scene state
        // right after repair, independent of export: this is what caught the
        // "HUD read tris 8 for a 4-triangle solid" defect (an export clone
        // sharing the source meshId was double-counted; fixed in
        // MeshStats.countSceneTriangles, not here — the live mesh itself was
        // always correct, as this dump proves).
        const { diagnoseMesh } = await import('/src/core/repair/MeshRepair.js');
        const scene = mesh.getScene();
        const meshDump = scene.meshes
          .filter(m => m.metadata?.meshId)
          .map(m => [m.name, m.metadata.meshId, (m.getTotalIndices?.() ?? 0) / 3]);
        const liveTris = (mesh.getTotalIndices?.() ?? 0) / 3;
        const liveVerts = mesh.getTotalVertices?.() ?? 0;
        const liveDiag = await diagnoseMesh(mesh);
        const diag = { meshDump, liveTris, liveVerts, liveDiag };

        // Export the REAL scene through the REAL 3MF pipeline, save picker
        // stubbed to capture bytes (same pattern as browser-export-smoke.mjs).
        let captured = null, suggested = null;
        window.showSaveFilePicker = async (opts) => {
          suggested = opts?.suggestedName ?? null;
          return { createWritable: async () => ({
            write: async (data) => { captured = data; },
            close: async () => {},
          }) };
        };
        const { PrintManager } = await import('/src/core/PrintManager.js');
        await PrintManager.exportThreeMF({});
        if (!captured) return { error: 'export captured no bytes' };
        const buf = new Uint8Array(
          captured.arrayBuffer ? await captured.arrayBuffer() : captured);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        }

        // HUD triangle-budget readout (task 7) — always-on centre segment.
        const hudText = document.querySelector('#sb-center')?.textContent ?? '';

        // Cost-quote block (task 6) — open the Print panel's Export tab and
        // read the live #pp-cost-total for this now-watertight solid.
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        document.querySelector('#rp-print-body [data-tab="export"]')?.click();
        await frame();
        const costText = document.querySelector('#pp-cost-total')?.textContent ?? '';

        return {
          meshId, holesFilled: repair.holesFilled, nmFixed: repair.nmFixed,
          remaining: repair.remaining, suggested, b64: btoa(bin), hudText, costText, diag,
        };
      } catch (err) {
        return { error: String(err?.stack ?? err) };
      }
    })()`);

    if (result?.error) throw new Error(`In-page repair/export failed: ${result.error}`);
    assert(/_r1to1\.3mf$/.test(result.suggested ?? ''),
      `suggested filename should end _r1to1.3mf, got ${result.suggested}`);
    console.log(`repairObject: holesFilled=${result.holesFilled} nmFixed=${result.nmFixed}`);
    console.log('live-mesh diagnostics', JSON.stringify(result.diag, null, 2));

    // Root-cause pin (fix round 1): the LIVE mesh right after repair must be
    // exactly the closed 4-triangle solid, and it must be the ONLY mesh in
    // the scene carrying this meshId — if a second registered mesh ever
    // appears here, something is double-registering, not just double-
    // counting at the HUD layer.
    assert(result.diag.meshDump.length === 1,
      `expected exactly 1 registered mesh for this meshId, got ${result.diag.meshDump.length}: ${JSON.stringify(result.diag.meshDump)}`);
    assert(result.diag.liveTris === 4, `live mesh should have exactly 4 triangles after repair, got ${result.diag.liveTris}`);
    assert(result.diag.liveVerts === 4, `live mesh should have exactly 4 vertices after repair, got ${result.diag.liveVerts}`);
    assert(result.diag.liveDiag.isWatertight === true,
      `MeshRepair.diagnoseMesh on the live mesh should report isWatertight:true, got: ${JSON.stringify(result.diag.liveDiag)}`);
    assert(result.diag.liveDiag.boundaryEdges === 0,
      `live mesh should have 0 boundary edges after repair, got ${result.diag.liveDiag.boundaryEdges}`);

    const bytes = Buffer.from(result.b64, 'base64');
    // Optional: dump the exported 3MF for an external slicer check
    // (task 8 step 3, e.g. `prusa-slicer-console.exe --info`). Off by
    // default — set MIXO_WRITE_3MF to a file path to enable.
    if (process.env.MIXO_WRITE_3MF) {
      writeFileSync(process.env.MIXO_WRITE_3MF, bytes);
      console.log(`wrote exported 3MF to ${process.env.MIXO_WRITE_3MF}`);
    }
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const modelXml = await zip.file('3D/3dmodel.model')?.async('text');
    assert(modelXml, '3D/3dmodel.model missing from exported package');

    const vertices = [...modelXml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
      .map(m => [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    const triangles = [...modelXml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    assert(vertices.length >= 4, `expected >=4 vertices in exported 3MF, got ${vertices.length}`);
    assert(triangles.length >= 4, `expected >=4 triangles (hole filled) in exported 3MF, got ${triangles.length}`);
    console.log(`exported solid: ${vertices.length} vertices, ${triangles.length} triangles`);

    // Signed volume via the divergence theorem (standard closed-mesh
    // formula, independent of PrintSpace's own implementation — an
    // intentionally separate check): V = (1/6) * sum(v0 . (v1 x v2)).
    let vol6 = 0;
    for (const [a, b, c] of triangles) {
      const [ax, ay, az] = vertices[a], [bx, by, bz] = vertices[b], [cx, cy, cz] = vertices[c];
      const crossX = by * cz - bz * cy;
      const crossY = bz * cx - bx * cz;
      const crossZ = bx * cy - by * cx;
      vol6 += ax * crossX + ay * crossY + az * crossZ;
    }
    const volume = vol6 / 6;
    const volumeError = Math.abs(Math.abs(volume) - EXPECTED_VOLUME_MM3) / EXPECTED_VOLUME_MM3;
    console.log(`signed volume: ${volume.toFixed(4)} mm^3 (expected +${EXPECTED_VOLUME_MM3}, error ${(volumeError * 100).toFixed(3)}%)`);
    assert(volume > 0, `exported solid volume should be positive (outward winding), got ${volume}`);
    assert(volumeError <= VOLUME_TOLERANCE,
      `exported solid volume ${volume.toFixed(4)} mm^3 is not within 1% of +${EXPECTED_VOLUME_MM3} mm^3`);

    // Watertight edge check: every undirected edge must be used by EXACTLY
    // two triangles (once in each direction, for a consistently outward-
    // wound closed 2-manifold).
    const edgeCount = new Map();
    for (const [a, b, c] of triangles) {
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const key = p < q ? `${p}:${q}` : `${q}:${p}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    const badEdges = [...edgeCount.entries()].filter(([, n]) => n !== 2);
    console.log(`edge-face map: ${edgeCount.size} unique edges, ${badEdges.length} not used exactly twice`);
    assert(badEdges.length === 0,
      `exported solid is not watertight — edges not used exactly twice: ${JSON.stringify(badEdges.slice(0, 10))}`);

    // HUD + cost assertions. Exact count (fix round 1) — the scene holds
    // exactly one 4-triangle solid at this point, post-export (export
    // clones must be disposed by now AND must never have been counted while
    // alive — MeshStats.countSceneTriangles fix), so the HUD's numeric
    // prefix must be exactly 4, not the pre-fix "8" (a doubled export clone).
    console.log(`HUD text: "${result.hudText}"`);
    const hudMatch = /^tris (\d+) \//.exec(result.hudText);
    assert(hudMatch, `HUD should read "tris <n> / <budget>", got: "${result.hudText}"`);
    assert(hudMatch[1] === '4', `HUD triangle count should read exactly 4, got "${hudMatch[1]}" (full text: "${result.hudText}")`);
    console.log(`cost block text: "${result.costText}"`);
    assert(result.costText && result.costText !== '—' && /\d/.test(result.costText),
      `#pp-cost-total should render a non-null number for this solid, got: "${result.costText}"`);

    if (failures.length) throw new Error(`Runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log(`PASS browser repair smoke — holesFilled=${result.holesFilled}, volume=${volume.toFixed(2)}mm^3, watertight, HUD "${result.hudText}", cost "${result.costText}"`);
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

// ── Shared plumbing (mirrors tests/browser-export-smoke.mjs) ─────────────

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Failed to open browser target: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Vite app:\n${output.join('').slice(-2000)}`);
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

function findBrowser() {
  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const absoluteCandidates = [
    join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    local ? join(local, 'Microsoft/Edge/Application/msedge.exe') : '',
  ];
  const absoluteMatch = absoluteCandidates.find(p => p && existsSync(p));
  if (absoluteMatch) return absoluteMatch;
  for (const command of ['google-chrome', 'chrome', 'chromium', 'msedge']) {
    const resolved = resolveCommand(command);
    if (resolved) return resolved;
  }
  return null;
}

function resolveCommand(command) {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args = process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`];
  const result = spawnSync(resolver, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? null;
}

async function waitForBrowserWs(port, stderr) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for DevTools endpoint:\n${stderr.join('').slice(-2000)}`);
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', rejectOpen, { once: true });
    });
    return cdp;
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: resolvePending, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolvePending(msg.result ?? {});
      } else {
        this.onEvent?.(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePending, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolvePending(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolveClose => {
      this.ws.addEventListener('close', resolveClose, { once: true });
      this.ws.close();
      setTimeout(resolveClose, 1000);
    });
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* navigating */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(value, message) { if (!value) throw new Error(message); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function removeTempDir(dir) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (err) {
      if (err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([once(killer, 'exit'), sleep(3000)]);
    } catch { try { child.kill(); } catch { /* gone */ } }
  } else {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  if (child.exitCode == null) await Promise.race([once(child, 'exit'), sleep(3000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

try {
  await main();
} catch (err) {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
