// Turntable video check (`npm run test:video`) — MANUAL/optional, NOT part
// of `npm test`: it opens a small HEADED browser window for ~15 s, because
// MediaRecorder + canvas.captureStream hard-freezes the renderer in headless
// Chrome (GPU and SwiftShader alike; rec.start returns, then the main thread
// blocks — even timers stop).
//
// 2026-06-13 finding: Chrome 149.0.7827.54 on this machine freezes the SAME
// way even HEADED, even on a trivial 2D-canvas recording in the user's own
// profile — a Chrome-build bug, not app code. Edge 149 records fine (1.7 MB
// mp4 for a 2 s turntable). Default browser pick may therefore fail on
// Chrome; set VIDEO_CHECK_EDGE=1 to force Edge.
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
  if (!browserPath) {
    throw new Error('Chrome/Edge executable not found. Install Chrome or Edge to run browser smoke.');
  }
  if (!existsSync(VITE_BIN)) {
    throw new Error('Vite executable not found. Run dependency install before browser smoke.');
  }

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-smoke-'));

  const vite = spawn(process.execPath, [
    VITE_BIN,
    '--host', '127.0.0.1',
    '--port', String(appPort),
    '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', chunk => viteOutput.push(String(chunk)));
  vite.stderr.on('data', chunk => viteOutput.push(String(chunk)));

  const browser = spawn(browserPath, [
    // HEADED on purpose: MediaRecorder + canvas.captureStream hard-freezes
    // the renderer in headless Chrome (GPU and SwiftShader alike — rec.start
    // blocks the main thread; even timers stop). A small real window for a
    // few seconds is the only way to exercise the actual encode path.
    '--window-size=900,640',
    '--window-position=40,40',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-experimental-web-platform-features',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', chunk => browserStderr.push(String(chunk)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);

    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];

    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args = [] } = msg.params;
        const text = args.map(a => a.value ?? a.description ?? '').join(' ');
        if (type === 'error' && !/Babylon\.js/i.test(text)) failures.push(`console ${type}: ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text
          ?? 'unknown exception'}`);
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

    await waitFor(() => evaluate(cdp, `
      document.readyState === 'complete'
      && document.querySelector('#boot-status') === null
    `), 30000, 'boot completion');
    await waitFor(() => evaluate(cdp, `
      !!window.BABYLON?.Engine
      && !!window.BABYLON?.GridMaterial
      && !!window.BABYLON?.OBJExport
      && !!window.BABYLON?.SceneLoader
    `), 30000, 'local Babylon namespace');
    await waitFor(() => evaluate(cdp, `
      !!document.querySelector('#renderCanvas')
      && !!document.querySelector('.pm-bar')
      && !!document.querySelector('#ol-list')
      && !!document.querySelector('#ap-grid')
      && !!document.querySelector('#rp-print-body')
      && !!document.querySelector('#status-bar')
    `), 30000, 'main UI');

    const preflight = await evaluate(cdp, `(async () => {
      const sm = await import('/src/core/SceneManager.js');
      const scene = sm.SceneManager.getScene();
      let frames = 0;
      const obs = scene.onBeforeRenderObservable.add(() => frames++);
      await new Promise(r => setTimeout(r, 500));
      scene.onBeforeRenderObservable.remove(obs);
      return { frames, vis: document.visibilityState,
        mp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E'),
        vp8: MediaRecorder.isTypeSupported('video/webm;codecs=vp8') };
    })()`);
    console.log('preflight:', JSON.stringify(preflight));
    assert(preflight.frames > 5, `render loop not running (${preflight.frames} frames in 500ms)`);

    const result = await evaluate(cdp, `(async () => {
      const ro = await import('/src/core/RenderOutput.js');
      const sm = await import('/src/core/SceneManager.js');
      const cam = sm.SceneManager.getCamera();
      const alphaBefore = cam.alpha;
      const video = await Promise.race([
        ro.recordTurntable({ durationS: 2, fps: 30, direction: 'left', ease: true }),
        new Promise(r => setTimeout(() => r('timeout'), 20000)),
      ]);
      if (video === 'timeout') return { timeout: true, recording: ro.isRecording() };
      return {
        bytes: video?.blob?.size ?? 0,
        ext: video?.ext ?? '',
        mime: video?.mime ?? '',
        alphaRestored: Math.abs(cam.alpha - alphaBefore) < 1e-6,
      };
    })()`);

    console.log('turntable:', JSON.stringify(result));
    assert(result.bytes > 1000, `turntable recording produced ${result.bytes} bytes`);
    assert(['mp4', 'webm'].includes(result.ext), `unexpected container ${result.ext}`);
    assert(result.alphaRestored, 'camera pose not restored after turntable');
    if (failures.length) throw new Error(`Browser smoke found runtime errors:\n${failures.join('\n')}`);
    await cdp.close();
    console.log('PASS turntable video check (headed browser)');
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`Failed to open browser target: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Vite may still be starting.
    }
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
  const absoluteCandidates = process.env.VIDEO_CHECK_EDGE ? [
    join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
  ] : [
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
  return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
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
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint:\n${stderr.join('').slice(-2000)}`);
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
        resolve: (value) => { clearTimeout(timer); resolvePending(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
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
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      // The page may still be navigating.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeTempDir(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
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
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
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
