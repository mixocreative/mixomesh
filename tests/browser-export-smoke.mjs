// Functional browser smoke: textured import → Mimaki 3MF export → assert the
// exported texture PNG carries real (non-blank) pixel data. Closes the gap
// that hid review C1 (headless Babylon shim returns sync readPixels; real
// Babylon returns a Promise). Run separately from the Node test suite:
//
//   node tests/fixtures/make-textured-quad.mjs   # once, regenerates fixture
//   node tests/browser-export-smoke.mjs
//
// Launch/CDP plumbing mirrors tests/browser-smoke.mjs (same conventions).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const FIXTURE = join(ROOT, 'tests/fixtures/textured-quad.glb');
const CDP_COMMAND_TIMEOUT_MS = 30000;

async function main() {
  if (!existsSync(FIXTURE)) {
    throw new Error('Fixture missing — run: node tests/fixtures/make-textured-quad.mjs');
  }
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-export-smoke-'));

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

    // about:blank also has readyState 'complete' and no #boot-status — gate on
    // real app markers so the import/export script runs against the booted app.
    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && location.pathname.endsWith('/index.html')
      && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader
      && !!document.querySelector('#renderCanvas')
    `), 30000, 'app boot completion');

    // Import the textured fixture through the REAL AssetLoader path, then run
    // the REAL Mimaki 3MF export with the save picker stubbed to capture bytes.
    const result = await evaluate(cdp, `(async () => {
      try {
        const fixtureRes = await fetch('/tests/fixtures/textured-quad.glb');
        if (!fixtureRes.ok) return { error: 'fixture fetch failed: ' + fixtureRes.status };
        const blob = await fixtureRes.blob();

        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const meshIds = await AssetLoader.loadFromBlob(blob, 'textured-quad.glb');
        if (!meshIds.length) return { error: 'import produced no meshes' };

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
        return { meshCount: meshIds.length, suggested, b64: btoa(bin) };
      } catch (err) {
        return { error: String(err?.stack ?? err) };
      }
    })()`);

    if (result?.error) throw new Error(`In-page export failed: ${result.error}`);
    assert(result.meshCount >= 1, 'expected at least one imported mesh');
    assert(/_r1to1\.3mf$/.test(result.suggested ?? ''),
      `suggested filename should end _r1to1.3mf, got ${result.suggested}`);

    const bytes = Buffer.from(result.b64, 'base64');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);

    const modelXml = await zip.file('3D/3dmodel.model')?.async('text');
    assert(modelXml, '3D/3dmodel.model missing from exported package');
    assert(/<m:texture2d /.test(modelXml), 'model XML missing m:texture2d resource');
    assert(/<m:texture2dgroup /.test(modelXml), 'model XML missing m:texture2dgroup');

    const texEntries = Object.keys(zip.files).filter(p => /^3D\/Textures\/.+\.png$/.test(p));
    assert(texEntries.length === 1, `expected 1 texture PNG, got ${texEntries.length}`);
    const pngBytes = Buffer.from(await zip.file(texEntries[0]).async('uint8array'));

    // PNG structure + non-blank pixel data. All-zero inflated IDAT is the
    // exact signature of the C1 blank-export bug regardless of row filters.
    assert(pngBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
      'texture is not a PNG');
    const idat = collectIdat(pngBytes);
    assert(idat.length > 0, 'PNG has no IDAT data');
    const raw = inflateSync(idat);
    assert(raw.some(b => b !== 0), 'texture PNG pixel data is all zeros — blank export (C1 regression)');

    // Y-flip orientation assert (A2 follow-up). Convention contract:
    // glTF UV origin is TOP-left; 3MF Materials texture space origin is
    // BOTTOM-left. We write UVs through unchanged, so the spec-correct
    // exported PNG is the VERTICAL FLIP of the source image — the source's
    // top-left red texel must land at the exported PNG's BOTTOM-left
    // (fixture rows: red,green / blue,white in image order). This pins
    // EXPORT_FLIP_Y = true; a flip regression swaps the rows below.
    const px = decodeTinyPng(pngBytes, raw);
    assert(px.width === 2 && px.height === 2, `expected 2x2 texture, got ${px.width}x${px.height}`);
    const at = (x, y) => px.rgba.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4);
    const near = (v, t) => Math.abs(v - t) <= 40;
    const tl = at(0, 0), bl = at(0, 1);
    assert(near(bl[0], 255) && near(bl[1], 0) && near(bl[2], 0),
      `bottom-left texel should be RED (3MF bottom-left origin), got rgba(${[...bl]}) — Y-flip regression (EXPORT_FLIP_Y)`);
    assert(near(tl[0], 0) && near(tl[1], 0) && near(tl[2], 255),
      `top-left texel should be BLUE, got rgba(${[...tl]})`);

    // Re-import round-trip (A2 follow-up): the exported 3MF loads back through
    // the real `.3mf` SceneLoader plugin with its texture bound.
    const rt = await evaluate(cdp, `(async () => {
      try {
        const bin = atob(${JSON.stringify(result.b64)});
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const meshIds = await AssetLoader.loadFromBlob(new Blob([buf]), 'roundtrip.3mf');
        const textured = meshIds.some(id => {
          const m = AssetLoader.getBabylonMesh(id);
          const mat = m?.material;
          return !!(mat && (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture));
        });
        return { count: meshIds.length, textured };
      } catch (err) {
        return { error: String(err?.stack ?? err) };
      }
    })()`);
    if (rt?.error) throw new Error(`3MF re-import failed: ${rt.error}`);
    assert(rt.count >= 1, 'round-trip import produced no meshes');
    assert(rt.textured, 'round-trip mesh lost its texture — writer/loader mirror drift');

    // OBJ worker import: the off-main-thread parse path (WorkerImport +
    // ObjParse.worker) must produce a mesh with its MTL material bound, and
    // must NOT have fallen back to the main-thread loader (the fallback
    // logs 'OBJ worker parse failed'). Headless Node tests can't cover this
    // — no Worker — so this block is the only mechanical check of the
    // worker path.
    const obj = await evaluate(cdp, `(async () => {
      try {
        const objText = 'mtllib wcube.mtl\\no WCube\\nv 0 0 0\\nv 0.05 0 0\\nv 0.05 0.05 0\\nv 0 0.05 0\\nusemtl RedMat\\nf 1 2 3\\nf 1 3 4\\n';
        const mtlText = 'newmtl RedMat\\nKd 1 0 0\\n';
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const { isWorkerImportSupported } = await import('/src/core/WorkerImport.js');
        let fellBack = false;
        const origWarn = console.warn;
        console.warn = (...a) => {
          if (String(a[0]).includes('OBJ worker parse failed')) fellBack = true;
          origWarn.apply(console, a);
        };
        let meshIds;
        try {
          meshIds = await AssetLoader.loadFromBlob(
            new Blob([objText]), 'wcube.obj', undefined,
            { siblingFiles: [new File([mtlText], 'wcube.mtl')] });
        } finally {
          console.warn = origWarn;
        }
        const mesh = AssetLoader.getBabylonMesh(meshIds[0] ?? '');
        const c = mesh?.material?.diffuseColor;
        return {
          supported: isWorkerImportSupported(),
          fellBack,
          count: meshIds.length,
          verts: mesh?.getTotalVertices?.() ?? 0,
          diffuse: c ? [c.r, c.g, c.b] : null,
        };
      } catch (err) {
        return { error: String(err?.stack ?? err) };
      }
    })()`);
    if (obj?.error) throw new Error(`OBJ worker import failed: ${obj.error}`);
    assert(obj.supported, 'Worker unavailable in browser smoke — worker import path untestable');
    assert(!obj.fellBack, 'OBJ import fell back to main-thread parse — worker path broken');
    assert(obj.count === 1, `expected 1 OBJ mesh, got ${obj.count}`);
    assert(obj.verts >= 3, `OBJ mesh has too few vertices (${obj.verts})`);
    assert(obj.diffuse && Math.abs(obj.diffuse[0] - 1) < 0.05
      && obj.diffuse[1] < 0.05 && obj.diffuse[2] < 0.05,
      `OBJ MTL material not bound through worker path — diffuse ${JSON.stringify(obj.diffuse)}`);

    if (failures.length) throw new Error(`Runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log(`PASS browser export smoke — ${result.suggested}, texture ${texEntries[0]} (${pngBytes.length} bytes, orientation OK, round-trip OK, OBJ worker OK)`);
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

/**
 * Decode a tiny 8-bit RGBA PNG from its already-inflated scanlines —
 * generic per-row unfilter (types 0-4), enough for the 2x2 fixture.
 */
function decodeTinyPng(png, raw) {
  const width  = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bpp = 4;                              // 8-bit RGBA
  const stride = width * bpp;
  const rgba = Buffer.alloc(height * stride);
  let off = 0;
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const row = Buffer.from(raw.subarray(off, off + stride));
    off += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;        // left (already unfiltered)
      const b = prevRow[i];                          // up
      const c = i >= bpp ? prevRow[i - bpp] : 0;     // up-left
      switch (filter) {
        case 0: break;
        case 1: row[i] = (row[i] + a) & 0xff; break;
        case 2: row[i] = (row[i] + b) & 0xff; break;
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          row[i] = (row[i] + pred) & 0xff;
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
    }
    row.copy(rgba, y * stride);
    prevRow = row;
  }
  return { width, height, rgba };
}

function collectIdat(png) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(png.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return Buffer.concat(chunks);
}

// ── Shared plumbing (mirrors tests/browser-smoke.mjs) ────────────────────

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
