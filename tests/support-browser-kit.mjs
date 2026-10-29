// Shared plumbing of the Support Mode walk smokes (plan P3.6): Vite + headless Chrome, a page-side
// helper object `window.__w` that reads the support record / caches / layers of an object and
// projects its supports to the screen, real pointer and key events through CDP, and a procedural
// torus fixture (many overhang tips, no big file in the repo).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget, Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export { sleep, waitFor, assert };

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas') && !!window.__mxSupportLive`;

/** A binary STL of a torus lying in the XY plane (mm): tube radius r, ring radius R, `nu` x `nv` quads. */
export function torusStl(R = 14, r = 5, nu = 72, nv = 36) {
  const tris = [];
  const p = (i, j) => {
    const u = ((i % nu) / nu) * 2 * Math.PI;
    const v = ((j % nv) / nv) * 2 * Math.PI;
    return [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)];
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    tris.push([a, b, c], [a, c, d]);
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, k) => {
    const o = 84 + k * 50;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    [n[0] / len, n[1] / len, n[2] / len].forEach((x, q) => buf.writeFloatLE(x, o + q * 4));
    t.forEach((v, q) => v.forEach((x, k2) => buf.writeFloatLE(x, o + 12 + q * 12 + k2 * 4)));
  });
  return buf;
}

/** Write the torus fixture under .tmp/<dir>/ (served by Vite as /.tmp/<dir>/torus.stl). */
export function writeTorus(dir) {
  const out = join(ROOT, '.tmp', dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'torus.stl'), torusStl());
  return `/.tmp/${dir}/torus.stl`;
}

