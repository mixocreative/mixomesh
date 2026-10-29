// Live support generation (plan 2026-10-29 P3.5) on the real app, real GPU by default:
//   - Generate on cube-overhang (lift step, placement, build, check), time reported
//   - gestures through real pointer events: add / remove (right click) / select (click) / Drag over /
//     zone paint, each one undo step where it is a document edit, and each survives a regenerate
//   - Show on a finding moves the camera
//   - 10 rapid settings changes end in exactly ONE rendered result for the last value
//   - the same rapid-change check on the 1M fixture, a long-task observer on the main thread,
//     generation time reported (set --no-heavy to skip)
//   - screenshot of Support Mode with supports + problem list in .tmp/p35/
//
//   node tests/browser-support-live-smoke.mjs [--swiftshader] [--no-heavy]

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget, Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, '.tmp/p35');
const HEAVY = join(ROOT, '.tmp/heavy-mesh/pillow-1M.stl');
const SWIFT = process.argv.includes('--swiftshader');
const WITH_HEAVY = !process.argv.includes('--no-heavy') && existsSync(HEAVY);
mkdirSync(OUT, { recursive: true });

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas') && !!window.__mxSupportLive`;

const SETUP = `(async () => {
  const m = {
    al: await import('/src/core/AssetLoader.js'), sm: await import('/src/core/SceneManager.js'),
    sel: await import('/src/core/Selection.js'), loader: await import('/src/core/persist/ProjectLoader.js'),
    st: await import('/src/core/StateManager.js'), hist: await import('/src/core/HistoryManager.js'),
    mode: await import('/src/supports/SupportMode.ts'), ui: await import('/src/panels/supports/supportUi.ts'),
    sess: await import('/src/panels/supports/sessionStore.ts'), data: await import('/src/panels/supports/supportData.ts'),
    layers: await import('/src/supports/layers/index.ts'), model: await import('/src/supports/objectModel.ts'),
    store: await import('/src/supports/store.ts'), cache: await import('/src/supports/supportCache.ts'),
    port: await import('/src/supports/BabylonViewportPort.ts'),
  };
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  window.__s = { m,
    async load(url, name) {
      m.mode.supportMode.exit();
      m.loader.resetWorld();
      const file = new File([await (await fetch(url)).blob()], name);
      const ids = await m.al.AssetLoader.loadFromBlob(file, name, undefined, {});
      m.sel.Selection.set([ids[0]], ids[0]);
      await new Promise(r => setTimeout(r, 1200));
      return ids[0];
    },
    rec(id) { return m.store.readSupports(id); },
    undoLabel() { return m.hist.HistoryManager.getUndoLabel(); },
  };
  return true;
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge not found');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-live-'));
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOut = [];
  vite.stdout.on('data', (c) => viteOut.push(String(c)));
  vite.stderr.on('data', (c) => viteOut.push(String(c)));
  const flags = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,950', '--no-first-run', '--disable-background-networking',
    ...(SWIFT ? ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist']),
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'];
  const browser = spawn(browserPath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  const bErr = [];
  browser.stderr.on('data', (c) => bErr.push(String(c)));
  const report = { gpu: null, cube: {}, heavy: {}, checks: [] };
  const problems = [];
  const check = (cond, msg) => { report.checks.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) problems.push(msg); };
  let cdp;
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
    report.gpu = await run(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);
    console.log('renderer:', report.gpu);

    const stats = () => run(`JSON.stringify(window.__mxSupportLive.stats)`).then(JSON.parse);
    const click = async (x, y, button = 'left') => {
      const b = { left: 1, right: 2 }[button];
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: b, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
      await sleep(120);
    };
    const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    // ───────────────── cube-overhang ─────────────────
    const id = await run(`window.__s.load('/tests/fixtures/support-cube-overhang.glb', 'support-cube-overhang.glb')`);
    await run(`window.__s.id = ${JSON.stringify(id)}; window.__s.m.sm.SceneManager.frameAll?.(); true`);
    await sleep(500);
    check(await run(`window.__s.m.mode.supportMode.enter()`), 'Support Mode opens on the selected object');
    await sleep(500);
    const t0 = Date.now();
    await run(`window.__s.m.ui.handlers.generate([${JSON.stringify(id)}]); true`);
    await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1 && !window.__mxSupportLive.busy(${JSON.stringify(id)})`), 60000, 'first generation');
    report.cube.generateMs = Date.now() - t0;
    const st = await stats();
    report.cube.engineMs = st.last.ms;
    report.cube.tips = st.last.tips;
    report.cube.verdict = st.last.verdict;
    console.log('cube-overhang generate', report.cube);
    check(st.last.tips > 0, `cube-overhang generated ${st.last.tips} tips`);
    check(await run(`window.__s.rec(${JSON.stringify(id)}).sourceHash !== null`), 'the record carries the build (sourceHash)');
    const lifted = await run(`(() => { const mesh = window.__s.m.al.AssetLoader.getBabylonMesh(${JSON.stringify(id)}); mesh.computeWorldMatrix(true); return mesh.getBoundingInfo().boundingBox.minimumWorld.y; })()`);
    check(lifted > 0.001, `the object was lifted off the bed (minY ${lifted})`);
    await run(`window.__s.m.hist.HistoryManager.undo(); window.__s.m.hist.HistoryManager.redo(); true`);

    // helpers for screen positions
    const canvasOffset = await run(`(() => { const r = document.querySelector('#renderCanvas').getBoundingClientRect(); return [r.left, r.top]; })()`);
    const modelPoint = async () => run(`(async () => {
      const layers = await window.__s.m.layers.appSupportLayers();
      const mesh = window.__s.m.al.AssetLoader.getBabylonMesh(${JSON.stringify(id)});
      const c = mesh.getBoundingInfo().boundingBox.centerWorld;
      const s = layers.port.worldToScreen([c.x, c.y, c.z]);
      return s;
    })()`);
    const pillarPoint = async () => run(`(async () => {
      const layers = await window.__s.m.layers.appSupportLayers();
      const layer = layers.supportLayer(${JSON.stringify(id)});
      const b = layer.built;
      const om = window.__s.m.model.objectModel(${JSON.stringify(id)});
      const handle = layers.supportPickHandle(${JSON.stringify(id)});
      const offset = window.__s.m.port.anchorOffset(om.anchor, window.__s.m.model.leadPosition(${JSON.stringify(id)}));
      for (const comp of b.components) {
        if (comp.part !== 'pillar' || !comp.contactId) continue;
        const seen = new Set(); let x = 0, y = 0, z = 0, n = 0;
        for (let i = comp.start; i < comp.start + comp.count; i++) { const v = b.indices[i]; if (seen.has(v)) continue; seen.add(v); x += b.positions[v*3]; y += b.positions[v*3+1]; z += b.positions[v*3+2]; n++; }
        const bab = window.__s.m.port.supportToBabylon([x/n, y/n, z/n], om.anchor, offset);
        const screen = layers.port.worldToScreen(bab);
        const ray = screen && layers.port.screenToRay(screen);
        const hit = ray && layers.port.pick(handle, ray);
        if (!hit) continue;
        const mh = layers.picks.handle('model:' + ${JSON.stringify(id)}, om.version, () => ({ objectId: ${JSON.stringify(id)}, anchor: om.anchor, mesh: om.model.local, side: 2 }));
        const modelHit = mh === undefined ? undefined : layers.port.pick(mh, ray);
        if (modelHit && modelHit.distance < hit.distance - 1e-6) continue;
        const owner = b.components.find(c => hit.triangle * 3 >= c.start && hit.triangle * 3 < c.start + c.count);
        if (owner?.contactId === comp.contactId) return { id: comp.contactId, screen };
      }
      return null;
    })()`);

    // add: one undo step, survives a regenerate
    await run(`window.__s.m.sess.supportSession.send({ type: 'setTool', tool: 'add' }); window.__s.m.sess.supportSession.send({ type: 'setAddAction', action: 'add' }); true`);
    const mp = await modelPoint();
    const before = await run(`JSON.stringify({ manual: window.__s.rec(${JSON.stringify(id)}).manual.length, label: window.__s.undoLabel() })`).then(JSON.parse);
    await click(canvasOffset[0] + mp[0], canvasOffset[1] + mp[1]);
    const afterAdd = await run(`JSON.stringify({ manual: window.__s.rec(${JSON.stringify(id)}).manual.length, label: window.__s.undoLabel() })`).then(JSON.parse);
    check(afterAdd.manual === before.manual + 1 && /Add support/i.test(afterAdd.label), `a click adds one support, one undo step (${afterAdd.label})`);
    await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 2 && !window.__mxSupportLive.busy(${JSON.stringify(id)})`), 30000, 'rebuild after add');
    await run(`window.__s.m.ui.handlers.generate([${JSON.stringify(id)}]); true`);
    await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 3 && !window.__mxSupportLive.busy(${JSON.stringify(id)})`), 30000, 'regenerate');
    check(await run(`window.__s.rec(${JSON.stringify(id)}).manual.length`) === before.manual + 1, 'the added support survives a regenerate');
    // remove with right click on the same spot
    await click(canvasOffset[0] + mp[0], canvasOffset[1] + mp[1], 'right');
    const afterDel = await run(`JSON.stringify({ manual: window.__s.rec(${JSON.stringify(id)}).manual.length, deleted: window.__s.rec(${JSON.stringify(id)}).deleted.length, label: window.__s.undoLabel() })`).then(JSON.parse);
    check(afterDel.manual === before.manual && /Delete support/i.test(afterDel.label), `a right click removes one support, one undo step (${afterDel.label})`);
    await run(`window.__s.m.hist.HistoryManager.undo(); true`);
    check(await run(`window.__s.rec(${JSON.stringify(id)}).manual.length`) === before.manual + 1, 'one undo brings the removed support back');
    await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(id)})`), 30000, 'idle');

    // select by click on a pillar
    await run(`window.__s.m.sess.supportSession.send({ type: 'setTool', tool: 'select' }); window.__s.m.sess.supportSession.send({ type: 'setSelectStyle', style: 'click' }); true`);
    const pp = await pillarPoint();
    check(!!pp, 'a pillar can be hit from the camera');
    await click(canvasOffset[0] + pp.screen[0], canvasOffset[1] + pp.screen[1]);
    const picked = await run(`[...window.__s.m.sess.supportSession.get().selection]`);
    check(picked.length === 1, `a click selects one support (view state, no undo step): ${picked.join(',')}`);
    // drag over
    await run(`window.__s.m.sess.supportSession.send({ type: 'clearSelection' }); window.__s.m.sess.supportSession.send({ type: 'setSelectStyle', style: 'brush' }); window.__s.m.sess.supportSession.send({ type: 'setBrushRadius', radius: 60 }); true`);
    const x0 = canvasOffset[0] + pp.screen[0], y0 = canvasOffset[1] + pp.screen[1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - 40, y: y0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0 - 40, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 0; k <= 8; k++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - 40 + k * 10, y: y0, buttons: 1 }); await sleep(30); }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 40, y: y0, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const dragged = await run(`window.__s.m.sess.supportSession.get().selection.size`);
    check(dragged >= 1, `Drag over selected ${dragged} support(s)`);
    // zone paint: one undo step, survives a regenerate
    await run(`window.__s.m.sess.supportSession.send({ type: 'clearSelection' }); window.__s.m.sess.supportSession.send({ type: 'exit' }); window.__s.m.sess.supportSession.send({ type: 'enterZones' }); window.__s.m.sess.supportSession.send({ type: 'setZoneKind', kind: 'paint' }); window.__s.m.sess.supportSession.send({ type: 'setZoneRadius', radius: 1.5 }); true`);
    const zBefore = await run(`window.__s.rec(${JSON.stringify(id)}).stamps.kinds.length`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvasOffset[0] + mp[0] - 20, y: canvasOffset[1] + mp[1] });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasOffset[0] + mp[0] - 20, y: canvasOffset[1] + mp[1], button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 0; k <= 8; k++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvasOffset[0] + mp[0] - 20 + k * 5, y: canvasOffset[1] + mp[1], buttons: 1 }); await sleep(30); }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasOffset[0] + mp[0] + 20, y: canvasOffset[1] + mp[1], button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    const zAfter = await run(`JSON.stringify({ n: window.__s.rec(${JSON.stringify(id)}).stamps.kinds.length, label: window.__s.undoLabel() })`).then(JSON.parse);
    check(zAfter.n > zBefore && /zone/i.test(zAfter.label), `a zone stroke adds ${zAfter.n - zBefore} stamps in one undo step (${zAfter.label})`);
    await run(`window.__s.m.hist.HistoryManager.undo(); true`);
    check(await run(`window.__s.rec(${JSON.stringify(id)}).stamps.kinds.length`) === zBefore, 'one undo removes the whole stroke');
    await run(`window.__s.m.hist.HistoryManager.redo(); true`);
    await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(id)})`), 30000, 'idle after zones');
    await run(`window.__s.m.ui.handlers.generate([${JSON.stringify(id)}]); true`);
    await sleep(300);
    await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(id)})`), 30000, 'regenerate after zones');
    check(await run(`window.__s.rec(${JSON.stringify(id)}).stamps.kinds.length`) === zAfter.n, 'the zone stamps survive a regenerate');
    await run(`window.__s.m.sess.supportSession.send({ type: 'exit' }); window.__s.m.sess.supportSession.send({ type: 'enterEdit' }); true`);

    // Show moves the camera
    const problemsNow = await run(`JSON.stringify(window.__s.m.ui.supportUi.get().problems.slice(0, 1))`).then(JSON.parse);
    const spot = problemsNow[0] ?? { kind: 'overhang', position: [0, 0, 0], area: 1, unitId: id, inZone: false };
    const cam0 = await run(`JSON.stringify(window.__s.m.sm.SceneManager.getCamera().target.asArray())`).then(JSON.parse);
    await run(`window.__s.m.ui.handlers.showProblem(${JSON.stringify({ ...spot, unitId: id })}); true`);
    await sleep(700);
    const cam1 = await run(`JSON.stringify(window.__s.m.sm.SceneManager.getCamera().target.asArray())`).then(JSON.parse);
    check(Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1e-5, `Show moved the camera target (${problemsNow.length} real finding(s))`);
    await run(`window.__s.m.ui.handlers.setBottomView(true); true`);
    await sleep(500);
    check(await run(`window.__s.m.ui.supportUi.get().bottomView && window.__s.m.sm.SceneManager.getCamera().beta > 2.5`), 'Bottom view looks up from below');
    await run(`window.__s.m.ui.handlers.setBottomView(false); true`);
    await sleep(500);

    // 10 rapid slider changes → one result for the last value
    const rapid = async (label, mode) => {
      const s0 = await stats();
      const values = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0];
      for (const v of values) { await run(`window.__s.m.data.commitSetting(${JSON.stringify(id)}, { view: {}, selected: [] }, 'neckLength', ${v}); true`); await sleep(40); }
      await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(id)}) && window.__mxSupportLive.stats.rendered > ${s0.rendered}`), mode === 'heavy' ? 240000 : 60000, `${label} settled`);
      await sleep(1500);
      const s1 = await stats();
      check(s1.rendered - s0.rendered === 1, `${label}: 10 rapid changes rendered ${s1.rendered - s0.rendered} result(s), jobs started ${s1.started - s0.started}`);
      check(s1.last.settings.neckLength === 3.0, `${label}: the result is for the last value (neckLength ${s1.last.settings.neckLength})`);
      return { rendered: s1.rendered - s0.rendered, started: s1.started - s0.started, ms: s1.last.ms };
    };
    report.cube.rapid = await rapid('cube-overhang', 'cube');
    // Removing most supports leaves overhangs uncovered: the problem list fills.
    const sr = await stats();
    await run(`(() => { const id = ${JSON.stringify(id)}; const rec = window.__s.rec(id); const ids = window.__s.m.data.liveContactIds(id, rec); window.__s.m.data.commitDelete(id, ids.slice(1)); return ids.length; })()`);
    await sleep(800);
    await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(id)}) && window.__mxSupportLive.stats.rendered > ${sr.rendered}`), 60000, 'sparse supports');
    await sleep(800);
    const listed = await run(`JSON.stringify(window.__s.m.ui.supportUi.get().problems.map(p => ({ kind: p.kind, area: Math.round(p.area), position: p.position, unitId: p.unitId, inZone: p.inZone })))`).then(JSON.parse);
    report.cube.problems = listed.map((p) => p.kind);
    check(listed.length > 0, `the problem list shows ${listed.length} finding(s) after removing most supports: ${[...new Set(report.cube.problems)].join(', ')}`);
    const verdictShown = await run(`document.querySelector('.sp-verdict')?.textContent ?? null`);
    check(!!verdictShown, `the verdict line shows: ${verdictShown}`);
    if (listed.length > 0) {
      const camA = await run(`JSON.stringify(window.__s.m.sm.SceneManager.getCamera().target.asArray())`).then(JSON.parse);
      await run(`window.__s.m.ui.handlers.showProblem(${JSON.stringify(listed[0])}); true`);
      await sleep(700);
      const camB = await run(`JSON.stringify(window.__s.m.sm.SceneManager.getCamera().target.asArray())`).then(JSON.parse);
      check(Math.hypot(camB[0] - camA[0], camB[1] - camA[1], camB[2] - camA[2]) > 1e-5, 'Show on a real finding moved the camera');
    }
    await run(`window.__s.m.sm.SceneManager.frameAll?.(); true`);
    await sleep(500);
    await shot('support-mode.png');
    const ltCube = await run(`Math.max(0, ...window.__lt)`);
    report.cube.longestTaskMs = Math.round(ltCube);

    // ───────────────── 1M fixture ─────────────────
    if (WITH_HEAVY) {
      const hid = await run(`window.__s.load('/.tmp/heavy-mesh/pillow-1M.stl', 'pillow-1M.stl')`);
      await sleep(2500);
      // Only what Support Mode does is measured: the import above has its own budget.
      await run(`window.__lt.length = 0; true`);
      await run(`window.__s.id = ${JSON.stringify(hid)}; true`);
      check(await run(`window.__s.m.mode.supportMode.enter()`), '1M: Support Mode opens');
      await sleep(500);
      const h0 = Date.now();
      await run(`window.__s.m.ui.handlers.generate([${JSON.stringify(hid)}]); true`);
      await waitFor(() => run(`window.__mxSupportLive.stats.last?.objectId === ${JSON.stringify(hid)} && !window.__mxSupportLive.busy(${JSON.stringify(hid)})`), 300000, '1M generation');
      report.heavy.generateMs = Date.now() - h0;
      const hs = await stats();
      report.heavy.engineMs = hs.last.ms;
      report.heavy.tips = hs.last.tips;
      console.log('1M generate', report.heavy);
      await run(`window.__s.m.sm.SceneManager.frameAll?.(); true`);
      report.heavy.rapid = await (async () => {
        const s0 = await stats();
        const values = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0];
        for (const v of values) { await run(`window.__s.m.data.commitSetting(${JSON.stringify(hid)}, { view: {}, selected: [] }, 'neckLength', ${v}); true`); await sleep(40); }
        await waitFor(() => run(`!window.__mxSupportLive.busy(${JSON.stringify(hid)}) && window.__mxSupportLive.stats.rendered > ${s0.rendered}`), 240000, '1M rapid settled');
        await sleep(2000);
        const s1 = await stats();
        check(s1.rendered - s0.rendered === 1, `1M: 10 rapid changes rendered ${s1.rendered - s0.rendered} result(s), jobs started ${s1.started - s0.started}`);
        check(s1.last.settings.neckLength === 3.0, `1M: the result is for the last value (neckLength ${s1.last.settings.neckLength})`);
        return { rendered: s1.rendered - s0.rendered, started: s1.started - s0.started, ms: s1.last.ms };
      })();
      const lt = await run(`JSON.stringify(window.__lt.map(Math.round).sort((a, b) => b - a).slice(0, 8))`);
      report.heavy.longTasksMs = JSON.parse(lt);
      report.heavy.longestTaskMs = report.heavy.longTasksMs[0] ?? 0;
      report.heavy.steps = (await stats()).steps;
      console.log('1M long tasks', report.heavy.longTasksMs, 'steps', report.heavy.steps);
      check(report.heavy.longestTaskMs <= 100, `1M: longest main-thread task ${report.heavy.longestTaskMs} ms (limit 100)`);
      await shot('support-mode-1M.png');
    }
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    if (problems.length) throw new Error(`failed:\n- ${problems.join('\n- ')}`);
    console.log('\nP3.5 live generation smoke: all green');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (problems.length) console.error(['--- page problems ---', ...problems].join('\n'));
    try { await cdp?.close(); } catch { /* closing */ }
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
