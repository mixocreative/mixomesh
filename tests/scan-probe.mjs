// Real-scan probe (not part of test:all): runs every .glb in
// tests/fixtures/real-scans/ (or the folder given as argv[2]) through the
// REAL import → validate → repair → re-validate → 3MF export path in
// headless Chrome and prints one row per file: parts, size, validation
// before/after, triangles before/after, export manifold check, volume,
// timings. Exit 1 when any file fails a hard check.
//
//   node tests/scan-probe.mjs [dir]
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-scan-probe-'));

  const vite = spawn(process.execPath, [
    VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));

  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900', '--hide-scrollbars',
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && location.pathname.endsWith('/index.html')
      && document.querySelector('#boot-status') === null
      && !!window.BABYLON?.SceneLoader
      && !!document.querySelector('#renderCanvas')
    `), 30000, 'app boot completion');

    const dir = process.argv[2] ?? join(ROOT, 'tests', 'fixtures', 'real-scans');
    const { readdirSync } = await import('node:fs');
    const only = process.env.PROBE_ONLY ? new Set(process.env.PROBE_ONLY.split(',')) : null;
    const files = readdirSync(dir).filter(f => /\.(glb|gltf|obj|stl|3mf)$/i.test(f)).filter(f => !only || only.has(f)).sort();
    if (!files.length) throw new Error(`no model files in ${dir}`);
    const urlDir = dir.startsWith(ROOT) ? dir.slice(ROOT.length).replace(/\\/g, '/') : null;
    if (!urlDir) throw new Error(`probe folder must be inside the repo so Vite can serve it: ${dir}`);

    // Fresh scene, no auto-repair, no auto-validate toast flow interference.
    await evaluate(cdp, `(async () => {
      const { setState } = await import('/src/core/StateManager.js');
      setState(s => ({ ...s, print: { ...s.print, repairOnImport: false } }), { silent: true });
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { window.__captured = d; }, close: async () => {} }) });
      window.__PROBE_DIAG = ${process.env.PROBE_DIAG === '1'};
      window.__PROBE_WAIT = ${Number(process.env.PROBE_WAIT || 0)};
      window.__PROBE_SHOT = ${process.env.PROBE_SHOT ? 'true' : 'false'};
      window.__PROBE_BELOW = ${process.env.PROBE_BELOW === '1'};
      window.__PROBE_INV = ${process.env.PROBE_INV === '1'};
      window.__PROBE_PASSES = ${Number(process.env.PROBE_PASSES || 1)};
      window.__grpTrace = [];
      window.__PROBE_CMP = ${process.env.PROBE_CMP === '1'};
      const { setEngineOverrides } = await import('/src/core/repair/MeshRepair.js');
      setEngineOverrides(${process.env.PROBE_ENGINE_OPTS || '{}'});
      return true;
    })()`);

    const rows = [];
    const hard = [];
    for (const file of files) {
      const r = await evaluate(cdp, `(async () => {
        const t0 = performance.now();
        try {
          const { AssetLoader } = await import('/src/core/AssetLoader.js');
          const { getState } = await import('/src/core/StateManager.js');
          const { MeshValidator } = await import('/src/core/MeshValidator.js');
          const { logicalObjectPartIds, shouldDisplayObject } = await import('/src/core/LogicalObjects.js');
          const { PrintManager } = await import('/src/core/PrintManager.js');
          const { PrintPartCommand } = await import('/src/core/commands/HierarchyCommands.js');
          const { push } = await import('/src/core/HistoryManager.js');
          const { DeleteCommand } = await import('/src/core/commands/HierarchyCommands.js');

          // Remove whatever the previous file left so the export is this file only.
          const prev = Object.keys(getState().scene.objects);
          if (prev.length) { try { push(new DeleteCommand(prev)); } catch (e) { for (const id of prev) { try { push(new DeleteCommand([id])); } catch {} } } }

          const res = await fetch(${JSON.stringify(urlDir + '/')} + encodeURIComponent(${JSON.stringify(file)}));
          if (!res.ok) return { file: ${JSON.stringify(file)}, error: 'fetch ' + res.status };
          const blob = await res.blob();
          const ids = await AssetLoader.loadFromBlob(blob, ${JSON.stringify(file)});
          const tImport = performance.now() - t0;
          const objs = getState().scene.objects;
          const leads = ids.filter(id => shouldDisplayObject(objs[id]));
          const lead = leads[0];
          const parts = logicalObjectPartIds(lead, objs);
          const meshes = parts.map(id => AssetLoader.getBabylonMesh(id));
          const tris = () => meshes.reduce((a, m) => a + (m.getIndices()?.length ?? 0) / 3, 0);
          const trisBefore = tris();
          let diag = null;
          if (window.__PROBE_DIAG) {
            const { ensureRepairEngine, meshToArrays, repairArraysByComponent: repairArrays } = await import('/src/core/repair/MeshRepair.js');
            const { weldArrays } = await import('/src/core/repair/Weld.js');
            const lib = await ensureRepairEngine();
            const per = meshes.map(m => { const { V, T } = meshToArrays(m); const d = lib.diagnose(V, T); return { name: m.name, verts: V.length, tris: T.length, boundary: d.boundary, nm: d.nonManifold, comps: d.components, uv: !!m.getVerticesData('uv'), normal: !!m.getVerticesData('normal'), tangent: !!m.getVerticesData('tangent'), color: !!m.getVerticesData('color') }; });
            const P = [], X = []; let off = 0;
            for (const m of meshes) { const p = m.getVerticesData('position'); const ix = m.getIndices(); for (const v of p) P.push(v); for (const i of ix) X.push(i + off); off += p.length / 3; }
            const w = weldArrays(P, X);
            const V = []; for (let i = 0; i < w.positions.length; i += 3) V.push([w.positions[i], w.positions[i+1], w.positions[i+2]]);
            const T = []; for (let i = 0; i < w.indices.length; i += 3) T.push([w.indices[i], w.indices[i+1], w.indices[i+2]]);
            const b = lib.diagnose(V, T);
            const r = await repairArrays(V, T, { name: 'diag' });
            const key = new Set(V.map(v => v.map(x => Math.round(x / 1e-4)).join('|')));
            let hits = 0; for (const v of r.V) if (key.has(v.map(x => Math.round(x / 1e-4)).join('|'))) hits++;
            diag = { per, union: { verts: V.length, tris: T.length, boundary: b.boundary, nm: b.nonManifold, comps: b.components }, engine: { outV: r.V.length, outT: r.T.length, hits, boundary: r.after.boundary, nm: r.after.nonManifold, comps: r.after.components, watertight: r.after.isWatertight, report: r.report } };
          }
          // bounds in mm
          let min = null, max = null;
          for (const m of meshes) { m.computeWorldMatrix(true); const bb = m.getBoundingInfo().boundingBox; if (!min) { min = bb.minimumWorld.clone(); max = bb.maximumWorld.clone(); } else { min = BABYLON.Vector3.Minimize(min, bb.minimumWorld); max = BABYLON.Vector3.Maximize(max, bb.maximumWorld); } }
          const size = max.subtract(min).scale(1000);
          const t1 = performance.now();
          const before = (await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(lead))).map(r => r.type + ':' + r.count + (r.autoFixAvailable ? '' : '(nofix)'));
          const tValidate = performance.now() - t1;
          if (window.__PROBE_WAIT) await new Promise(r => setTimeout(r, window.__PROBE_WAIT));
          const t2 = performance.now();
          let repair = null, repairError = null;
          try {
            repair = await MeshValidator.repairObject(lead);
            for (let pass = 1; pass < (window.__PROBE_PASSES || 1); pass++) {
              const again = await MeshValidator.repairObject(lead);
              repair = { holesFilled: repair.holesFilled + again.holesFilled, nmFixed: repair.nmFixed + again.nmFixed, applied: [...new Set([...repair.applied, ...again.applied])], remaining: again.remaining };
            }
          } catch (e) { repairError = String(e?.message ?? e); }
          const tRepair = performance.now() - t2;
          const sum = (m) => { const p = m.getVerticesData('position'); const ix = m.getIndices(); let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + Math.round(p[i] * 1e7)) | 0; return (p.length / 3) + 'v/' + (ix.length / 3) + 't#' + h + ' buf:' + p.constructor.name; };
          const snap = {};
          snap.t0 = meshes.map(sum);
          await new Promise(r => setTimeout(r, 50));
          snap.t50 = meshes.map(sum);
          await new Promise(r => setTimeout(r, 1500));
          snap.t1500 = meshes.map(sum);
          const after = (await MeshValidator.validateMesh(AssetLoader.getBabylonMesh(lead))).map(r => r.type + ':' + r.count);
          snap.afterValidate = meshes.map(sum);
          let cmp = null;
          if (window.__PROBE_CMP) {
            const { diagnoseGroup, toLeadMatrix } = await import('/src/core/repair/GroupRepair.js');
            const { ensureRepairEngine } = await import('/src/core/repair/MeshRepair.js');
            const { weldArrays } = await import('/src/core/repair/Weld.js');
            const lib = await ensureRepairEngine();
            const gr = await diagnoseGroup(meshes.map(m => ({ mesh: m, toLead: toLeadMatrix(m, meshes[0]) })));
            // validator-style: world space
            const P = [], X = []; let off = 0;
            for (const m of meshes) { m.computeWorldMatrix(true); const wm = m.getWorldMatrix(); const p = m.getVerticesData('position'); const ix = m.getIndices(); const tmp = new BABYLON.Vector3();
              for (let i = 0; i < p.length; i += 3) { tmp.set(p[i], p[i+1], p[i+2]); const w = BABYLON.Vector3.TransformCoordinates(tmp, wm); P.push(w.x, w.y, w.z); }
              for (const i of ix) X.push(i + off); off += p.length / 3; }
            const w = weldArrays(P, X);
            const V = []; for (let i = 0; i < w.positions.length; i += 3) V.push([w.positions[i], w.positions[i+1], w.positions[i+2]]);
            const T = []; for (let i = 0; i < w.indices.length; i += 3) T.push([w.indices[i], w.indices[i+1], w.indices[i+2]]);
            const dv = lib.diagnose(V, T);
            cmp = { groupRepairStyle: gr, validatorStyle: { verts: V.length, tris: T.length, b: dv.boundary, nm: dv.nonManifold, c: dv.components }, worlds: meshes.map(m => Array.from(m.getWorldMatrix().m).map(x => +x.toFixed(6))), partVerts: meshes.map(m => m.getVerticesData('position').length / 3), partTris: meshes.map(m => m.getIndices().length / 3) };
          }
          const trisAfter = tris();
          if (window.__PROBE_SHOT) {
            const { SceneManager } = await import('/src/core/SceneManager.js');
            const { Selection } = await import('/src/core/Selection.js');
            Selection.set([lead], lead);
            const scene = SceneManager.getScene(); const cam = scene.activeCamera;
            let mn = null, mx = null;
            for (const m of meshes) { m.computeWorldMatrix(true); const bb = m.getBoundingInfo().boundingBox; if (!mn) { mn = bb.minimumWorld.clone(); mx = bb.maximumWorld.clone(); } else { mn = BABYLON.Vector3.Minimize(mn, bb.minimumWorld); mx = BABYLON.Vector3.Maximize(mx, bb.maximumWorld); } }
            const c = mn.add(mx).scale(0.5); const r = mx.subtract(mn).length();
            cam.setTarget(c); cam.radius = r * 1.6; cam.alpha = -Math.PI / 3; cam.beta = window.__PROBE_BELOW ? Math.PI * 0.72 : Math.PI / 3.2;
            SceneManager.setOverlay('invertedFaces', !!window.__PROBE_INV);
            SceneManager.setOverlay('grid', false);
            await new Promise(res => setTimeout(res, 700));
          }
          const uvOk = meshes.every(m => { const uv = m.getVerticesData('uv'); const p = m.getVerticesData('position'); return !uv || uv.length / 2 === p.length / 3; });
          // export 3MF (this file only)
          window.__captured = null;
          const t3 = performance.now();
          let exportError = null;
          try { await PrintManager.exportThreeMF({}); } catch (e) { exportError = String(e?.message ?? e); }
          const tExport = performance.now() - t3;
          let b64 = null;
          if (window.__captured) {
            const buf = new Uint8Array(window.__captured.arrayBuffer ? await window.__captured.arrayBuffer() : window.__captured);
            let bin = ''; const CHUNK = 0x8000; for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
            b64 = btoa(bin);
          }
          return { file: ${JSON.stringify(file)}, objects: leads.length, parts: parts.length, name: objs[lead]?.name,
            sizeMM: [size.x, size.z, size.y].map(v => +v.toFixed(1)), trisBefore, trisAfter, before, after,
            repair: repair && { holes: repair.holesFilled, nm: repair.nmFixed, applied: repair.applied }, repairError, uvOk,
            exportError, b64, diag, cmp, snap, trace: window.__grpTrace.splice(0), ms: { import: tImport | 0, validate: tValidate | 0, repair: tRepair | 0, export: tExport | 0 } };
        } catch (err) { return { file: ${JSON.stringify(file)}, error: String(err?.stack ?? err) }; }
      })()`);
      if (r.error) { hard.push(`${file}: ${r.error}`); console.log(`✗ ${file}: ${r.error.split('\\n')[0]}`); rows.push(r); continue; }
      if (process.env.PROBE_SHOT) {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(process.env.PROBE_SHOT, { recursive: true });
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PROBE_SHOT, file.replace(/[.][^.]+$/, '') + '.png'), Buffer.from(shot.data, 'base64'));
      }

      // Analyse the exported 3MF: manifold edges (welded per file), volume sign per object.
      let exp = { tris: 0, badEdges: null, volume: null, objects: 0 };
      if (r.b64) {
        const bytes = Buffer.from(r.b64, 'base64');
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(bytes);
        const modelXml = await zip.file('3D/3dmodel.model')?.async('text');
        if (modelXml) {
          const objectsXml = [...modelXml.matchAll(/<object [^>]*>([\s\S]*?)<\/object>/g)].map(m => m[1]);
          const vertices = [], triangles = [];
          for (const ox of objectsXml) {
            const base = vertices.length;
            for (const m of ox.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)) vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
            for (const m of ox.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) triangles.push([base + Number(m[1]), base + Number(m[2]), base + Number(m[3])]);
          }
          const key = new Map();
          const canon = vertices.map(v => { const k = v.map(x => x.toFixed(3)).join(','); if (!key.has(k)) key.set(k, key.size); return key.get(k); });
          const use = new Map(); let vol6 = 0;
          for (const [a, b, c] of triangles) {
            for (const [x, y] of [[canon[a], canon[b]], [canon[b], canon[c]], [canon[c], canon[a]]]) { const k = x < y ? `${x}-${y}` : `${y}-${x}`; use.set(k, (use.get(k) ?? 0) + 1); }
            const [ax, ay, az] = vertices[a], [bx, by, bz] = vertices[b], [cx, cy, cz] = vertices[c];
            vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
          }
          // Boundary loop structure: how many loops, how long (top 5).
          const adj = new Map();
          for (const [k, n] of use) if (n === 1) { const [a, b] = k.split('-').map(Number); (adj.get(a) ?? adj.set(a, []).get(a)).push(b); (adj.get(b) ?? adj.set(b, []).get(b)).push(a); }
          const seen = new Set(); const loops = [];
          for (const start of adj.keys()) { if (seen.has(start)) continue; let n = 0; const stack = [start]; seen.add(start); while (stack.length) { const v = stack.pop(); n++; for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); stack.push(w); } } loops.push(n); }
          loops.sort((a, b) => b - a);
          exp = { tris: triangles.length, badEdges: [...use.values()].filter(n => n !== 2).length, volume: +(vol6 / 6).toFixed(1), objects: objectsXml.length, loops: loops.length, loopTop: loops.slice(0, 6), nonMan: [...use.values()].filter(n => n > 2).length };
        }
      }
      const row = { ...r, b64: undefined, exp };
      rows.push(row);
      const flag = [];
      if (r.repairError) flag.push('REPAIR-ERR');
      if (r.exportError) flag.push('EXPORT-ERR');
      if (!r.uvOk) flag.push('UV-MISMATCH');
      if (exp.volume != null && exp.volume <= 0) flag.push('VOLUME<=0');
      if (r.after.length) flag.push('STILL-ISSUES');
      if (exp.tris && r.trisAfter && Math.abs(exp.tris - r.trisAfter) > r.trisAfter * 0.05) flag.push('EXPORT-TRIS-DRIFT');
      if (r.repairError || r.exportError || !r.uvOk || (exp.volume != null && exp.volume <= 0)) hard.push(`${file}: ${flag.join(',')} ${r.repairError ?? ''} ${r.exportError ?? ''}`);
      if (r.diag) console.log(`   diag ${file}: ${JSON.stringify(r.diag)}`);
      if (r.trace?.length) console.log(`   trace ${file}: ${JSON.stringify(r.trace)}`);
      if (r.cmp) console.log(`   cmp ${file}: ${JSON.stringify(r.cmp)}`);
      if (r.snap) console.log(`   snap ${file}: ${JSON.stringify(r.snap)}`);
      console.log(`${flag.length ? '⚠' : '✓'} ${file} | ${r.name} | parts ${r.parts} | ${r.sizeMM.join('×')} mm | tris ${r.trisBefore}→${r.trisAfter} | before [${r.before.join(', ')}] | repair ${JSON.stringify(r.repair)} | after [${r.after.join(', ')}] | 3MF tris ${exp.tris} bad ${exp.badEdges} (loops ${exp.loops} top ${JSON.stringify(exp.loopTop)} nm ${exp.nonMan}) vol ${exp.volume} mm³ | ms ${JSON.stringify(r.ms)} ${flag.join(' ')}`);
    }
    console.log('\nJSON:' + JSON.stringify(rows.map(r => ({ ...r, b64: undefined }))));

    if (failures.length) throw new Error(`Runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log(`PROBE DONE — ${rows.length} file(s), ${hard.length} hard failure(s)`);
    if (hard.length) throw new Error(hard.join('\n'));
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
