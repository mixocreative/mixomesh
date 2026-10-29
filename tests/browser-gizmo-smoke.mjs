// P6.1: move-gizmo plane handles. Real CDP pointer drags on each plane square
// (XY / YZ / XZ) must change only that plane's two axes, undo in ONE step, and
// land on the snap grid with Ctrl-snap. An axis-arrow drag must still work.
//   node tests/browser-gizmo-smoke.mjs   (screenshot -> .tmp/p61/gizmo-planes.png)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#ol-list')`;

const PREP = `(async () => {
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const sm = await import('/src/core/SceneManager.js');
  const sel = await import('/src/core/Selection.js');
  const st = await import('/src/core/StateManager.js');
  const obj = 'o Box\\nv -0.02 -0.02 -0.02\\nv 0.02 -0.02 -0.02\\nv 0.02 0.02 -0.02\\nv -0.02 0.02 -0.02\\nv -0.02 -0.02 0.02\\nv 0.02 -0.02 0.02\\nv 0.02 0.02 0.02\\nv -0.02 0.02 0.02\\n'
    + 'f 1 3 2\\nf 1 4 3\\nf 5 6 7\\nf 5 7 8\\nf 1 2 6\\nf 1 6 5\\nf 2 3 7\\nf 2 7 6\\nf 3 4 8\\nf 3 8 7\\nf 4 1 5\\nf 4 5 8\\n';
  await AssetLoader.loadFromBlob(new Blob([obj]), 'box.obj');
  const id = Object.keys(st.getState().scene.objects)[0];
  sel.Selection.set([id], id);
  sm.SceneManager.setGizmoMode('translate');
  sm.SceneManager.frameAll?.();
  await new Promise(r => setTimeout(r, 800));
  const scene = sm.SceneManager.getScene();
  const mesh = scene.meshes.find(m => m.metadata?.meshId === id);
  window.__pos = () => { mesh.computeWorldMatrix(true); return mesh.getAbsolutePosition().asArray().map(n => n * 1000); };
  window.__hist = async () => (await import('/src/core/HistoryManager.js')).getUndoLabel();
  return id;
})()`;

