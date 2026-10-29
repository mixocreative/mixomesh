// Heavy-mesh perf harness (docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md).
//
//   node scripts/heavy-mesh/measure.mjs [--dir DIR] [--files a.stl,b.3mf] [--gl d3d11|swiftshader]
//                                       [--budget N] [--out results.json] [--runs N] [--uncap 1]
//
// Starts Vite + headless Chrome (real GPU through ANGLE/D3D11 by default),
// fetches each fixture same-origin from .tmp/heavy-mesh (the app CSP blocks
// other origins; that folder may be a junction to the real fixture folder),
// imports it into a fresh page through AssetLoader.loadFromBlob and records:
//   importMs      loadFromBlob wall time
//   firstFrameMs  import start → the first rendered frame after it resolved
//   maxBlockMs    longest main-thread long task during the import (UI freeze)
//   blockedMs     sum of long tasks during the import
//   peakRendererMB / peakGpuMB  peak private bytes of the page's renderer / the GPU process
//   heapMB        JS heap after import (performance.memory)
//   pickColdMs / pickWarmMs  one SceneManager.pickMeshIdAt at the canvas centre
//   orbitFrameMs / orbitP95Ms  mean / p95 frame interval while the camera orbits for ~2 s
//   gizmoDragFrameMs / gizmoDragP95Ms  mean / p95 frame interval during a ~3 s real-pointer drag
//                 on the translate gizmo's X handle (CDP Input.dispatchMouseEvent);
//                 gizmoPosBefore/After (mm) + gizmoMovedMM prove the drag moved the object
//   afterDeleteMB renderer private bytes after deleting the object and trimming history
// --runs N repeats each fixture N times (fresh page each) and prints the median of every
// numeric metric. Every process it starts is killed in `finally`.

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget, Cdp, evaluate,
  waitFor, removeTempDir, stopProcess, sleep,
} from '../../tests/cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** One PowerShell loop sampling private bytes of the given PIDs every 100 ms. */
function startSampler(pids) {
  const script = `$ids=@(${pids.join(',')}); while($true){ foreach($i in $ids){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p){ [Console]::Out.WriteLine("$i $($p.PrivateMemorySize64)") } }; [Console]::Out.Flush(); Start-Sleep -Milliseconds 100 }`;
  const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const latest = new Map();
  const peak = new Map();
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const [pid, bytes] = buf.slice(0, nl).trim().split(' ').map(Number);
      buf = buf.slice(nl + 1);
      if (!pid) continue;
      latest.set(pid, bytes);
      peak.set(pid, Math.max(peak.get(pid) ?? 0, bytes));
    }
  });
  return {
    child,
    resetPeak() { for (const [pid, v] of latest) peak.set(pid, v); },
    peakMB(pid) { return Math.round((peak.get(pid) ?? 0) / 2 ** 20); },
    nowMB(pid) { return Math.round((latest.get(pid) ?? 0) / 2 ** 20); },
  };
}

const MEASURE_IN_PAGE = (fileUrl, filename, budget) => `(async () => {
  const al = await import('/src/core/AssetLoader.js');
  const sm = await import('/src/core/SceneManager.js');
  const capsMod = await import('/src/core/storage/capabilities.js');
  ${budget ? `capsMod.setCapabilities({ triangleBudget: ${budget}, triangleLimit: ${budget * 4} });` : ''}
  const B = window.BABYLON;
  const scene = sm.SceneManager.getScene();
  const res = await fetch(${JSON.stringify(fileUrl)});
  const blob = await res.blob();
  await new Promise(r => setTimeout(r, 300));
  const longTasks = [];
  const po = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration); });
  po.observe({ type: 'longtask', buffered: false });
  window.__heavyMark = 'import';
  // Which activity rows were on screen during the import (progress UX check).
  const activity = new Set();
  const spy = setInterval(() => {
    const panel = document.querySelector('#job-activity');
    if (panel && !panel.hidden) for (const row of panel.querySelectorAll('.ja-row')) {
      activity.add(row.dataset.state + ': ' + row.querySelector('.ja-label')?.textContent);
    }
  }, 100);
  const t0 = performance.now();
  let meshIds = [], err = null;
  try { meshIds = await al.AssetLoader.loadFromBlob(blob, ${JSON.stringify(filename)}, new B.Vector3(0, 0, 0), {}); }
  catch (e) { err = String(e?.message ?? e); }
  const importMs = performance.now() - t0;
  await new Promise(r => scene.onAfterRenderObservable.addOnce(() => r()));
  const firstFrameMs = performance.now() - t0;
  await new Promise(r => setTimeout(r, 200));
  po.disconnect();
  clearInterval(spy);
  window.__heavyMark = 'after';
  const tris = scene.meshes.filter(m => m.metadata?.meshId && m.isEnabled())
    .reduce((n, m) => n + (m.getTotalIndices?.() ?? 0) / 3, 0);
  return {
    err, meshIds, tris, importMs: Math.round(importMs), firstFrameMs: Math.round(firstFrameMs),
    maxBlockMs: Math.round(Math.max(0, ...longTasks)), blockedMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
    heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 2 ** 20),
    activity: [...activity].slice(0, 6),
  };
})()`;

