// Multi-part (material-split) repair smoke — GroupRepair end to end in a
// real headless Chrome (2026-09-18).
//
// Two glTF meshes, each ONE node with TWO primitives (two materials) sharing
// one vertex buffer: a closed cube and the same cube with one face missing.
// Proves, through the real AssetLoader / MeshValidator / RepairSession /
// PrintManager paths:
//   1. the closed split cube validates CLEAN (seams are not holes — the
//      union is welded before the engine sees it);
//   2. repairing the open split cube as ONE solid adds only the missing
//      face: 12 triangles total, both parts keep their own triangles, no
//      seam caps (the old per-part path produced 12 + 4 with an internal
//      wall);
//   3. the exported 3MF of the repaired object is watertight with every
//      edge used exactly twice and a positive volume of exactly the cube's.
//
//   node tests/browser-group-repair-smoke.mjs
//

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const CDP_COMMAND_TIMEOUT_MS = 30000;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-group-repair-smoke-'));

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

    const result = await evaluate(cdp, `(async () => {
      try {
        const f32 = a => new Uint8Array(new Float32Array(a).buffer);
        const u16 = a => { const b = new ArrayBuffer(a.length * 2), d = new DataView(b); a.forEach((v, i) => d.setUint16(i * 2, v, true)); return new Uint8Array(b); };
        const cat = (...a) => { let n = 0; a.forEach(x => n += x.length); const r = new Uint8Array(n); let o = 0; a.forEach(x => { r.set(x, o); o += x.length; }); return r; };
        const b64 = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
        // 10-unit cube (glTF units read as mm here) → 1000 mm³.
        const V = [0,0,0, 10,0,0, 10,10,0, 0,10,0, 0,0,10, 10,0,10, 10,10,10, 0,10,10];
        // Outward-wound (right-handed glTF): every face normal points away
        // from the cube's centre.
        const I = [0,2,1,0,3,2, 4,5,6,4,6,7, 0,5,4,0,1,5, 1,6,5,1,2,6, 2,7,6,2,3,7, 3,4,7,3,0,4];
        const make = (name, iB) => {
          const pos = f32(V), i0 = u16(I.slice(0, 18)), i1 = u16(iB), bin = cat(pos, i0, i1);
          return { asset: { version: '2.0' },
            buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + b64(bin) }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: i0.length, target: 34963 }, { buffer: 0, byteOffset: pos.length + i0.length, byteLength: i1.length, target: 34963 }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 10] }, { bufferView: 1, componentType: 5123, count: 18, type: 'SCALAR' }, { bufferView: 2, componentType: 5123, count: iB.length, type: 'SCALAR' }],
            materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }, { attributes: { POSITION: 0 }, indices: 2, material: 1 }] }],
            nodes: [{ mesh: 0, name }], scenes: [{ nodes: [0] }], scene: 0 };
        };
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const { getState } = await import('/src/core/StateManager.js');
        const { MeshValidator } = await import('/src/core/MeshValidator.js');
        const { logicalObjectPartIds, shouldDisplayObject } = await import('/src/core/LogicalObjects.js');
        const load = async (name, iB) => {
          const ids = await AssetLoader.loadFromBlob(new Blob([JSON.stringify(make(name, iB))], { type: 'model/gltf+json' }), name + '.gltf');
          const objs = getState().scene.objects;
          const lead = ids.find(id => shouldDisplayObject(objs[id])) ?? ids[0];
          return { lead, parts: logicalObjectPartIds(lead, objs) };
        };
        const types = (res) => res.map(r => r.type + ':' + r.count);

        const closed = await load('ClosedCube', I.slice(18));
        const closedBefore = types(await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(closed.lead)));

        const open = await load('OpenCube', I.slice(18, 33));   // drop the last face (in part B)
        const openBefore = types(await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(open.lead)));
        const repair = await MeshValidator.repairObject(open.lead);
        const openAfter = types(await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(open.lead)));
        const partTris = open.parts.map(id => AssetLoader.getBabylonMesh(id).getIndices().length / 3);
        const fixes = open.parts.map(id => getState().scene.objects[id].geometryFixes ?? []);

        // Export ONLY the repaired open cube: mark the closed one non-print.
        const { PrintPartCommand } = await import('/src/core/commands/HierarchyCommands.js');
        const { push } = await import('/src/core/HistoryManager.js');
        for (const id of closed.parts) push(new PrintPartCommand(id, true, false));
        let captured = null;
        window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { captured = d; }, close: async () => {} }) });
        const { PrintManager } = await import('/src/core/PrintManager.js');
        await PrintManager.exportThreeMF({});
        if (!captured) return { error: 'export captured no bytes' };
        const buf = new Uint8Array(captured.arrayBuffer ? await captured.arrayBuffer() : captured);
        let bin = ''; const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        return { closedBefore, openBefore, repair: { holesFilled: repair.holesFilled, applied: repair.applied, remaining: repair.remaining.map(r => r.type) }, openAfter, partTris, fixes, parts: open.parts.length, b64: btoa(bin) };
      } catch (err) {
        return { error: String(err?.stack ?? err) };
      }
    })()`);

    if (result?.error) throw new Error(`In-page group repair failed: ${result.error}`);
    console.log(`closed split cube validates: [${result.closedBefore.join(', ')}]`);
    assert(result.closedBefore.length === 0,
      `a CLOSED split cube must validate clean (seams are not holes), got: ${result.closedBefore.join(', ')}`);
    console.log(`open split cube before: [${result.openBefore.join(', ')}] → repair ${JSON.stringify(result.repair)} → after: [${result.openAfter.join(', ')}]`);
    assert(result.parts === 2, `expected 2 parts, got ${result.parts}`);
    assert(result.openBefore.some(t => t.startsWith('holes:')), 'open split cube should report holes before repair');
    assert(result.repair.applied.includes('groupRepair'), `repair should apply groupRepair, got ${result.repair.applied}`);
    assert(result.repair.holesFilled >= 1, `holesFilled should be >= 1, got ${result.repair.holesFilled}`);
    assert(result.openAfter.length === 0, `after repair the union must validate clean, got: ${result.openAfter.join(', ')}`);
    const total = result.partTris.reduce((a, b) => a + b, 0);
    console.log(`part triangles after repair: ${result.partTris.join(' + ')} = ${total}`);
    assert(total === 12, `union must be exactly 12 triangles (no seam caps — the old per-part path gave 16), got ${total}`);
    assert(result.partTris.every(n => n >= 1), 'every part keeps triangles');
    assert(result.fixes.every(f => f.includes('groupRepair')), `every part records groupRepair, got ${JSON.stringify(result.fixes)}`);

    const bytes = Buffer.from(result.b64, 'base64');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const modelXml = await zip.file('3D/3dmodel.model')?.async('text');
    assert(modelXml, '3D/3dmodel.model missing from exported package');
    const vertices = [...modelXml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
      .map(m => [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    const triangles = [...modelXml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    console.log(`exported: ${vertices.length} vertices, ${triangles.length} triangles`);
    assert(triangles.length === 12, `exported split cube must have 12 triangles, got ${triangles.length}`);
    // Position-weld the exported vertices (parts are separate objects in the
    // file, each with its own vertex list) and check every edge is used
    // exactly twice.
    const key = new Map();
    const canon = vertices.map(v => { const k = v.map(x => x.toFixed(4)).join(','); if (!key.has(k)) key.set(k, key.size); return key.get(k); });
    const use = new Map();
    let vol6 = 0;
    for (const [a, b, c] of triangles) {
      for (const [x, y] of [[canon[a], canon[b]], [canon[b], canon[c]], [canon[c], canon[a]]]) { const k = x < y ? `${x}-${y}` : `${y}-${x}`; use.set(k, (use.get(k) ?? 0) + 1); }
      const [ax, ay, az] = vertices[a], [bx, by, bz] = vertices[b], [cx, cy, cz] = vertices[c];
      vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    const bad = [...use.entries()].filter(([, n]) => n !== 2);
    assert(bad.length === 0, `exported solid is not watertight — edges not used exactly twice: ${JSON.stringify(bad.slice(0, 10))}`);
    const volume = vol6 / 6;
    console.log(`signed volume: ${volume.toFixed(3)} mm^3`);
    assert(volume > 0 && Math.abs(volume - 1000) / 1000 <= 0.01, `exported volume should be +1000 mm^3, got ${volume}`);

    if (failures.length) throw new Error(`Runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log('PASS browser group-repair smoke — split cube repaired as one solid, 12 tris, export watertight, +1000 mm^3');
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