// Screen points: plane square centres, drag targets (mm offsets from the pivot).
const GEOM = `(async () => {
  const B = window.BABYLON;
  const sm = await import('/src/core/SceneManager.js');
  const ps = await import('/src/core/scene/PivotSession.js');
  const scene = sm.SceneManager.getScene();
  const engine = scene.getEngine();
  const rect = engine.getRenderingCanvas().getBoundingClientRect();
  const cam = scene.activeCamera;
  const vp = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const proj = v => { const p = B.Vector3.Project(v, B.Matrix.Identity(), scene.getTransformMatrix(), vp);
    return { x: rect.left + p.x * rect.width / engine.getRenderWidth(), y: rect.top + p.y * rect.height / engine.getRenderHeight() }; };
  const pg = ps.getGizmoManager().gizmos.positionGizmo;
  const o = ps.getPivotNode().getAbsolutePosition();
  const centre = g => { g._rootMesh.computeWorldMatrix(true);
    const ms = g._gizmoMesh.getChildMeshes(false); ms.forEach(m => m.computeWorldMatrix(true));
    const c = ms.reduce((a, m) => a.add(m.getBoundingInfo().boundingBox.centerWorld), B.Vector3.Zero()).scale(1 / ms.length);
    return proj(c); };
  const at = (mx, my, mz) => proj(o.add(new B.Vector3(mx / 1000, my / 1000, mz / 1000)));
  return { x: centre(pg.xPlaneGizmo), y: centre(pg.yPlaneGizmo), z: centre(pg.zPlaneGizmo),
    planar: pg.planarGizmoEnabled, o: proj(o),
    to: { x: at(0, 6, 6), y: at(6, 0, 6), z: at(6, 6, 0) },
    xArrow: centre(pg.xGizmo) };
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-gizmo-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, BOOTED), 90000, "boot");
    await evaluate(cdp, PREP);

    let mods = 0;   // CDP modifier bitmask (2 = Ctrl)
    const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
      modifiers: type === 'mousePressed' ? 0 : mods, type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
    const drag = async (from, to) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x) - 6, y: Math.round(from.y) - 6 });
      await sleep(200);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x), y: Math.round(from.y) });
      await sleep(500);   // let the utility layer register the hover before pressing
      await mouse('mousePressed', from.x, from.y);
      await mouse('mouseMoved', from.x, from.y);   // carries the Ctrl modifier: snap engages with zero accumulated delta
      await sleep(100);
      for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12); await sleep(30); }
      await mouse('mouseReleased', to.x, to.y);
      await sleep(250);
    };
    const pos = () => evaluate(cdp, 'window.__pos()');
    const hist = () => evaluate(cdp, 'window.__hist()');
    const undo = () => evaluate(cdp, `import('/src/core/HistoryManager.js').then(h => h.undo())`);
    const dist = (a, b) => a.map((v, i) => v - b[i]);

    const g = await evaluate(cdp, GEOM);
    assert.equal(g.planar, true, 'planarGizmoEnabled is on');
    mkdirSync(join(ROOT, '.tmp/p61'), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, '.tmp/p61/gizmo-planes.png'), Buffer.from(shot.data, 'base64'));

    // The default gizmo is ~40 px: squares crowd the origin. Enlarge it (same path as touch sizing)
    // so each square is individually hittable by a real pointer.
    await evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => { ps.getGizmoManager().gizmos.positionGizmo.scaleRatio = 3; })`);
    await sleep(400);
    writeFileSync(join(ROOT, '.tmp/p61/gizmo-planes-large.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    const planes = [
      { name: 'YZ (x-plane)', key: 'x', changed: [1, 2], fixed: 0 },
      { name: 'XZ (y-plane)', key: 'y', changed: [0, 2], fixed: 1 },
      { name: 'XY (z-plane)', key: 'z', changed: [0, 1], fixed: 2 },
    ];
    const results = [];
    for (const p of planes) {
      const g2 = await evaluate(cdp, GEOM);
      const p0 = await pos(); const h0 = await hist();
      const st0 = g2[p.key], tv = g2.to[p.key];
      await drag(st0, { x: st0.x + tv.x - g2.o.x, y: st0.y + tv.y - g2.o.y });
      const p1 = await pos(); const h1 = await hist();
      const d = dist(p1, p0);
      assert.ok(Math.abs(d[p.fixed]) < 1e-3, `${p.name}: fixed axis moved ${d[p.fixed]} mm`);
      for (const a of p.changed) assert.ok(Math.abs(d[a]) > 2, `${p.name}: axis ${a} did not move (d=${d.map(v => v.toFixed(2))} from ${JSON.stringify(g2[p.key])} to ${JSON.stringify(g2.to[p.key])})`);
      assert.ok(h1 && h1 !== h0 || h0 === null, `${p.name}: drag pushed an undo entry (${h0} -> ${h1})`);
      await undo();
      await sleep(400);
      const p2 = await pos();
      if (process.env.GIZMO_DEBUG) console.error(p.name, 'h0', h0, 'h1', h1, 'p0', p0, 'p1', p1, 'p2', p2, 'h2', await hist());
      assert.ok(Math.hypot(...dist(p2, p0)) < 1e-3, `${p.name}: one undo restores position`);
      assert.equal(await hist(), h0, `${p.name}: ONE undo returns the stack to its pre-drag top`);
      results.push(`${p.name} d=[${d.map(v => v.toFixed(1))}] mm, 1 undo step`);
    }

    // Axis arrow still works: scan along the +X screen direction for the shaft.
    {
      const g2 = await evaluate(cdp, GEOM);
      const p0 = await pos(); const h0 = await hist();
      const dx = g2.xArrow.x - g2.o.x, dy = g2.xArrow.y - g2.o.y;
      await drag(g2.xArrow, { x: g2.xArrow.x + dx * 1.5, y: g2.xArrow.y + dy * 1.5 });
      const moved = dist(await pos(), p0);
      assert.ok(Math.abs(moved[0]) > 1, `axis X drag moved the object (${moved})`);
      assert.ok(Math.abs(moved[1]) < 1e-3 && Math.abs(moved[2]) < 1e-3, `axis drag stayed on X (${moved})`);
      assert.ok(await hist(), 'axis drag pushed an undo entry');
      await undo();
      assert.ok(Math.hypot(...dist(await pos(), p0)) < 1e-3, 'axis undo restores');
      assert.equal(await hist(), h0, 'axis: ONE undo returns the stack to its pre-drag top');
      results.push(`axis X d=${moved[0].toFixed(1)} mm, 1 undo step`);
    }

    // Snap: Ctrl-snap with a 5 mm grid; plane delta lands on multiples of 5.
    await evaluate(cdp, `(async () => {
      const st = await import('/src/core/StateManager.js');
      st.setState(s => ({ ...s, gizmo: { ...s.gizmo, snap: { ...s.gizmo.snap, translate: 5 } } }), { silent: true });
      })()`);
    await sleep(600);
    mods = 2;   // Ctrl held from just after the press (Ctrl+press itself does not grab a handle): InputManager drives setGizmoSnap from the pointer modifiers
    {
      const g2 = await evaluate(cdp, GEOM);
      const p0 = await pos();
      await drag(g2.y, { x: g2.y.x + (g2.to.y.x - g2.o.x) * 2.5 + 3, y: g2.y.y + (g2.to.y.y - g2.o.y) * 2.5 + 2 });
      const d = dist(await pos(), p0);
      if (process.env.GIZMO_DEBUG) console.error('snapdbg', d, await evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => ({ on: ps.isGizmoSnapOn(), sd: ps.getGizmoManager().gizmos.positionGizmo.snapDistance, psd: ps.getGizmoManager().gizmos.positionGizmo.yPlaneGizmo.snapDistance, att: !!ps.getPivotNode() }))`));
      const off = v => Math.abs(v / 5 - Math.round(v / 5)) * 5;
      assert.ok(Math.abs(d[0]) >= 4.99 && Math.abs(d[2]) >= 4.99, `snapped plane drag moved (${d})`);
      assert.ok(off(d[0]) < 0.01 && off(d[2]) < 0.01, `snapped delta on 5 mm grid (${d.map(v => v.toFixed(3))})`);
      assert.ok(Math.abs(d[1]) < 1e-3, 'snapped plane drag kept third axis');
      results.push(`snap XZ d=[${d.map(v => v.toFixed(2))}] mm on the 5 mm grid`);
    }
    console.log('PASS browser-gizmo-smoke\n  ' + results.join('\n  '));
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
