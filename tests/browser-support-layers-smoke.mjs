// Support layers smoke (plan 2026-10-29 P3.3), vite dev server + headless Chrome:
//   1. layers draw: the cube-overhang supports (spike path, drawn by src/supports/layers) change the
//      viewport, every layer node is D20-tagged;
//   2. an engine-session pick (BabylonViewportPort.pick, port of rustRaycast) through the screen hits a tip;
//   3. the screen-space brush ring follows a scripted pointer (CDP mouse moves) at its pixel radius;
//   4. the zone stamp overlay draws only triangles touching a stamped vertex;
//   5. D20: stats HUD, world extents, selection outline set, BoxSelect hits, a PNG render and an STL
//      export are identical with every layer on and with none;
//   6. perf (reported, no gate): cpuFrameMs mean while orbiting the 1M-triangle fixture with supports on
//      (`.tmp/heavy-mesh/pillow-1M.stl`, `npm run fixtures:heavy`; skipped when absent).
//
//   node tests/browser-support-layers-smoke.mjs [--no-perf]
// Shots: .tmp/p33/*.png

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, '.tmp/p33');
const HEAVY = join(ROOT, '.tmp/heavy-mesh/pillow-1M.stl');
const PERF = !process.argv.includes('--no-perf');

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')
  && typeof window.__mxSupportSpike === 'function'`;

function watchProblems(cdp, problems) {
  cdp.onEvent = (msg) => {
    const p = msg.params;
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map(a => a.value ?? a.description).join(' ')}`);
  };
}

// In-page helpers: module handles and the D20 probe.
const SETUP = `(async () => {
  const m = {
    al: await import('/src/core/AssetLoader.js'),
    sm: await import('/src/core/SceneManager.js'),
    sel: await import('/src/core/Selection.js'),
    we: await import('/src/core/scene/WorldExtents.js'),
    bs: await import('/src/core/BoxSelect.js'),
    ro: await import('/src/core/RenderOutput.js'),
    pp: await import('/src/core/print/PrintPipeline.js'),
    loader: await import('/src/core/persist/ProjectLoader.js'),
    mode: await import('/src/supports/SupportMode.ts'),
    layers: await import('/src/supports/layers/index.ts'),
    port: await import('/src/supports/BabylonViewportPort.ts'),
    model: await import('/src/supports/objectModel.ts'),
  };
  const sha = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  window.__p33 = { m, sha,
    async load(url, name, extra) {
      m.loader.resetWorld();
      const file = new File([await (await fetch(url)).blob()], name);
      const ids = await m.al.AssetLoader.loadFromBlob(file, name, undefined, {});
      if (extra) {
        const other = new File([await (await fetch(extra.url)).blob()], extra.name);
        await m.al.AssetLoader.loadFromBlob(other, extra.name, new BABYLON.Vector3(...extra.at), {});
      }
      m.sel.Selection.set([ids[0]], ids[0]);
      await new Promise(r => setTimeout(r, 1200));
      return ids;
    },
    async probe(id) {
      const scene = m.sm.SceneManager.getScene();
      await new Promise(r => scene.onAfterRenderObservable.addOnce(() => r()));
      const content = scene.meshes.filter(x => x.metadata?.meshId);
      const rtt = scene.customRenderTargets.find(t => t.name === 'mx-sel-mask-rt');
      const canvas = scene.getEngine().getRenderingCanvas();
      const rect = { x0: 0, y0: 0, x1: canvas.clientWidth, y1: canvas.clientHeight };
      const png = new Uint8Array(await (await m.ro.capturePng({ width: 320, height: 240 })).arrayBuffer());
      const stl = await m.pp.collectExportFiles(['stl'], { acknowledgeWarnings: true });
      return {
        stats: document.getElementById('status-bar')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        extents: JSON.stringify(m.we.worldExtentsOf(m.al.AssetLoader.getBabylonMesh(id))),
        worldSize: JSON.stringify(m.we.worldSizeOf(scene.meshes)),
        outline: (rtt?.renderList ?? []).map(x => x.name).sort().join(','),
        boxSelect: m.bs.meshIdsInRect(scene.meshes, rect, m.bs.projectToScreen).sort().join(','),
        contentMeshes: content.length,
        png: await sha(png), pngBytes: png.length,
        stl: stl.blocked ? 'blocked:' + stl.code : await sha(stl.files[0].bytes), stlBytes: stl.blocked ? 0 : stl.files[0].bytes.length,
      };
    },
  };
  return true;
})()`;

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  return Buffer.from(data, 'base64');
}