const SETUP = `(async () => {
  const m = {
    al: await import('/src/core/AssetLoader.js'), sm: await import('/src/core/SceneManager.js'),
    sel: await import('/src/core/Selection.js'), loader: await import('/src/core/persist/ProjectLoader.js'),
    st: await import('/src/core/StateManager.js'), hist: await import('/src/core/HistoryManager.js'),
    mode: await import('/src/supports/SupportMode.ts'), ui: await import('/src/panels/supports/supportUi.ts'),
    sess: await import('/src/panels/supports/sessionStore.ts'), data: await import('/src/panels/supports/supportData.ts'),
    layers: await import('/src/supports/layers/index.ts'), model: await import('/src/supports/objectModel.ts'),
    store: await import('/src/supports/store.ts'), cache: await import('/src/supports/supportCache.ts'),
    port: await import('/src/supports/BabylonViewportPort.ts'), cmds: await import('/src/supports/commands/index.ts'),
    live: await import('/src/supports/live/liveGeneration.ts'),
  };
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  const w = window.__w = { m, t: { TransformCommand: (await import('/src/core/commands/TransformCommands.js')).TransformCommand, captureWorld: (await import('/src/core/commands/support.js')).captureWorld } };
  w.load = async (url, name) => {
    m.mode.supportMode.exit();
    m.loader.resetWorld();
    const file = new File([await (await fetch(url)).blob()], name);
    const ids = await m.al.AssetLoader.loadFromBlob(file, name, undefined, {});
    m.sel.Selection.set([ids[0]], ids[0]);
    await new Promise(r => setTimeout(r, 1200));
    return ids[0];
  };
  w.rec = (id) => m.store.readSupports(id);
  w.stats = () => JSON.parse(JSON.stringify(window.__mxSupportLive.stats));
  w.busy = (id) => window.__mxSupportLive.busy(id);
  /** Contacts on show with their screen positions (CSS px of the page). */
  w.contacts = async (id) => {
    const layers = await m.layers.appSupportLayers();
    const rec = m.store.readSupports(id);
    const om = m.model.objectModel(id);
    const offset = m.port.anchorOffset(om.anchor, m.model.leadPosition(id));
    const deleted = new Set(rec?.deleted ?? []);
    const auto = (m.cache.cachedPlacement(id) ?? []).filter(p => !deleted.has(p.id)).map(p => ({ id: p.id, manual: false, position: p.position }));
    const hand = (rec?.manual ?? []).map(p => ({ id: p.id, manual: true, position: p.position }));
    const r = document.querySelector('#renderCanvas').getBoundingClientRect();
    return [...auto, ...hand].map(c => {
      const s = layers.port.worldToScreen(m.port.supportToBabylon(c.position, om.anchor, offset));
      return { id: c.id, manual: c.manual, x: s ? s[0] + r.left : null, y: s ? s[1] + r.top : null };
    });
  };
  /** Counts the walk compares: automatic on show, manual, removed, customised, zone stamps. */
  w.counts = (id) => {
    const rec = m.store.readSupports(id);
    const deleted = new Set(rec?.deleted ?? []);
    const auto = (m.cache.cachedPlacement(id) ?? []).filter(p => !deleted.has(p.id)).length;
    return { auto, manual: rec?.manual.length ?? 0, removed: rec?.deleted.length ?? 0, customised: Object.keys(rec?.overrides ?? {}).length, stamps: rec?.stamps?.kinds?.length ?? 0 };
  };
  /** What the screen shows: triangles of the drawn support mesh, the contact ids it carries, what the cache (an export) holds. */
  w.drawn = async (id) => {
    const layers = await m.layers.appSupportLayers();
    const layer = layers.supportLayer(id);
    const rec = m.store.readSupports(id);
    const mesh = layer?.drawnMesh();
    const built = layer?.built;
    const cached = rec ? m.cache.cachedSupportMesh(id, rec.revision) : undefined;
    return {
      enabled: !!mesh?.isEnabled(),
      tris: mesh && mesh.isEnabled() ? mesh.getTotalIndices() / 3 : 0,
      contactIds: built ? [...new Set(built.components.flatMap(c => c.contactId ? [c.contactId] : []))] : [],
      builtTris: built ? built.indices.length / 3 : 0,
      cachedTris: cached ? cached.indices.length / 3 : -1,
      revisionMatches: !!cached,
      stale: !!layer?.isStale(),
      parts: built ? [...new Set(built.components.map(c => c.part))] : [],
    };
  };
  /** Screen box (page px) of the object's bounding box: { left, top, right, bottom }. */
  w.box = async (id) => {
    const layers = await m.layers.appSupportLayers();
    const mesh = m.al.AssetLoader.getBabylonMesh(id);
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    const r = document.querySelector('#renderCanvas').getBoundingClientRect();
    const xs = [], ys = [];
    for (const c of bb.vectorsWorld) { const s = layers.port.worldToScreen([c.x, c.y, c.z]); if (s) { xs.push(s[0] + r.left); ys.push(s[1] + r.top); } }
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  /** Screen point (page px) of the underside of the torus tube at deg degrees around the ring (the lowest line of the tube). */
  w.ringBottom = async (id, deg) => {
    const layers = await m.layers.appSupportLayers();
    const mesh = m.al.AssetLoader.getBabylonMesh(id);
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    const c = bb.centerWorld, e = bb.extendSizeWorld;
    const R = e.x - e.y, a = deg * Math.PI / 180;
    const s = layers.port.worldToScreen([c.x + R * Math.cos(a), c.y - e.y, c.z + R * Math.sin(a)]);
    const r = document.querySelector('#renderCanvas').getBoundingClientRect();
    return s ? [s[0] + r.left, s[1] + r.top] : null;
  };
  /** Screen centre of each contact's foot (what Bottom view shows nearest the camera), ownership verified by a pick. */
  w.feet = async (id) => {
    const layers = await m.layers.appSupportLayers();
    const layer = layers.supportLayer(id);
    const b = layer.built;
    const om = m.model.objectModel(id);
    const handle = layers.supportPickHandle(id);
    const offset = m.port.anchorOffset(om.anchor, m.model.leadPosition(id));
    const r = document.querySelector('#renderCanvas').getBoundingClientRect();
    const out = [];
    for (const comp of b.components) {
      if (comp.part !== 'foot' || !comp.contactId) continue;
      const seen = new Set(); let x = 0, y = 0, z = 0, n = 0;
      for (let i = comp.start; i < comp.start + comp.count; i++) { const v = b.indices[i]; if (seen.has(v)) continue; seen.add(v); x += b.positions[v*3]; y += b.positions[v*3+1]; z += b.positions[v*3+2]; n++; }
      const screen = layers.port.worldToScreen(m.port.supportToBabylon([x/n, y/n, z/n], om.anchor, offset));
      const ray = screen && layers.port.screenToRay(screen);
      const hit = ray && layers.port.pick(handle, ray);
      if (!hit) continue;
      const owner = b.components.find(c => hit.triangle * 3 >= c.start && hit.triangle * 3 < c.start + c.count);
      if (owner?.contactId === comp.contactId) out.push({ id: comp.contactId, x: screen[0] + r.left, y: screen[1] + r.top });
    }
    return out;
  };
  w.selection = () => [...m.sess.supportSession.get().selection];
  w.send = (event) => { m.sess.supportSession.send(event); return true; };
  w.idle = async (id) => {
    for (let i = 0; i < 400; i++) {
      if (!window.__mxSupportLive.busy(id)) { await new Promise(r => setTimeout(r, 350)); if (!window.__mxSupportLive.busy(id)) return true; }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  return true;
})()`;

