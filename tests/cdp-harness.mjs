// Shared Chrome DevTools Protocol harness for the browser checks
// (browser-smoke.mjs, browser-webgpu-check.mjs, …). Pure plumbing — process
// launch, port allocation, CDP socket, evaluate/wait helpers — so the checks
// themselves carry only their assertions, not 150 lines of copy-pasted setup.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';

export const CDP_COMMAND_TIMEOUT_MS = 30000;

export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function assert(value, message) { if (!value) throw new Error(message); }

export async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

export function findBrowser() {
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
  for (const command of ['google-chrome', 'chrome', 'chromium', 'msedge']) {
    const resolved = resolveCommand(command);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveCommand(command) {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args = process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`];
  const result = spawnSync(resolver, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
}

export async function waitForHttp(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* server still starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Vite app:\n${output.join('').slice(-2000)}`);
}

export async function waitForBrowserWs(port, stderr) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch { /* Chrome still starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint:\n${stderr.join('').slice(-2000)}`);
}

export async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Failed to open browser target: ${res.status} ${await res.text()}`);
  return await res.json();
}

export class Cdp {
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

export async function evaluate(cdp, expression) {
  // SMOKE_TRACE=1 prints each evaluation's first line — find which step hangs.
  if (process.env.SMOKE_TRACE) {
    const head = String(expression).replace(/\s+/g, ' ').slice(0, 140);
    console.error(`[trace ${new Date().toISOString().slice(11, 19)}] ${head}`);
  }
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

export async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch { /* page may still be navigating */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function removeTempDir(dir) {
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

export async function stopProcess(child) {
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

const APP_ROOT = join(import.meta.dirname, '..');
const BOOTED = `document.readyState === 'complete'
  && location.pathname.endsWith('/index.html') && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')`;

/**
 * Start Vite + headless Chrome on free ports and boot the app. The page gets
 * no Vite HMR socket, so another session editing src/ cannot reload it
 * mid-check. `run(expr)` evaluates in the page and retries once on a fresh
 * load when Vite's dep re-optimisation invalidated a dynamic import.
 * @returns {Promise<{cdp: Cdp, run: (expr: string) => Promise<any>, exceptions: string[], close: () => Promise<void>}>}
 */
export async function launchApp({ prefix = 'mixomesh-app-' } = {}) {
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge executable not found.');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  const vite = spawn(process.execPath, [join(APP_ROOT, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
  { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const close = async () => {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  };
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    const target = await openTarget(debugPort, 'about:blank');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const exceptions = [];
    cdp.onEvent = (msg) => {
      if (msg.method !== 'Runtime.exceptionThrown') return;
      const d = msg.params.exceptionDetails;
      exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown');
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
      const Real = WebSocket;
      window.WebSocket = function (url, protocols) {
        if (String(protocols).includes('vite-hmr')) return { readyState: 0, addEventListener() {}, send() {}, close() {} };
        return new Real(url, protocols);
      };
    }` });
    const boot = async () => {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/index.html` });
      await waitFor(() => evaluate(cdp, BOOTED), 30000, 'app boot');
    };
    await boot();
    const run = async (expr) => {
      try {
        return await evaluate(cdp, expr);
      } catch (err) {
        if (!String(err?.message).includes('Failed to fetch dynamically imported module')) throw err;
        await boot();
        return await evaluate(cdp, expr);
      }
    };
    return {
      cdp, run, exceptions,
      close: async () => { await cdp.close(); await close(); },
    };
  } catch (err) {
    console.error(`--- vite output (tail) ---\n${viteOutput.join('').slice(-2500)}`);
    await close();
    throw err;
  }
}