async function canvasPixels(cdp) {
  return evaluate(cdp, `(async () => {
    const { SceneManager } = window.__p33.m.sm;
    const scene = SceneManager.getScene();
    await new Promise(r => scene.onAfterRenderObservable.addOnce(() => r()));
    const px = await scene.getEngine().readPixels(0, 0, scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight());
    const u8 = new Uint8Array(px.buffer);
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  })()`).then(b64 => Buffer.from(b64, 'base64'));
}

function differing(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  return n;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const processes = [];
  const tempDirs = [];
  const problems = [];
  const report = {};
  try {
    const port = await freePort();
    const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(vite);
    const out = [];
    vite.stdout.on('data', c => out.push(String(c)));
    vite.stderr.on('data', c => out.push(String(c)));
    const url = `http://127.0.0.1:${port}/index.html`;
    await waitForHttp(url, 20000, out);

    const browserPath = findBrowser();
    assert(browserPath, 'Chrome/Edge executable not found.');
    const debugPort = await freePort();
    const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-p33-'));
    tempDirs.push(userDataDir);
    const browser = spawn(browserPath, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
      '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    processes.push(browser);
    const stderr = [];
    browser.stderr.on('data', c => stderr.push(String(c)));
    await waitForBrowserWs(debugPort, stderr);
    const target = await openTarget(debugPort, 'about:blank');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    watchProblems(cdp, problems);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    await waitFor(() => evaluate(cdp, BOOTED), 45000, 'app boot');
    await evaluate(cdp, SETUP);

    // ── baseline without layers ──
    const id = (await evaluate(cdp, `window.__p33.load('/tests/fixtures/support-cube-overhang.glb', 'support-cube-overhang.glb', { url: '/tests/fixtures/support-plain-cube.glb', name: 'support-plain-cube.glb', at: [0.06, 0, 0.02] })`))[0];
    const before = await evaluate(cdp, `window.__p33.probe(${JSON.stringify(id)})`);
    const again = await evaluate(cdp, `window.__p33.probe(${JSON.stringify(id)})`);
    report.renderDeterministic = before.png === again.png;
    const pixelsBefore = await canvasPixels(cdp);
    await shot(cdp, 'no-layers');

    // ── 1. layers draw ──
    const spike = await evaluate(cdp, `window.__mxSupportSpike({ preset: 'LIGHT' }).then(r => r, e => ({ error: String(e?.stack ?? e) }))`);
    assert(!spike.error, `spike failed: ${spike.error}`);
    const drawn = await evaluate(cdp, `(async () => {
      const { m } = window.__p33;
      const layers = await m.layers.appSupportLayers();
      const layer = layers.supportLayer(${JSON.stringify(id)});
      const all = [layers.root, ...layers.meshes()];
      return {
        enabled: layer.mesh.isEnabled(), triangles: layer.mesh.getTotalIndices() / 3, kinds: layer.drawnKinds(),
        tagged: all.every(n => m.layers.isSupportLayerMesh(n) && !n.metadata?.meshId && (n === layers.root || n.isPickable === false)),
        nodes: all.length,
      };
    })()`);
    const pixelsSupports = await canvasPixels(cdp);
    await shot(cdp, 'supports');
    report.draw = { tips: spike.tips, ...drawn, changedPixels: differing(pixelsBefore, pixelsSupports) };
    assert(drawn.enabled && drawn.triangles > 0, 'support mesh not drawn');
    assert(drawn.kinds.includes('neck') && drawn.kinds.includes('pillar'), `kinds drawn: ${drawn.kinds}`);
    assert(drawn.tagged, 'a support layer node is missing its D20 tag');
    assert(report.draw.changedPixels > 200, `supports barely change the viewport (${report.draw.changedPixels} px)`);

    // Tips only.
    const tipsOnly = await evaluate(cdp, `(async () => {
      const layers = await window.__p33.m.layers.appSupportLayers();
      layers.setPreviewMode('ONLY_TIP');
      const kinds = layers.supportLayer(${JSON.stringify(id)}).drawnKinds();
      layers.setPreviewMode('FULL');
      return kinds;
    })()`);
    assert(tipsOnly.length > 0 && tipsOnly.every(k => k === 'tip' || k === 'neck'), `tips only drew ${tipsOnly}`);

    // ── 2. engine pick through the screen hits a tip ──
    report.pick = await evaluate(cdp, `(async () => {
      const { m } = window.__p33;
      const layers = await m.layers.appSupportLayers();
      const id = ${JSON.stringify(id)};
      const layer = layers.supportLayer(id);
      const handle = layers.supportPickHandle(id);
      const built = layer.built;
      const offset = m.port.anchorOffset(layer.anchor, m.model.leadPosition(id));
      const isTip = (c) => c?.part === 'tip' || c?.part === 'neck';
      const tips = built.components.filter(c => isTip(c) && c.contactId);
      let tried = 0, hitTip = 0, hitOwn = 0, missed = 0;
      for (const tip of tips) {
        const c = [0, 0, 0]; let n = 0;
        for (let i = tip.start; i < tip.start + tip.count; i++) { const v = built.indices[i]; for (let a = 0; a < 3; a++) c[a] += built.positions[v * 3 + a]; n++; }
        const centroid = c.map(x => x / n);
        const screen = layers.port.worldToScreen(m.port.supportToBabylon(centroid, layer.anchor, offset));
        if (!screen) continue;
        const ray = layers.port.screenToRay(screen);
        const hit = layers.port.pick(handle, ray);
        tried++;
        if (!hit) { missed++; continue; }
        const comp = built.components.find(k => hit.triangle * 3 >= k.start && hit.triangle * 3 < k.start + k.count);
        if (isTip(comp)) hitTip++;
        if (isTip(comp) && comp.contactId === tip.contactId) hitOwn++;
      }
      return { handle, tips: tips.length, tried, hitTip, hitOwn, missed };
    })()`);
    assert(typeof report.pick.handle === 'number', 'no engine session handle for the support mesh');
    assert(report.pick.hitOwn > 0, `no screen pick hit its tip: ${JSON.stringify(report.pick)}`);

    // ── 3. brush ring follows a scripted pointer ──
    const RADIUS = 40;
    await evaluate(cdp, `window.__p33.m.layers.appSupportLayers().then(l => l.setBrush(${RADIUS}))`);
    const canvasBox = await evaluate(cdp, `(() => { const r = document.querySelector('#renderCanvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    report.brush = [];
    for (const [fx, fy] of [[0.35, 0.4], [0.6, 0.55], [0.45, 0.7]]) {
      const x = canvasBox.x + canvasBox.w * fx;
      const y = canvasBox.y + canvasBox.h * fy;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(150);
      const ring = await evaluate(cdp, `(async () => {
        const l = await window.__p33.m.layers.appSupportLayers();
        const scene = l.scene;
        await new Promise(r => scene.onAfterRenderObservable.addOnce(() => r()));
        return l.brushOnScreen() ?? null;
      })()`);
      assert(ring, 'brush ring not drawn after a pointer move');
      const want = [x - canvasBox.x, y - canvasBox.y];
      const err = Math.hypot(ring.center[0] - want[0], ring.center[1] - want[1]);
      report.brush.push({ want, center: ring.center.map(v => +v.toFixed(2)), radiusPx: +ring.radiusPx.toFixed(2), err: +err.toFixed(3) });
      assert(err < 1, `brush ring centre ${ring.center} is ${err} px off the pointer ${want}`);
      assert(Math.abs(ring.radiusPx - RADIUS) < 1, `brush ring radius ${ring.radiusPx} px, wanted ${RADIUS}`);
    }
    await shot(cdp, 'brush-ring');

    // ── 4. zone stamp overlay: stamped triangles only ──
    report.zones = await evaluate(cdp, `(async () => {
      const { m } = window.__p33;
      const layers = await m.layers.appSupportLayers();
      const id = ${JSON.stringify(id)};
      const om = m.model.objectModel(id);
      const p = om.model.local.positions;
      // A stamp on the model's lowest vertex (support-local), facing down, 4 mm.
      let low = 0; for (let v = 0; v < p.length / 3; v++) if (p[v * 3 + 1] < p[low * 3 + 1]) low = v;
      const center = [p[low * 3], p[low * 3 + 1], p[low * 3 + 2]];
      const stamp = { kind: 'paint', center, radius: 4, normal: [0, -1, 0] };
      const zones = layers.setZones(id, om.model.local, om.anchor, om.version, [stamp]);
      const idx = zones.mesh.getIndices();
      const pos = om.model.local.positions;
      let outside = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const near = [idx[t], idx[t + 1], idx[t + 2]].some(v => Math.hypot(pos[v * 3] - center[0], pos[v * 3 + 1] - center[1], pos[v * 3 + 2] - center[2]) <= 4);
        if (!near) outside++;
      }
      return { modelTriangles: om.model.local.indices.length / 3, drawn: zones.drawnTriangles, indexTriangles: idx.length / 3, outside, enabled: zones.mesh.isEnabled() };
    })()`);
    assert(report.zones.drawn > 0 && report.zones.drawn < report.zones.modelTriangles, `zone overlay drew ${report.zones.drawn} of ${report.zones.modelTriangles}`);
    assert(report.zones.outside === 0 && report.zones.indexTriangles === report.zones.drawn, `zone overlay drew unstamped triangles: ${JSON.stringify(report.zones)}`);

    // Every layer on at once: ghost tip, remove ring with a doomed contact, selection highlight, brush.
    report.allOn = await evaluate(cdp, `(async () => {
      const { m } = window.__p33;
      const layers = await m.layers.appSupportLayers();
      const id = ${JSON.stringify(id)};
      const layer = layers.supportLayer(id);
      const ids = [...new Set(layer.built.components.map(c => c.contactId).filter(Boolean))];
      layers.setSelection(id, ids.slice(0, 3));
      const isTip = (c) => (c.part === 'tip' || c.part === 'neck') && c.contactId;
      const tip = layer.built.components.find(isTip);
      const v = layer.built.indices[tip.start];
      const local = [layer.built.positions[v * 3], layer.built.positions[v * 3 + 1], layer.built.positions[v * 3 + 2]];
      const offset = m.port.anchorOffset(layer.anchor, m.model.leadPosition(id));
      const world = m.port.supportToBabylon(local, layer.anchor, offset);
      const contacts = layer.built.components.filter(isTip).map(c => {
        const k = layer.built.indices[c.start];
        return { id: c.contactId, position: [layer.built.positions[k * 3], layer.built.positions[k * 3 + 1], layer.built.positions[k * 3 + 2]] };
      });
      const doomed = layers.setRemoveRing(id, { point: world, normal: [0, -1, 0], radiusMm: 3 }, contacts);
      layers.setGhostTip({ point: world, normal: [0, -1, 0], lengthMm: 3, diameterMm: 1.2 });
      await new Promise(r => layers.scene.onAfterRenderObservable.addOnce(() => r()));
      const pm = layers.pointerMeshes();
      return { doomed: doomed ?? null, ghost: pm.ghost.isEnabled(), ring: pm.ring.isEnabled(), brush: pm.brush.isEnabled() };
    })()`);
    assert(report.allOn.doomed && report.allOn.ghost && report.allOn.ring && report.allOn.brush, `not every layer on: ${JSON.stringify(report.allOn)}`);
    await shot(cdp, 'all-layers');

    // ── 5. D20: identical with and without layers ──
    const withLayers = await evaluate(cdp, `window.__p33.probe(${JSON.stringify(id)})`);
    const visibleAfterRender = await evaluate(cdp, `window.__p33.m.layers.appSupportLayers().then(l => l.supportLayer(${JSON.stringify(id)}).mesh.isEnabled() && l.root.isEnabled())`);
    report.d20 = { before, withLayers };
    for (const key of ['stats', 'extents', 'worldSize', 'outline', 'boxSelect', 'contentMeshes', 'stl', 'stlBytes']) {
      assert(before[key] === withLayers[key], `D20 ${key} differs with layers: ${before[key]} vs ${withLayers[key]}`);
    }
    if (report.renderDeterministic) assert(before.png === withLayers.png, 'D20 PNG render differs with layers');
    else console.warn('PNG renders are not repeatable on this GPU; PNG identity not asserted');
    assert(visibleAfterRender, 'layers did not come back after the PNG render');
    assert(!String(before.stl).startsWith('blocked'), `STL export blocked: ${before.stl}`);

    // Output ignores Support Mode isolation: a PNG taken inside the mode (other object masked, layers on)
    // equals the one outside it; STL too.
    report.mode = await evaluate(cdp, `(async () => {
      const { m, sha } = window.__p33;
      const scene = m.sm.SceneManager.getScene();
      m.sm.SceneManager.frameAll?.();
      await new Promise(r => setTimeout(r, 400));
      // Listing shots (outline + gizmo suspended): the mode turns the gizmo off, which a plain PNG would show.
      const shot = async () => new Uint8Array(await (await m.ro.captureListingShot({ size: 256 })).arrayBuffer());
      const outside = await shot();
      const outsideAgain = await shot();
      const entered = m.mode.supportMode.enter();
      await new Promise(r => setTimeout(r, 300));
      const masked = scene.meshes.filter(x => x.metadata?.meshId && x.layerMask === m.mode.ISOLATION_LAYER).length;
      const png = await shot();
      window.__p33.pngs = [outside];
      window.__p33.modePng = png;
      const stl = await m.pp.collectExportFiles(['stl'], { acknowledgeWarnings: true });
      const stillMasked = scene.meshes.filter(x => x.metadata?.meshId && x.layerMask === m.mode.ISOLATION_LAYER).length;
      const cameraMask = scene.activeCamera.layerMask;
      m.mode.supportMode.exit?.();
      await new Promise(r => setTimeout(r, 300));
      return { entered, masked, stillMasked, cameraMask, deterministic: (await sha(outside)) === (await sha(outsideAgain)), outside: await sha(outside), png: await sha(png), stl: stl.blocked ? 'blocked:' + stl.code : await sha(stl.files[0].bytes) };
    })()`);
    assert(report.mode.entered && report.mode.masked > 0, `Support Mode did not isolate: ${JSON.stringify(report.mode)}`);
    assert(report.mode.stillMasked === report.mode.masked && (report.mode.cameraMask & 0x10000000) === 0, 'render left the isolation state changed');
    assert(report.mode.stl === before.stl, 'STL export inside Support Mode differs');
    const dumpPng = async (expr, name) => writeFileSync(join(OUT, name), Buffer.from(await evaluate(cdp, `(() => { const u8 = ${expr}; let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); })()`), 'base64'));
    await dumpPng('window.__p33.pngs[0]', 'render-outside-mode.png');
    await dumpPng('window.__p33.modePng', 'render-in-mode.png');
    if (report.mode.deterministic) assert(report.mode.png === report.mode.outside, 'PNG render inside Support Mode differs from outside it (.tmp/p33/render-*-mode.png)');

    // ── 6. perf on the 1M fixture (reported) ──
    if (PERF && existsSync(HEAVY)) {
      await evaluate(cdp, `window.__mxSupportSpikeTools.clear()`);
      report.perf = await evaluate(cdp, `(async () => {
        const ids = await window.__p33.load('/.tmp/heavy-mesh/pillow-1M.stl', 'pillow-1M.stl');
        const scene = window.__p33.m.sm.SceneManager.getScene();
        const engine = scene.getEngine();
        const orbit = async () => {
          const cam = scene.activeCamera; const a = []; let t = 0;
          const b = engine.onBeginFrameObservable.add(() => { t = performance.now(); });
          const e = engine.onEndFrameObservable.add(() => { a.push(performance.now() - t); });
          const end = performance.now() + 2000;
          await new Promise(res => { const step = () => { cam.alpha += 0.02; performance.now() < end ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
          engine.onBeginFrameObservable.remove(b); engine.onEndFrameObservable.remove(e);
          a.sort((x, y) => x - y);
          return { mean: +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2), p95: +(a[Math.floor(a.length * 0.95)] ?? 0).toFixed(2), frames: a.length };
        };
        window.__p33.m.sm.SceneManager.frameAll?.();
        await new Promise(r => setTimeout(r, 500));
        const without = await orbit();
        const t0 = performance.now();
        const spike = await window.__mxSupportSpike({ objectId: ids[0], preset: 'LIGHT' }).catch(e => ({ error: String(e) }));
        const generateMs = Math.round(performance.now() - t0);
        const tris = scene.meshes.filter(m => m.metadata?.meshId).reduce((n, m) => n + m.getTotalIndices() / 3, 0);
        const withSupports = await orbit();
        return { modelTriangles: tris, supportTriangles: spike.supportTriangles ?? null, tips: spike.tips ?? null, error: spike.error ?? null, generateMs, cpuFrameMsWithout: without, cpuFrameMsWithSupports: withSupports };
      })()`);
    } else {
      report.perf = { skipped: PERF ? `${HEAVY} missing (npm run fixtures:heavy)` : '--no-perf' };
    }

    await cdp.close();
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 1));
    assert(problems.length === 0, `console problems: ${problems.join(' | ')}`);
    console.log(`PASS support layers: ${spike.tips} tips drawn (${report.draw.changedPixels} px changed), pick hit ${report.pick.hitOwn}/${report.pick.tried} own tips, brush ring within ${Math.max(...report.brush.map(b => b.err))} px, zones ${report.zones.drawn}/${report.zones.modelTriangles} triangles, D20 identical (stats, extents, outline, box select, STL${report.renderDeterministic ? ', PNG' : ''}), Support Mode render/export = outside`
      + (report.perf.cpuFrameMsWithSupports ? `; 1M orbit cpuFrameMs mean ${report.perf.cpuFrameMsWithSupports.mean} with supports (${report.perf.cpuFrameMsWithout.mean} without)` : ''));
  } finally {
    for (const p of processes.reverse()) await stopProcess(p);
    await sleep(200);
    for (const dir of tempDirs) removeTempDir(dir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