const INTERACT_IN_PAGE = `(async () => {
  const sm = await import('/src/core/SceneManager.js');
  const scene = sm.SceneManager.getScene();
  const canvas = scene.getEngine().getRenderingCanvas();
  const cx = canvas.width / 2, cy = canvas.height / 2;
  sm.SceneManager.frameAll?.();
  await new Promise(r => setTimeout(r, 500));
  let t = performance.now();
  const coldId = sm.SceneManager.pickMeshIdAt(cx, cy);
  const pickColdMs = performance.now() - t;
  // Let a background pick-index build (if any) finish before the warm pick.
  const hp = await import('/src/core/scene/HeavyPick.js').catch(() => null);
  const waitStart = performance.now();
  await new Promise(r => setTimeout(r, 800));
  for (let i = 0; i < 300 && hp?.pendingCount?.() > 0; i++) await new Promise(r => setTimeout(r, 100));
  const pickIndexWaitMs = Math.round(performance.now() - waitStart);
  t = performance.now();
  const warmId = sm.SceneManager.pickMeshIdAt(cx, cy);
  const pickWarmMs = performance.now() - t;
  const cam = scene.activeCamera;
  const frames = [];
  let last = performance.now();
  await new Promise(resolve => {
    const end = last + 2000;
    const step = () => {
      const now = performance.now();
      frames.push(now - last); last = now;
      if (cam && 'alpha' in cam) cam.alpha += 0.02;
      if (now < end) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  frames.shift();
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    orbitP95Ms: +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0).toFixed(1),
    picked: !!coldId && coldId === warmId,
    pickColdMs: Math.round(pickColdMs), pickWarmMs: Math.round(pickWarmMs), pickIndexWaitMs,
    orbitFrameMs: +(frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length)).toFixed(1),
  };
})()`;


/** Select the loaded object, show the translate gizmo, return the screen point of the X handle. */
const GIZMO_PREP_IN_PAGE = `(async () => {
  const sm = await import('/src/core/SceneManager.js');
  const sel = await import('/src/core/Selection.js');
  const st = await import('/src/core/StateManager.js');
  const B = window.BABYLON;
  const scene = sm.SceneManager.getScene();
  const id = Object.keys(st.getState().scene.objects)[0];
  sel.set([id], id);
  sm.SceneManager.setGizmoMode('translate');
  sm.SceneManager.frameAll?.();
  await new Promise(r => setTimeout(r, 600));
  const engine = scene.getEngine();
  const canvas = engine.getRenderingCanvas();
  const rect = canvas.getBoundingClientRect();
  const cam = scene.activeCamera;
  const vp = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const toScreen = v => {
    const p = B.Vector3.Project(v, B.Matrix.Identity(), scene.getTransformMatrix(), vp);
    return { x: rect.left + p.x * rect.width / engine.getRenderWidth(), y: rect.top + p.y * rect.height / engine.getRenderHeight() };
  };
  const pivot = scene.getTransformNodeByName('selectionPivot');
  if (!pivot) return { err: 'no selectionPivot (gizmo not attached)' };
  const o = pivot.getAbsolutePosition();
  const s0 = toScreen(o), s1 = toScreen(o.add(new B.Vector3(10, 0, 0)));
  const len = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
  const obj = scene.meshes.find(m => m.metadata?.meshId === id);
  window.__objPos = () => { obj.computeWorldMatrix(true); return obj.getAbsolutePosition().asArray().map(n => +(n * 1000).toFixed(3)); };   // BU -> mm (BU_TO_MM = 1000)
  return { id, origin: s0, dx: (s1.x - s0.x) / len, dy: (s1.y - s0.y) / len, pos: window.__objPos() };
})()`;

