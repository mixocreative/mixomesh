// Support Mode walk (plan 2026-10-29 P3.6): the generic scenarios of mixoDental's scripts/walk.mjs,
// rewritten for mixomesh on a procedural torus (110 automatic tips), plus the P3.5 gaps. Everything
// goes through real pointer / key events and the real panel buttons; page-side state is only READ
// (support record, caches, layers) to judge the outcome.
//
//   a1 generate        a2 Drag over (Select / Unselect strokes, repeatable)   a3 Delete key   a4 Undo
//   a5 Drag over from Bottom view
//   c  zone paint: the supports in the zone leave the build; the REAL export (P4.2: supports-only STL
//      through the export pipeline, engine export build) carries exactly the drawn contacts
//   d  Delete after the zone: the cached build equals the drawn mesh, and the real export again
//      carries exactly the drawn contacts (the deleted ones gone)
//   e  remove then add at one spot keeps the manual support; Undo / Redo walk both steps
//   f1-f4 per-support settings: customise the selection, default change leaves them, Reset, Undo
//   g  Select -> Unselect in the middle of one stroke == the steps one after the other (CPU throttled)
//   gaps: (b) stale on entry, (c) Add before the first Generate, (d) no orphan raft after Delete all,
//         (e) Show / Fix / re-check, (f) the 20 s worker respawn with a slow job (test hook)
//   screenshots of the end states: .tmp/p36/
//
//   node tests/browser-supports-walk.mjs [--swiftshader]

import { join } from 'node:path';
import { bootSupportApp, writeTorus, ROOT, sleep, waitFor } from './support-browser-kit.mjs';

const OUT = join(ROOT, '.tmp/p36');
const SWIFT = process.argv.includes('--swiftshader');
const results = [];
const failures = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`;
  console.log(line);
  results.push(line);
  if (!ok) failures.push(name);
};

const app = await bootSupportApp({ swiftshader: SWIFT });
const { run, w } = app;
const torus = writeTorus('p36');
let id;
const J = JSON.stringify;
const counts = () => w(`counts(${J(id)})`);
const drawn = () => w(`drawn(${J(id)})`);
const rec = () => w(`rec(${J(id)})`);
const settle = async () => { await waitFor(() => w(`idle(${J(id)})`), 120000, 'idle'); };
const selection = () => w('selection()');
const send = (event) => w(`send(${J(event)})`);
const shot = (name) => app.shot(OUT, name);
const stats = () => w('stats()');
const verdict = () => run(`window.__w.m.ui.supportUi.get().verdicts[${J(id)}] ?? null`);
/**
 * The real export (P4.2): supports only, STL, through PrintManager.collectExportFiles (the save
 * path's writers); returns the facet count read from the file and the contacts its build carried.
 */
const realExport = () => run(`(async () => {
  const { PrintManager } = await import('/src/core/PrintManager.js');
  const r = await PrintManager.collectExportFiles(['stl'], { acknowledgeWarnings: true, includeSupports: 'supportsOnly' });
  if (r.blocked) return { blocked: r.code, issues: r.readinessIssues.map(i => i.code) };
  const bytes = r.files[0].bytes;
  const last = window.__mxSupportLive.exportStats.last[window.__walkId];
  return { facets: new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true), contactIds: last?.contactIds ?? [], tris: last?.tris ?? -1 };
})()`);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A fresh torus, Support Mode open, Bottom view (supports hang in front of the model there). */
async function fresh({ generate = true } = {}) {
  id = await run(`window.__w.load(${J(torus)}, 'torus.stl')`);
  await run(`window.__w.m.mode.supportMode.enter()`);
  await sleep(600);
  await run(`window.__w.m.ui.handlers.setBottomView(true)`);
  await sleep(2500);
  if (generate) {
    check('Generate supports button is on and works from the panel', await app.pressButton('Generate supports'));
    await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1`), 90000, 'first generation');
    await settle();
  }
}