/**
 * Boot the app (Vite dev server + headless Chrome, GPU unless `swiftshader`) and return the driver.
 * @returns {Promise<object>}
 */
export async function bootSupportApp({ prefix = 'mixomesh-walk-', swiftshader = false } = {}) {
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge not found');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOut = [];
  vite.stdout.on('data', (c) => viteOut.push(String(c)));
  vite.stderr.on('data', (c) => viteOut.push(String(c)));
  const flags = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,950', '--no-first-run', '--disable-background-networking',
    ...(swiftshader ? ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist']),
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'];
  const browser = spawn(browserPath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  const bErr = [];
  browser.stderr.on('data', (c) => bErr.push(String(c)));
  const problems = [];
  let cdp;
  const close = async () => {
    try { await cdp?.close(); } catch { /* closing */ }
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  };
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 30000, viteOut);
    await waitForBrowserWs(debugPort, bErr);
    const target = await openTarget(debugPort, 'about:blank');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.onEvent = (msg) => {
      const p = msg.params;
      if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
      else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)}`);
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `{ const Real = WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite-hmr')) return { readyState: 0, addEventListener() {}, send() {}, close() {} }; return new Real(u, p); }; localStorage.setItem('mx-onboard-v1', '1'); }` });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/index.html` });
    await waitFor(() => evaluate(cdp, BOOTED), 120000, 'app boot');
    const run = (expr) => evaluate(cdp, expr);
    await run(SETUP);

    const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
    const api = {
      cdp, run, problems, appPort, close, sleep, waitFor,
      /** Evaluate `__w.<call>` and return its value. */
      w: (call) => run(`window.__w.${call}`),
      shot: async (dir, name) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); },
      click: async (x, y, button = 'left', modifiers = 0) => {
        const b = { left: 1, right: 2 }[button];
        await mouse('mouseMoved', x, y, { modifiers });
        await mouse('mousePressed', x, y, { button, buttons: b, clickCount: 1, modifiers });
        await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: 1, modifiers });
        await sleep(150);
      },
      /** A press-move-release stroke through `points`; `during(i)` runs after the i-th move (button still down). */
      stroke: async (points, { button = 'left', steps = 6, during } = {}) => {
        const b = { left: 1, right: 2 }[button];
        const [x0, y0] = points[0];
        await mouse('mouseMoved', x0, y0);
        await mouse('mousePressed', x0, y0, { button, buttons: b, clickCount: 1 });
        let n = 0;
        for (let k = 1; k < points.length; k++) {
          const [ax, ay] = points[k - 1], [bx, by] = points[k];
          for (let s = 1; s <= steps; s++) {
            await mouse('mouseMoved', ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, { buttons: b });
            await sleep(12);
          }
          await during?.(n++);
        }
        const [xe, ye] = points[points.length - 1];
        await mouse('mouseReleased', xe, ye, { button, buttons: 0, clickCount: 1 });
        await sleep(200);
      },
      hover: (x, y) => mouse('mouseMoved', x, y),
      key: async (key, { ctrl = false, shift = false } = {}) => {
        const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
        const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
        const base = { key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Delete: 46, Escape: 27, Enter: 13 }[key] ?? 0) };
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        await sleep(150);
      },
      /** Type `text` into the number field labelled `label` (exact label text) and press Enter. */
      typeField: async (label, text) => {
        const at = await run(`(() => {
          const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
          const i = l && document.getElementById(l.htmlFor);
          if (!i) return null; i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        if (!at) return false;
        await api.click(at[0], at[1]);
        await api.key('a', { ctrl: true });
        await cdp.send('Input.insertText', { text });
        await api.key('Enter');
        await run(`document.activeElement?.blur?.(); true`);
        await sleep(300);
        return true;
      },
      /** Click a button of the page by its visible text (exact), within `scope` css. */
      pressButton: (text, scope = 'body') => run(`(() => {
        const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(x => x.textContent.replace(/\\s+/g, ' ').trim().replace(/ (Del|Esc|A|S)$/, '') === ${JSON.stringify(text)});
        if (!b || b.disabled) return false; b.click(); return true; })()`),
    };
    return api;
  } catch (error) {
    console.error(`--- vite output (tail) ---\n${viteOut.join('').slice(-2000)}`);
    await close();
    throw error;
  }
}
