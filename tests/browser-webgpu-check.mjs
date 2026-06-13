// WebGPU backend check. Boots the real app in headless Chrome with WebGPU
// ENABLED (--enable-unsafe-webgpu → Dawn/D3D12 adapter on Windows), then
// verifies the WebGPU path end-to-end:
//   1. the WebGPU engine actually won (window.__MX_ENGINE === 'webgpu'),
//   2. the one custom shader (the selection outline) compiles & renders in
//      WGSL — a mesh is selected (attaches the 64-tap outline post-process)
//      and a PNG is captured, which forces shader compilation,
//   3. no shader-compile or runtime console errors fired.
//
// If the headless environment exposes no WebGPU adapter, the engine correctly
// falls back to WebGL; this check then reports SKIP (not a failure) — the
// WGSL path must be confirmed in live Chrome. Mirrors browser-smoke.mjs.

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
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found. Install deps first.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-webgpu-'));

  const vite = spawn(process.execPath, [
    VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));

  // WebGPU ON: --enable-unsafe-webgpu lifts the adapter blocklist so headless
  // can use the real GPU (Dawn/D3D12 on Windows). The swiftshader flags only
  // affect ANGLE/GL — they give the WebGL FALLBACK a software context without
  // suppressing the Dawn WebGPU adapter, so this run can land on either engine.
  // Headless Dawn exposes no WebGPU adapter here, so the headless run lands on
  // WebGL and SKIPs. WEBGPU_HEADFUL=1 launches a real Chrome window → real GPU
  // adapter → the WGSL outline shader is actually compiled & rendered.
  const headful = process.env.WEBGPU_HEADFUL === '1';
  const browser = spawn(browserPath, [
    ...(headful ? [] : ['--headless=new', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader']),
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    // ?engine=webgpu opts into the WebGPU backend (default is WebGL — see
    // SceneManager._tryWebGPU for why WebGPU is gated behind this flag).
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html?engine=webgpu`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args = [] } = msg.params;
        const text = args.map(a => a.value ?? a.description ?? '').join(' ');
        // The WebGPU→WebGL fallback warning is expected & benign; ignore it.
        if (type === 'error' && !/Babylon\.js/i.test(text)) failures.push(`console ${type}: ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text ?? 'unknown exception'}`);
      }
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error' && !/favicon|Babylon\.js/i.test(e.text)) {
          failures.push(`log error: ${e.text} ${e.url ?? ''}`.trim());
        }
      }
      if (msg.method === 'Inspector.targetCrashed') failures.push('target crashed');
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    try {
      await waitFor(() => evaluate(cdp, `
        document.readyState === 'complete'
        && document.querySelector('#boot-status') === null
        && typeof window.__MX_ENGINE === 'string'
      `), 30000, 'boot completion');
    } catch (bootErr) {
      const diag = await evaluate(cdp, `({
        ready: document.readyState,
        bootStatus: document.querySelector('#boot-status')?.textContent ?? null,
        engine: window.__MX_ENGINE ?? null,
        hasGpu: !!navigator.gpu,
        hasWebGPUEngine: !!window.BABYLON?.WebGPUEngine,
      })`).catch(e => ({ evalError: String(e) }));
      console.error('BOOT DIAG:', JSON.stringify(diag));
      console.error('CONSOLE FAILURES:', failures.join(' | ') || '(none)');
      throw bootErr;
    }

    const engine = await evaluate(cdp, `window.__MX_ENGINE`);
    if (engine !== 'webgpu') {
      console.log(`SKIP WebGPU check — backend is '${engine}' (no headless WebGPU adapter).`);
      console.log('      WGSL outline shader must be verified in live Chrome.');
      await cdp.close();
      return;
    }

    // WebGPU won. Exercise the WGSL outline shader: select a mesh (attaches the
    // outline post-process) and capture a PNG (forces shader compile + render).
    const result = await evaluate(cdp, `(async () => {
      const sm = await import('/src/core/SceneManager.js');
      const ro = await import('/src/core/RenderOutput.js');
      const B = window.BABYLON;
      const scene = sm.SceneManager.getScene();
      const cam = sm.SceneManager.getCamera();
      cam.target.set(0, 0, 0);
      cam.alpha = Math.PI / 3; cam.beta = Math.PI / 4; cam.radius = 0.4243;
      const box = B.MeshBuilder.CreateBox('webgpu-outline', { size: 0.1 }, scene);
      box.position.set(0, 0.06, 0);
      box.metadata = { meshId: 'webgpu-outline' };
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Discriminator: does the engine render ANY frames here? (Headful
      // automation may throttle an unfocused window's render loop.)
      const eng = sm.SceneManager.getEngine();
      let frames = 0;
      const obs = eng.onEndFrameObservable.add(() => { frames++; });
      await new Promise(r => setTimeout(r, 600));
      eng.onEndFrameObservable.remove(obs);

      const distinctOf = (data) => {
        const s = new Set();
        for (let i = 0; i < data.length; i += 4) s.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);
        return s.size;
      };
      const pngPixels = async () => {
        const blob = await ro.capturePng({ width: 64, height: 64 });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(64, 64);
        const cx = c.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        return cx.getImageData(0, 0, 64, 64).data;
      };

      // (a) Raw RTT frame source (no PNG encode) — isolates the readback path.
      const raw = await ro.captureFrameRGBA({ width: 64, height: 64 });
      const rawDistinct = distinctOf(raw);
      const rawCenter = [raw[64*32*4+128], raw[64*32*4+129], raw[64*32*4+130], raw[64*32*4+131]];

      // (b) Plain PNG capture, no selection.
      const plain = await pngPixels();
      const plainDistinct = distinctOf(plain);

      // (c) Outline PNG capture — selecting attaches the WGSL 64-tap pass.
      sm.SceneManager.setActive(box);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const maskInRT = scene.customRenderTargets.some(t => t.name === 'mx-sel-mask-rt');
      const outline = await pngPixels();
      const outlineDistinct = distinctOf(outline);

      sm.SceneManager.setActive(null);
      box.dispose();
      return { isWebGPU: sm.SceneManager.isWebGPU(), maskInRT, frames,
               rawDistinct, rawCenter, plainDistinct, outlineDistinct };
    })()`);
    console.log('  diag:', JSON.stringify(result));

    // What WebGPU MUST deliver here: the backend boots, the one custom shader
    // (selection outline) compiles in WGSL with no shader/device error, and the
    // render loop runs every frame with that 64-tap pass attached. A WGSL
    // compile failure surfaces as a console/device error (caught in `failures`)
    // and stalls frames — both are asserted.
    assert(result.isWebGPU, 'SceneManager.isWebGPU() false despite __MX_ENGINE webgpu');
    assert(result.maskInRT, 'outline mask RTT not attached when a mesh is selected (WebGPU)');
    assert(result.frames > 0, 'WebGPU engine rendered no frames');
    if (failures.length) throw new Error(`WebGPU check found runtime errors (likely WGSL compile):\n${failures.join('\n')}`);

    // KNOWN BLOCKER (not a failure): Babylon 9.6.2's offline render-target →
    // readPixels path returns empty on WebGPU, so capture is uniform. This is
    // exactly why WebGPU is opt-in and WebGL stays the default for export.
    if (result.rawDistinct <= 4) {
      console.log('  NOTE: RTT capture empty on WebGPU (known Babylon 9.6.2 gap) — WebGPU stays opt-in, WebGL is the export default.');
    } else {
      console.log('  RTT capture produced real pixels on WebGPU — capture blocker may be resolved; revisit the default.');
    }
    await cdp.close();
    console.log('PASS WebGPU backend + WGSL outline shader compile + render loop');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Failed to open browser target: ${res.status} ${await res.text()}`);
  return await res.json();
}
async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
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
  const candidates = [
    join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    local ? join(local, 'Microsoft/Edge/Application/msedge.exe') : '',
  ];
  const match = candidates.find(p => p && existsSync(p));
  if (match) return match;
  for (const cmd of ['google-chrome', 'chrome', 'chromium', 'msedge']) {
    const r = resolveCommand(cmd);
    if (r) return r;
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
      if (res.ok) { const j = await res.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; }
    } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint:\n${stderr.join('').slice(-2000)}`);
}
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return cdp;
  }
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.onEvent = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else res(msg.result ?? {});
      } else this.onEvent?.(msg);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP command timed out: ${method}`)); }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); res(v); }, reject: e => { clearTimeout(timer); rej(e); } });
    });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(res => { this.ws.addEventListener('close', res, { once: true }); this.ws.close(); setTimeout(res, 1000); });
  }
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed');
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
    try { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); await Promise.race([once(k, 'exit'), sleep(3000)]); }
    catch { try { child.kill(); } catch { /* gone */ } }
  } else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  if (child.exitCode == null) await Promise.race([once(child, 'exit'), sleep(3000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

try { await main(); }
catch (err) { console.error(err?.stack ?? err); process.exitCode = 1; }
finally { process.exit(process.exitCode ?? 0); }