/** Screen points that cross the ring: horizontal lines through the model box. */
async function strokeLines() {
  const b = await w(`box(${J(id)})`);
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, h = b.bottom - b.top, wd = b.right - b.left;
  return {
    mid: [[cx - wd * 0.36, cy], [cx + wd * 0.36, cy]],
    upper: [[cx - wd * 0.26, cy - h * 0.25], [cx + wd * 0.26, cy - h * 0.25]],
    lower: [[cx - wd * 0.26, cy + h * 0.25], [cx + wd * 0.26, cy + h * 0.25]],
    cx, cy,
  };
}
const dragMode = async (brush, radius = 40) => {
  await send({ type: 'setTool', tool: 'select' });
  await send({ type: 'setSelectStyle', style: 'brush' });
  await send({ type: 'setBrushMode', mode: brush });
  await send({ type: 'setBrushRadius', radius });
};

try {
  // ───────── a1: generate ─────────
  await fresh();
  const a1 = await counts();
  const d1 = await drawn();
  const v1 = await verdict();
  check('a1 generate: automatic tips are placed and drawn',
    a1.auto >= 60 && a1.manual === 0 && a1.removed === 0 && d1.enabled && d1.contactIds.length === a1.auto - (v1?.dropped ?? 0),
    `auto ${a1.auto}, drawn tips ${d1.contactIds.length}, dropped by the build ${v1?.dropped}, triangles ${d1.tris}`);
  check('a1 the drawn mesh is what the cache (an export) holds', d1.revisionMatches && d1.tris === d1.cachedTris && d1.tris > 0 && !d1.stale, `drawn ${d1.tris}, cached ${d1.cachedTris}`);
  await shot('a1-generated.png');

  // ───────── a2: Drag over ─────────
  const L = await strokeLines();
  await dragMode('select');
  const sequence = async () => {
    await send({ type: 'clearSelection' });
    await send({ type: 'setBrushMode', mode: 'select' });
    const out = [];
    await app.stroke(L.mid, { steps: 8 });
    out.push((await selection()).length);
    await app.stroke(L.upper, { steps: 8 });
    out.push((await selection()).length);
    await send({ type: 'setBrushMode', mode: 'unselect' });
    await app.stroke([[L.cx - 40, L.cy - 5], [L.cx + 40, L.cy - 5]], { steps: 6 });
    out.push((await selection()).length);
    return out;
  };
  const first = await sequence();
  check('a2 Drag over: Select grows the selection, Unselect takes some away', first[0] > 0 && first[1] > first[0] && first[2] < first[1], `selected ${first.join(', ')}`);
  const again = await sequence();
  check('a2 the same strokes select the same counts again (repeatable)', again.join() === first.join(), `first ${first.join(', ')}, again ${again.join(', ')}`);
  const sel3 = await selection();
  const selUi = await run(`document.querySelector('.sp-count')?.textContent ?? ''`);
  check('a2 the panel shows how many are selected', new RegExp(`\\b${sel3.length}\\b`).test(selUi), `panel "${selUi}", selection ${sel3.length}`);
  await shot('a2-selected.png');

  // ───────── a3: Delete / a4: Undo ─────────
  const before3 = await counts();
  await app.key('Delete');
  await settle();
  const after3 = await counts();
  const r3 = await rec();
  check('a3 Delete removes exactly the selection (key, one undo step)',
    after3.removed === before3.removed + sel3.length && after3.auto === before3.auto - sel3.length && (await selection()).length === 0,
    `removed ${after3.removed} of ${sel3.length} selected, auto ${before3.auto} -> ${after3.auto}`);
  const d3 = await drawn();
  check('a3 the removed supports are gone from the drawn build', sel3.every((cid) => !d3.contactIds.includes(cid)) && d3.tris === d3.cachedTris, `drawn tips ${d3.contactIds.length}, triangles ${d3.tris}/${d3.cachedTris}`);
  void r3;
  await app.key('z', { ctrl: true });
  await settle();
  const after4 = await counts();
  const d4 = await drawn();
  check('a4 Undo brings them back, drawn again', after4.removed === before3.removed && after4.auto === before3.auto && sel3.every((cid) => d4.contactIds.includes(cid)), `removed ${after4.removed}, auto ${after4.auto}`);
  await shot('a4-undone.png');

  // ───────── c / d: zone paint, then Delete: drawn == export input ─────────
  const dBefore = await drawn();
  await check('c opens the support area tool', await app.pressButton('Support area'));
  await sleep(300);
  const beforeStamps = (await counts()).stamps;
  for (const deg of [150, 165, 180, 195, 210]) {
    const p = await w(`ringBottom(${J(id)}, ${deg})`);
    const q = await w(`ringBottom(${J(id)}, ${deg + 12})`);
    await app.stroke([p, q], { steps: 8 });
  }
  await settle();
  const zoned = await counts();
  const dZone = await drawn();
  const removedByZone = dBefore.contactIds.filter((cid) => !dZone.contactIds.includes(cid));
  check('c zone paint: stamps landed and the supports in the zone left the build',
    zoned.stamps > beforeStamps && removedByZone.length > 0 && dZone.contactIds.length === dBefore.contactIds.length - removedByZone.length && dZone.tris < dBefore.tris,
    `stamps ${beforeStamps} -> ${zoned.stamps}, tips drawn ${dBefore.contactIds.length} -> ${dZone.contactIds.length}, triangles ${dBefore.tris} -> ${dZone.tris}`);
  check('c the screen and the cache agree after the zone', dZone.tris === dZone.cachedTris && dZone.revisionMatches, `drawn ${dZone.tris}, cached ${dZone.cachedTris}`);
  await run(`window.__walkId = ${J(id)}; true`);
  const xZone = await realExport();
  check('c the real export carries exactly the drawn contacts (zone supports gone), file = export build',
    !xZone.blocked && sameSet(xZone.contactIds, dZone.contactIds) && removedByZone.every((cid) => !xZone.contactIds.includes(cid)) && xZone.facets === xZone.tris,
    `drawn ${dZone.contactIds.length}, exported ${xZone.contactIds?.length}, file facets ${xZone.facets} / build ${xZone.tris}, drawn triangles ${dZone.tris} ${xZone.blocked ? JSON.stringify(xZone) : ''}`);
  await send({ type: 'exit' });
  await send({ type: 'enterEdit' });
  await dragMode('select');
  await app.stroke(L.lower, { steps: 8 });
  const forDelete = await selection();
  await app.key('Delete');
  await settle();
  const dDel = await drawn();
  check('d export input after zone + Delete matches the build on screen',
    forDelete.length > 0 && dDel.tris === dDel.cachedTris && dDel.tris === dDel.builtTris && forDelete.every((cid) => !dDel.contactIds.includes(cid)),
    `drawn ${dDel.tris}, cached ${dDel.cachedTris}, built ${dDel.builtTris}, deleted ${forDelete.length}`);
  const xDel = await realExport();
  check('d the real export after zone + Delete carries exactly the drawn contacts, file = export build',
    !xDel.blocked && sameSet(xDel.contactIds, dDel.contactIds) && forDelete.every((cid) => !xDel.contactIds.includes(cid)) && xDel.facets === xDel.tris,
    `drawn ${dDel.contactIds.length}, exported ${xDel.contactIds?.length}, file facets ${xDel.facets} / build ${xDel.tris}, drawn triangles ${dDel.tris} ${xDel.blocked ? JSON.stringify(xDel) : ''}`);
  await shot('d-zone-delete.png');
  await app.key('z', { ctrl: true });
  await settle();
  const d2 = await counts();
  check('d2 Undo after the delete brings the deleted supports back', d2.removed === 0, `removed ${d2.removed}`);
  // back to the start: undo the five zone strokes (one step each)
  let undone = 0;
  while ((await counts()).stamps > beforeStamps && undone < 8) { await app.key('z', { ctrl: true }); await settle(); undone++; }
  check('d2 Undo walks the zone strokes back, one step each', (await counts()).stamps === beforeStamps && undone === 5, `stamps ${(await counts()).stamps}, steps ${undone}`);

  // ───────── e: remove, then add at the same spot ─────────
  await send({ type: 'clearSelection' });
  await send({ type: 'setTool', tool: 'add' });
  await send({ type: 'setAddAction', action: 'add' });
  const base = await counts();
  const feet = await w(`feet(${J(id)})`);
  const contacts = await w(`contacts(${J(id)})`);
  const foot = feet[Math.floor(feet.length / 3)];
  const tip = contacts.find((c) => c.id === foot.id);
  await app.hover(foot.x, foot.y);
  await sleep(300);
  await app.click(foot.x, foot.y, 'right');
  await settle();
  const removed = await counts();
  check('e right-click on a support removes it', removed.removed === base.removed + 1 && removed.auto === base.auto - 1, `removed ${base.removed} -> ${removed.removed}`);
  await app.hover(tip.x, tip.y);
  await sleep(300);
  await app.click(tip.x, tip.y);
  await settle();
  const added = await counts();
  // Add snaps onto a shown tip within Click reach and removes that one (planAddTip), so removed may grow by one.
  check('e remove then add at the same spot keeps the manual support and the removal',
    added.manual === 1 && (added.removed === removed.removed || added.removed === removed.removed + 1) && (await rec()).deleted.includes(foot.id),
    `manual ${added.manual}, removed ${removed.removed} -> ${added.removed}`);
  const dAdd = await drawn();
  check('e the manual support is drawn', dAdd.contactIds.some((cid) => cid.startsWith('manual-')), `tips ${dAdd.contactIds.length}`);
  const step = async () => { await settle(); return counts(); };
  await app.key('z', { ctrl: true });
  const undoAdd = await step();
  await app.key('z', { ctrl: true });
  const undoRemove = await step();
  await app.key('z', { ctrl: true, shift: true });
  const redoRemove = await step();
  await app.key('z', { ctrl: true, shift: true });
  const redoAdd = await step();
  check('e Undo and Redo walk both steps',
    undoAdd.manual === 0 && undoAdd.removed === removed.removed && undoRemove.removed === base.removed && redoRemove.removed === removed.removed && redoRemove.manual === 0 && redoAdd.manual === 1 && redoAdd.removed === added.removed,
    `undo add ${undoAdd.manual}/${undoAdd.removed}, undo remove ${undoRemove.manual}/${undoRemove.removed}, redo remove ${redoRemove.manual}/${redoRemove.removed}, redo add ${redoAdd.manual}/${redoAdd.removed} (manual/removed)`);
  await shot('e-remove-add.png');
  // clean: take the two steps back
  await app.key('z', { ctrl: true }); await settle();
  await app.key('z', { ctrl: true }); await settle();

  // ───────── f1-f4: per-support settings ─────────
  await dragMode('select');
  await send({ type: 'clearSelection' });
  await app.stroke(L.mid, { steps: 8 });
  const chosen = await selection();
  const defaults = (await rec()).settings.pointDiameter;
  check('f1 typing a Contact diameter on the selection', await app.typeField('Contact diameter', '0.6'));
  await settle();
  const custom = await counts();
  const r1 = await rec();
  check('f1 Contact diameter on the selection customises exactly those', custom.customised === chosen.length && r1.settings.pointDiameter === defaults, `selected ${chosen.length}, customised ${custom.customised}, object default ${r1.settings.pointDiameter}`);
  await send({ type: 'clearSelection' });
  check('f2 typing a new default with nothing selected', await app.typeField('Contact diameter', '0.35'));
  await settle();
  const changed = await counts();
  const r2 = await rec();
  check('f2 changing the default leaves them customised', changed.customised === chosen.length && r2.settings.pointDiameter === 0.35, `customised ${changed.customised}, default ${r2.settings.pointDiameter}`);
  check('f2 Select customised picks exactly them', await app.pressButton('Select customised'));
  await sleep(200);
  const picked = await selection();
  check('f2 the customised supports are the selection', picked.length === chosen.length && picked.every((cid) => chosen.includes(cid)), `selected ${picked.length} of ${chosen.length}`);
  check('f3 Reset on the selection', await app.pressButton('Reset'));
  await settle();
  check('f3 Reset clears them', (await counts()).customised === 0, `customised ${(await counts()).customised}`);
  await app.key('z', { ctrl: true });
  await settle();
  check('f4 Undo brings them back', (await counts()).customised === chosen.length, `customised ${(await counts()).customised}`);
  await shot('f-per-support.png');
  // back to the plain state for g
  for (let k = 0; k < 2; k++) { await app.key('z', { ctrl: true }); await settle(); } // the default change, then the override
  await send({ type: 'clearSelection' });
  const plain = await counts();
  check('f the settings are back to plain before g', plain.customised === 0 && (await rec()).settings.pointDiameter === defaults && plain.auto >= 60, `customised ${plain.customised}, point diameter ${(await rec()).settings.pointDiameter}, auto ${plain.auto}`);

  // ───────── g: Select to Unselect in the middle of one stroke ─────────
  await dragMode('select', 36);
  const A = [L.mid[0], L.mid[1]];
  const B = [[L.cx + 120, L.cy - 90], [L.cx - 30, L.cy + 60]];
  await send({ type: 'clearSelection' });
  await app.stroke(A, { steps: 8 });
  await send({ type: 'setBrushMode', mode: 'unselect' });
  await app.stroke([A[1], B[0], B[1]], { steps: 8 });
  const sequential = (await selection()).sort();
  await send({ type: 'clearSelection' });
  await send({ type: 'setBrushMode', mode: 'select' });
  const cdp = app.cdp;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await app.stroke([A[0], A[1], B[0], B[1]], { steps: 8, during: async (i) => { if (i === 0) await send({ type: 'setBrushMode', mode: 'unselect' }); } });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const midway = (await selection()).sort();
  check('g Select to Unselect mid-stroke equals the steps one after the other (CPU throttled x4)',
    midway.length > 0 && J(midway) === J(sequential), `one after the other ${sequential.length}, switched mid-stroke ${midway.length}`);
  await send({ type: 'clearSelection' });
  await shot('g-mid-stroke.png');

  // ───────── a5: Drag over from Bottom view ─────────
  await dragMode('select');
  const beta = await run(`window.__w.m.sm.SceneManager.getCamera().beta`);
  await app.stroke(L.mid, { steps: 8 });
  const fromBelow = await selection();
  check('a5 Drag over from Bottom view selects', beta > 2.5 && fromBelow.length > 0, `camera beta ${beta.toFixed(2)}, selected ${fromBelow.length}`);
  await shot('a5-bottom-view.png');
  await send({ type: 'clearSelection' });

  // ───────── gap (d): no orphan raft after Delete all ─────────
  {
    const all = await run(`window.__w.m.data.liveContactIds(${J(id)}, window.__w.rec(${J(id)}))`);
    check('gap d: there are supports to delete', all.length >= 60, `${all.length} on show`);
    await run(`window.__w.m.data.commitDelete(${J(id)}, ${J(all)}); true`);
    await sleep(800);
    await settle();
    const c = await counts();
    const dd = await drawn();
    check('gap d: Delete every support leaves no tip', c.auto === 0 && c.manual === 0, `auto ${c.auto}, manual ${c.manual}`);
    check('gap d: no orphan raft / base is drawn or in the cached build after Delete all', dd.tris === 0 && !dd.enabled && !dd.parts.includes('raft') && dd.cachedTris <= 0,
      `drawn triangles ${dd.tris} (enabled ${dd.enabled}), cached ${dd.cachedTris}, parts [${dd.parts}]`);
    await shot('gap-d-delete-all.png');
    await app.key('z', { ctrl: true });
    await settle();
  }

  // ───────── gap (c): Add before the first Generate ─────────
  await run(`window.__w.m.mode.supportMode.exit()`);
  await fresh({ generate: false });
  const idC = id;
  check('gap c: a new object has no build', (await rec()) === undefined || (await rec())?.sourceHash === null);
  await send({ type: 'setTool', tool: 'add' });
  const p0 = await w(`ringBottom(${J(id)}, 200)`);
  await app.hover(p0[0], p0[1]);
  await sleep(400);
  await app.click(p0[0], p0[1]);
  await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1`), 60000, 'build after the first Add');
  await settle();
  const gc = await counts();
  const dc = await drawn();
  check('gap c: a support added by hand before Generate starts the first build and is drawn',
    gc.manual === 1 && gc.auto > 0 && dc.enabled && dc.tris > 0 && dc.contactIds.some((cid) => cid.startsWith('manual-')) && !!(await rec()).sourceHash,
    `manual ${gc.manual}, auto ${gc.auto}, drawn tips ${dc.contactIds.length}, triangles ${dc.tris}`);
  await shot('gap-c-add-before-generate.png');
  void idC;

  // ───────── gap (b): stale on entry ─────────
  {
    // add hand work: one removed support (right-click) on the generated object, then leave and rotate it
    const cs = (await w(`contacts(${J(id)})`)).filter((c) => !c.manual && c.x !== null);
    await app.hover(cs[7].x, cs[7].y);
    await sleep(300);
    await app.click(cs[7].x, cs[7].y, 'right');
    await settle();
    const hand = await counts();
    await run(`window.__w.m.mode.supportMode.exit()`);
    await sleep(500);
    await run(`(() => { const { TransformCommand } = window.__w.t; const m = window.__w.m.al.AssetLoader.getBabylonMesh(${J(id)}); const prev = window.__w.t.captureWorld(m); const q = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 0, 1), 0.5); const cur = new BABYLON.Quaternion(prev.rotation.x, prev.rotation.y, prev.rotation.z, prev.rotation.w); const r = q.multiply(cur); const next = { position: prev.position, scaling: prev.scaling, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } }; window.__w.m.hist.HistoryManager.push(new TransformCommand({ [${J(id)}]: prev }, { [${J(id)}]: next })); return true; })()`);
    await sleep(500);
    const stale = (await rec()).stale;
    check('gap b: rotating the object outside the mode marks the supports stale', stale === 'pose', `stale ${stale}`);
    await run(`window.__w.m.mode.supportMode.enter()`);
    let greyed = false;
    for (let k = 0; k < 40; k++) {
      const d = await drawn();
      const note = await run(`!!document.querySelector('.sp-generate [role=note]')`);
      if (d.stale || note) greyed = true;
      if (!(await run(`window.__w.busy(${J(id)})`)) && k > 3) break;
      await sleep(100);
    }
    await settle();
    const after = await counts();
    const rAfter = await rec();
    const dAfter = await drawn();
    check('gap b: on entry the stale supports regenerate with the hand work rekeyed',
      !rAfter.stale && !dAfter.stale && after.manual === hand.manual && dAfter.enabled && dAfter.tris > 0,
      `stale ${rAfter.stale}, manual ${hand.manual} -> ${after.manual}, removed ${hand.removed} -> ${after.removed}, greyed seen ${greyed}`);
    await shot('gap-b-stale-regenerated.png');
  }

  // ───────── gap (e): Show / Fix / re-check ─────────
  {
    await run(`window.__w.m.ui.handlers.setBottomView(true)`);
    await sleep(800);
    const all = await run(`window.__w.m.data.liveContactIds(${J(id)}, window.__w.rec(${J(id)}))`);
    await run(`window.__w.m.data.commitDelete(${J(id)}, ${J(all.filter((_, i) => i % 4 !== 0))}); true`);
    await sleep(600);
    await settle();
    await send({ type: 'setTool', tool: 'select' });
    const problems = await run(`window.__w.m.ui.supportUi.get().problems.map(p => ({ kind: p.kind, position: p.position, area: p.area }))`);
    check('gap e: removing three quarters of the supports lists findings', problems.length > 0, `${problems.length} finding(s): ${[...new Set(problems.map((p) => p.kind))].join(', ')}`);
    await shot('gap-e-problems.png');
    const cam0 = await run(`window.__w.m.sm.SceneManager.getCamera().target.asArray()`);
    check('gap e: Show on the first finding', await app.pressButton('Show', '.sp-problems'));
    await sleep(900);
    const cam1 = await run(`window.__w.m.sm.SceneManager.getCamera().target.asArray()`);
    check('gap e: Show moved the camera', Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1e-5, `target ${cam0.map((x) => x.toFixed(2))} -> ${cam1.map((x) => x.toFixed(2))}`);
    const spot = problems.find((p) => p.kind === 'overhang') ?? problems[0];
    const before = await counts();
    check('gap e: Fix on the finding', await app.pressButton('Fix', '.sp-problems'));
    await sleep(900);
    const tool = await run(`(() => { const s = window.__w.m.sess.supportSession.get(); return s.mode + '/' + s.tool + '/' + s.addAction; })()`);
    check('gap e: Fix opens the Add tool with a click that adds', tool === 'edit/add/add', tool);
    const fixed = await run(`(async () => {
      const layers = await window.__w.m.layers.appSupportLayers();
      const om = window.__w.m.model.objectModel(${J(id)});
      const offset = window.__w.m.port.anchorOffset(om.anchor, window.__w.m.model.leadPosition(${J(id)}));
      const s = layers.port.worldToScreen(window.__w.m.port.supportToBabylon(${J(spot.position)}, om.anchor, offset));
      const r = document.querySelector('#renderCanvas').getBoundingClientRect();
      return s ? [s[0] + r.left, s[1] + r.top] : null; })()`);
    await app.hover(fixed[0], fixed[1]);
    await sleep(400);
    await app.click(fixed[0], fixed[1]);
    await settle();
    await sleep(600);
    const afterFix = await counts();
    const left = await run(`window.__w.m.ui.supportUi.get().problems.map(p => ({ kind: p.kind, position: p.position }))`);
    const near = left.filter((p) => Math.hypot(p.position[0] - spot.position[0], p.position[1] - spot.position[1], p.position[2] - spot.position[2]) < 0.5);
    check('gap e: Fix added a support and the finding is gone after the re-check',
      afterFix.manual === before.manual + 1 && near.length === 0 && left.length <= problems.length,
      `manual ${before.manual} -> ${afterFix.manual}, findings ${problems.length} -> ${left.length}, still at the spot ${near.length}`);
    await shot('gap-e-fixed.png');
  }

  // ───────── gap (f): the 20 s worker respawn ─────────
  {
    const s0 = await stats();
    await run(`window.__mxSupportLive.test.slowMs = 120000; true`);
    await run(`window.__mxSupportLive.request(${J(id)}, false, true); true`);
    await sleep(600);
    check('gap f: a slow job is running', await run(`window.__w.busy(${J(id)})`));
    const t0 = Date.now();
    // a newer request while the slow job runs; it must not start a second job until the first is ended
    await run(`window.__mxSupportLive.request(${J(id)}, false, true); true`);
    await run(`window.__mxSupportLive.test.slowMs = 0; true`);
    await waitFor(() => run(`window.__mxSupportLive.stats.respawns > ${s0.respawns}`), 40000, 'worker respawn');
    const waited = Date.now() - t0;
    await settle();
    const s1 = await stats();
    check('gap f: the slow job was ended by a respawn after about 20 s, not sooner', waited >= 17000 && waited <= 36000, `respawn after ${(waited / 1000).toFixed(1)} s`);
    check('gap f: the newer request ran and rendered', s1.respawns === s0.respawns + 1 && s1.rendered > s0.rendered && !(await run(`window.__w.busy(${J(id)})`)), `respawns ${s1.respawns - s0.respawns}, rendered +${s1.rendered - s0.rendered}`);
  }

  check('no page errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 600));
} catch (error) {
  failures.push(`threw: ${error?.message ?? error}`);
  console.error(error);
  try { await shot('failure.png'); } catch { /* page gone */ }
} finally {
  await app.close();
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nP3.6 supports walk: all ${results.length} checks green`);