const DELETE_IN_PAGE = `(async () => {
  const hm = await import('/src/core/HistoryManager.js');
  const st = await import('/src/core/StateManager.js');
  const al = await import('/src/core/AssetLoader.js');
  const ids = Object.keys(st.getState().scene.objects);
  hm.push(new hm.DeleteCommand(ids));
  // Push enough no-op entries to drop the delete off the undo stack.
  for (let i = 0; i < 205; i++) hm.push({ label: 'noop', execute() {}, undo() {} });
  await new Promise(r => setTimeout(r, 1500));
  return { stillRegistered: ids.filter(id => !!al.AssetLoader.getBabylonMesh?.(id)).length };
})()`;

/** Real pointer drag (CDP mouse events) on the translate gizmo's X handle; frame intervals recorded in page. */
async function gizmoDrag(cdp) {
  const prep = await evaluate(cdp, GIZMO_PREP_IN_PAGE);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  if (prep.err) throw new Error(prep.err);
  if (process.env.HEAVY_DEBUG) console.error(JSON.stringify(prep));
  const found = await findXHandle(cdp, prep, mouse);
  if (!found) throw new Error('no gizmo handle found');
  const handle = { x: found.x, y: found.y, dx: prep.dx, dy: prep.dy };
  const posBefore = await evaluate(cdp, 'window.__objPos()');
  await evaluate(cdp, `(() => { window.__fr = []; let last = performance.now(); window.__frRun = true;
    const step = () => { const n = performance.now(); window.__fr.push(n - last); last = n; if (window.__frRun) requestAnimationFrame(step); };
    requestAnimationFrame(step); })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(handle.x), y: Math.round(handle.y) });
  await sleep(150);
  await mouse('mousePressed', handle.x, handle.y);
  const t0 = Date.now();
  const DURATION = 3000, TRAVEL = 120;   // px along the handle's screen direction
  while (Date.now() - t0 < DURATION) {
    const k = (Date.now() - t0) / DURATION;
    await mouse('mouseMoved', handle.x + handle.dx * TRAVEL * k, handle.y + handle.dy * TRAVEL * k);
    await sleep(8);
  }
  await mouse('mouseMoved', handle.x + handle.dx * TRAVEL, handle.y + handle.dy * TRAVEL);
  await mouse('mouseReleased', handle.x + handle.dx * TRAVEL, handle.y + handle.dy * TRAVEL);
  const out = await evaluate(cdp, `(() => { window.__frRun = false; const f = window.__fr.slice(1).sort((a, b) => a - b);
    return { frames: f, pos: window.__objPos() }; })()`);
  const f = out.frames;
  return {
    gizmoDragFrameMs: +(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)).toFixed(1),
    gizmoDragP95Ms: +(f[Math.min(f.length - 1, Math.floor(f.length * 0.95))] ?? 0).toFixed(1),
    gizmoPosBefore: posBefore, gizmoPosAfter: out.pos,
    gizmoMovedMM: +Math.hypot(...out.pos.map((v, i) => v - posBefore[i])).toFixed(3),
  };
}

/** Find the X handle: press at increasing radii along the +X screen direction until a small drag moves the object. */
async function findXHandle(cdp, prep, mouse) {
  for (let r = 24; r <= 160; r += 8) {
    const x = prep.origin.x + prep.dx * r, y = prep.origin.y + prep.dy * r;
    const before = await evaluate(cdp, 'window.__objPos()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
    await sleep(60);
    await mouse('mousePressed', x, y);
    for (let k = 1; k <= 4; k++) { await mouse('mouseMoved', x + prep.dx * 6 * k, y + prep.dy * 6 * k); await sleep(20); }
    await mouse('mouseReleased', x + prep.dx * 24, y + prep.dy * 24);
    await sleep(120);
    const after = await evaluate(cdp, 'window.__objPos()');
    if (after.some((v, i) => v !== before[i])) return { x: x + prep.dx * 24, y: y + prep.dy * 24, r };
  }
  return null;
}

const median = xs => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

/** Per fixture: median of every numeric metric across runs. */
function summarize(rows) {
  const byFile = new Map();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  return [...byFile].map(([file, rs]) => {
    const out = { file, n: rs.length };
    for (const k of Object.keys(rs[0])) {
      if (typeof rs[0][k] === 'number') { const m = median(rs.map(r => r[k])); out[k] = m === null ? null : +m.toFixed(1); }
    }
    return out;
  });
}

async function main() {
  const dir = resolve(arg('dir', process.env.HEAVY_MESH_DIR ?? join(ROOT, '.tmp/heavy-mesh')));
  const files = String(arg('files', 'pillow-2M.stl,pillow-5M.stl,pillow-10M.stl,pillow-10M.3mf')).split(',').filter(Boolean);
  const gl = arg('gl', 'd3d11');
  const budget = Number(arg('budget', '0')) || 0;
  const outPath = arg('out', null);
  const uncap = arg('uncap', '0') === '1';   // lift the 60 Hz vsync cap so frame cost is visible
  const runs = Math.max(1, Number(arg('runs', '1')) || 1);
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge not found');
  if (!existsSync(VITE_BIN)) throw new Error('Vite not installed');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-heavy-'));
  const servedDir = relative(ROOT, dir).replace(/\\/g, '/');
  if (servedDir.startsWith('..')) throw new Error(`--dir must be inside the repo (e.g. .tmp/heavy-mesh): ${dir}`);
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));
  const glFlags = gl === 'swiftshader'
    ? ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader']
    : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', ...glFlags,
    '--enable-precise-memory-info', ...(uncap ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []), '--window-size=1600,950', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));
  let sampler = null;
  const results = [];
  const missing = new Set();
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 30000, viteOutput);
    const browserWs = await waitForBrowserWs(debugPort, browserStderr);
    const browserCdp = await Cdp.connect(browserWs);
    for (const file of files.flatMap(f => Array(runs).fill(f))) {
      if (!existsSync(join(dir, file))) { if (!missing.has(file)) console.error(`skip ${file} (missing)`); missing.add(file); continue; }
      const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html?heavy=1`);
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      await waitFor(() => evaluate(cdp, `document.readyState === 'complete' && !document.querySelector('#boot-status') && !!window.BABYLON?.SceneLoader && !!document.querySelector('#status-bar')`), 60000, 'boot');
      await sleep(1000);
      const info = await browserCdp.send('SystemInfo.getProcessInfo');
      const procs = info.processInfo ?? [];
      const gpuPid = procs.find(p => p.type === 'GPU')?.id;
      const rendererPids = procs.filter(p => p.type === 'renderer').map(p => p.id);
      if (sampler) await stopProcess(sampler.child);   // taskkill /T: a bare kill() can leave PowerShell running
      sampler = startSampler([...rendererPids, gpuPid].filter(Boolean));
      await sleep(600);
      sampler.resetPeak();
      const baseRenderer = Math.max(...rendererPids.map(p => sampler.nowMB(p)));
      const run = await evaluate(cdp, MEASURE_IN_PAGE(`/${servedDir}/${file}`, file, budget));
      await sleep(300);
      const peakRendererMB = Math.max(...rendererPids.map(p => sampler.peakMB(p)));
      const peakGpuMB = gpuPid ? sampler.peakMB(gpuPid) : null;
      let interact = {};
      let afterDeleteMB = null;
      if (!run.err) {
        try { interact = await evaluate(cdp, INTERACT_IN_PAGE); } catch (e) { interact = { interactErr: String(e.message) }; }
        try { Object.assign(interact, await gizmoDrag(cdp)); } catch (e) { interact.gizmoErr = String(e.message); }
        try {
          const del = await evaluate(cdp, DELETE_IN_PAGE);
          await sleep(1500);
          afterDeleteMB = Math.max(...rendererPids.map(p => sampler.nowMB(p)));
          interact.stillRegisteredAfterTrim = del.stillRegistered;
        } catch (e) { interact.deleteErr = String(e.message); }
      }
      const row = { file, baseRendererMB: baseRenderer, ...run, peakRendererMB, peakGpuMB, ...interact, afterDeleteMB };
      delete row.meshIds;
      console.log(JSON.stringify(row));
      results.push(row);
      await cdp.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => {});
      await sleep(1500);
    }
    await browserCdp.close();
  } finally {
    if (sampler) await stopProcess(sampler.child);
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
  const summary = summarize(results);
  if (runs > 1 || summary.length) {
    console.log(`
median of ${runs} run(s), gl=${gl}:`);
    for (const r of summary) {
      console.log(`${r.file}  n=${r.n}  orbitFrameMs mean/p95 ${r.orbitFrameMs}/${r.orbitP95Ms}  gizmoDragFrameMs mean/p95 ${r.gizmoDragFrameMs}/${r.gizmoDragP95Ms}  gizmoMovedMM ${r.gizmoMovedMM}`);
    }
  }
  if (outPath) writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), gl, budget, runs, results, median: summary }, null, 2));
}

try {
  await main();
} catch (err) {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
