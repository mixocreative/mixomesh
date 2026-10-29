// P6.2 adds: Ctrl held before / after / between the press, blur + pointercancel guard, colours, constant size, hidden in Support Mode (.tmp/p62).
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
      modifiers: mods, type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
    // Hover registers on a rendered frame of the utility layer; under load that can take
    // seconds on swiftshader. Poll the handles' isHovered instead of a fixed sleep.
    const anyHover = () => evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => { const p = ps.getGizmoManager().gizmos.positionGizmo; return [p.xGizmo, p.yGizmo, p.zGizmo, p.xPlaneGizmo, p.yPlaneGizmo, p.zPlaneGizmo].some(h => h.isHovered); })`);
    const hoverAt = async (x, y, md = 0) => {
      for (let i = 0; i < 40; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x) + (i % 2), y: Math.round(y), modifiers: md });
        await sleep(150);
        if (await anyHover()) return;
      }
      throw new Error(`no gizmo handle hovered at ${Math.round(x)},${Math.round(y)}`);
    };
    const drag = async (from, to) => {
      await hoverAt(from.x, from.y, mods);
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
    const key = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: type === 'keyDown' ? 2 : 0 });
    const snapped = async (order) => {
      const g2 = await evaluate(cdp, GEOM);
      const p0 = await pos();
      const from = g2.y, to = { x: g2.y.x + (g2.to.y.x - g2.o.x) * 2.5 + 3, y: g2.y.y + (g2.to.y.y - g2.o.y) * 2.5 + 2 };
      const m = (t, x, y, md) => cdp.send('Input.dispatchMouseEvent', { modifiers: md, type: t, x: Math.round(x), y: Math.round(y), button: 'left', buttons: t === 'mouseReleased' ? 0 : 1, clickCount: t === 'mouseMoved' ? 0 : 1 });
      const ctrlFirst = order === 'before';
      if (ctrlFirst) { await key('keyDown'); mods = 2; }
      await hoverAt(from.x, from.y, mods);
      if (order === 'between') { await key('keyDown'); mods = 2; await sleep(200); }
      await m('mousePressed', from.x, from.y, mods);
      if (!ctrlFirst) { await sleep(100); await key('keyDown'); mods = 2; }
      await m('mouseMoved', from.x, from.y, mods); await sleep(100);
      for (let i = 1; i <= 12; i++) { await m('mouseMoved', from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12, mods); await sleep(30);  }
      await m('mouseReleased', to.x, to.y, mods);
      await key('keyUp'); mods = 0;
      await sleep(250);
      const d = dist(await pos(), p0);
      const off = v => Math.abs(v / 5 - Math.round(v / 5)) * 5;
      assert.ok(Math.abs(d[0]) >= 4.99 && Math.abs(d[2]) >= 4.99, `Ctrl ${order} press: handle grabbed and moved (${d})`);
      assert.ok(off(d[0]) < 0.01 && off(d[2]) < 0.01, `Ctrl ${order} press: delta on 5 mm grid (${d.map(v => v.toFixed(3))})`);
      assert.ok(Math.abs(d[1]) < 1e-3, `Ctrl ${order} press: third axis kept`);
      await undo(); await sleep(300);
      results.push(`snap Ctrl-${order}-press XZ d=[${d.map(v => v.toFixed(2))}] mm on the 5 mm grid`);
    };
    await snapped('before');
    await snapped('after');
    await snapped('between');

    // ---- P6.2 ---------------------------------------------------------------
    mkdirSync(join(ROOT, '.tmp/p62'), { recursive: true });
    const camAttached = () => evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => !!ps.getGizmoManager().gizmos.positionGizmo.gizmoLayer.originalScene.activeCamera.inputs.attachedToElement)`);
    const stDrags = () => evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => { const p = ps.getGizmoManager().gizmos.positionGizmo; return [p.xGizmo, p.yGizmo, p.zGizmo, p.xPlaneGizmo, p.yPlaneGizmo, p.zPlaneGizmo].filter(h => h.dragBehavior.dragging).length; })`);
    assert.equal(await camAttached(), true, 'camera controls attached at rest');

    // Interrupted drags: window blur and canvas pointercancel mid-drag.
    for (const how of ['blur', 'pointercancel']) {
      const g2 = await evaluate(cdp, GEOM);
      const p0 = await pos(); const h0 = await hist();
      const dx = g2.xArrow.x - g2.o.x, dy = g2.xArrow.y - g2.o.y;
      await hoverAt(g2.xArrow.x, g2.xArrow.y);
      await mouse('mousePressed', g2.xArrow.x, g2.xArrow.y);
      for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', g2.xArrow.x + dx * 0.25 * i, g2.xArrow.y + dy * 0.25 * i); await sleep(30); }
      assert.equal(await stDrags(), 1, `${how}: a handle is dragging before the interruption`);
      assert.equal(await camAttached(), false, `${how}: orbit is OFF during the handle drag`);
      await evaluate(cdp, how === 'blur'
        ? `window.dispatchEvent(new Event('blur'))`
        : `document.querySelector('canvas').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))`);
      await sleep(200);
      assert.equal(await stDrags(), 0, `${how}: no stuck drag`);
      assert.equal(await camAttached(), true, `${how}: camera controls restored`);
      const p1 = await pos();
      const moved = dist(p1, p0);
      assert.ok(Math.abs(moved[0]) > 0.5 && Math.abs(moved[1]) < 1e-3, `${how}: object kept the in-progress move (${moved})`);
      assert.ok(await hist() !== h0, `${how}: drag committed as one undo step`);
      await mouse('mouseMoved', g2.xArrow.x + dx * 3, g2.xArrow.y + dy * 3); await sleep(150);
      await mouse('mouseReleased', g2.xArrow.x + dx * 3, g2.xArrow.y + dy * 3); await sleep(250);
      assert.ok(Math.hypot(...dist(await pos(), p1)) < 1e-3, `${how}: later mouse moves do not drag the released handle`);
      await undo(); await sleep(300);
      assert.ok(Math.hypot(...dist(await pos(), p0)) < 1e-3, `${how}: ONE undo restores`);
      assert.equal(await hist(), h0, `${how}: stack back to its pre-drag top`);
      results.push(`${how} mid-drag: camera restored, no stuck drag, 1 undo step`);
    }

    // Colours: X/Y/Z hues from the tokens; plane squares semi-transparent.
    const look = await evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => {
      const p = ps.getGizmoManager().gizmos.positionGizmo; const hex = c => c.toHexString();
      return { ax: ['x','y','z'].map(k => hex(p[k + 'Gizmo'].coloredMaterial.diffuseColor)), hv: ['x','y','z'].map(k => hex(p[k + 'Gizmo'].hoverMaterial.diffuseColor)),
        pl: ['x','y','z'].map(k => hex(p[k + 'PlaneGizmo'].coloredMaterial.diffuseColor)), al: ['x','y','z'].map(k => p[k + 'PlaneGizmo'].coloredMaterial.alpha),
        hal: ['x','y','z'].map(k => p[k + 'PlaneGizmo'].hoverMaterial.alpha) }; })`);
    const want = ['#7F0019', '#4A6B3A', '#2C476A'];
    assert.deepEqual(look.ax.map(s => s.toUpperCase()), want, 'axis colours from tokens');
    assert.deepEqual(look.pl.map(s => s.toUpperCase()), want, 'plane squares share the axis hues');
    assert.ok(look.al.every(a => a > 0.2 && a < 0.7) && look.hal.every((a, i) => a > look.al[i]), `planes semi-transparent (${look.al}) and firmer on hover`);
    assert.notDeepEqual(look.hv, look.ax, 'hover colour differs from rest');
    results.push(`colours ${look.ax} hover ${look.hv} plane alpha ${look.al[0]}/${look.hal[0]}`);

    // Constant screen size: dolly the camera, gizmo arrow length in pixels stays put.
    const arrowPx = async () => { const g2 = await evaluate(cdp, GEOM); return Math.hypot(g2.xArrow.x - g2.o.x, g2.xArrow.y - g2.o.y); };
    const a0 = await arrowPx();
    await evaluate(cdp, `import('/src/core/SceneManager.js').then(sm => { const c = sm.SceneManager.getScene().activeCamera; c.radius *= 1.8; })`);
    await sleep(500);
    const a1 = await arrowPx();
    assert.ok(Math.abs(a1 - a0) / a0 < 0.05, `gizmo keeps its screen size (${a0.toFixed(1)} px vs ${a1.toFixed(1)} px after a 1.8x dolly)`);
    results.push(`constant screen size ${a0.toFixed(1)} px -> ${a1.toFixed(1)} px after 1.8x dolly`);
    await evaluate(cdp, `import('/src/core/SceneManager.js').then(sm => { const c = sm.SceneManager.getScene().activeCamera; c.radius /= 1.8; })`);
    await sleep(400);
    writeFileSync(join(ROOT, '.tmp/p62/gizmo-look.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    // Hidden in Support Mode, back on exit.
    const attached = () => evaluate(cdp, `import('/src/core/scene/PivotSession.js').then(ps => !!ps.getGizmoManager().attachedMesh)`);
    assert.equal(await attached(), true, 'gizmo attached before Support Mode');
    assert.equal(await evaluate(cdp, `import('/src/supports/SupportMode.ts').then(m => m.supportMode.enter())`), true, 'Support Mode entered');
    await sleep(300);
    assert.equal(await attached(), false, 'gizmo hidden (detached) in Support Mode');
    writeFileSync(join(ROOT, '.tmp/p62/gizmo-hidden-support-mode.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate(cdp, `import('/src/supports/SupportMode.ts').then(m => m.supportMode.exit())`);
    await sleep(300);
    assert.equal(await attached(), true, 'gizmo back after leaving Support Mode');
    results.push('gizmo hidden in Support Mode, restored on exit');
    console.log('PASS browser-gizmo-smoke\n  ' + results.join('\n  '));
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
