// Support Mode structure features in headless Chrome (plan 2026-10-29 P5.1-P5.4), driven through the
// real panel (toggle buttons, number and text fields) and judged on the drawn mesh and the real
// export (supports-only STL through PrintManager.collectExportFiles):
//   t1 Tree: Auto tree toggle, merge distance / branch descent / safe distance clamps and rebuild
//   t3 Raft: on / off / parameters; the export contains the raft
//   t4 Label: text rules (8 chars A-Z 0-9 -, uppercase, others rejected with a hint), default = object name,
//      the export contains the embossed label
//   t2 Brace: angle / spacing / min height / distance limit; on a model with a wall between two plates the
//      pruning drops only the braces that cross it, the brace-pruned notice shows in the problem list and
//      the verdict line, and the other braces stay (repair budget 3)
//   The engine goldens (cube-overhang tree: 62 contacts, 7 trunks, 28 branches) are asserted by
//   src/supports/features.test.ts on the same job path.
//   screenshots: .tmp/p5a/
//
//   node tests/browser-supports-features.mjs [--swiftshader]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSupportApp, writeTorus, ROOT, sleep, waitFor } from './support-browser-kit.mjs';

const OUT = join(ROOT, '.tmp/p5a');
const SWIFT = process.argv.includes('--swiftshader');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;

/** Binary STL of axis-aligned boxes [x0,x1,y0,y1,z0,z1] (mm), counter-clockwise outward. */
function boxesStl(boxes) {
  const tris = [];
  for (const [x0, x1, y0, y1, z0, z1] of boxes) {
    const c = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const quad = (a, b, d, e) => { tris.push([c(a), c(d), c(b)], [c(a), c(e), c(d)]); };
    quad(0, 4, 5, 1); quad(2, 3, 7, 6); quad(0, 2, 6, 4); quad(1, 5, 7, 3); quad(0, 1, 3, 2); quad(4, 6, 7, 5);
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, k) => {
    const o = 84 + k * 50;
    const [a, b, c2] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n.forEach((x, q) => buf.writeFloatLE(x / len, o + q * 4));
    t.forEach((p, q) => p.forEach((x, k2) => buf.writeFloatLE(x, o + 12 + q * 12 + k2 * 4)));
  });
  return buf;
}

const app = await bootSupportApp({ prefix: 'mixomesh-features-', swiftshader: SWIFT });
const { run, w } = app;
const torus = writeTorus('p5a');
// STL is z-up. Two floating plates either side of a thin wall that stands on the bed: x -5..-0.6 and 0.6..5, wall |x| < 0.3.
mkdirSync(join(ROOT, '.tmp/p5a'), { recursive: true });
writeFileSync(join(ROOT, '.tmp/p5a/wall.stl'), boxesStl([[-5, -0.6, -4, 4, 10, 12], [0.6, 5, -4, 4, 10, 12], [-0.3, 0.3, -8, 8, 0, 12]]));
const wallUrl = '/.tmp/p5a/wall.stl';

let id;
const settle = async () => { await waitFor(() => w(`idle(${J(id)})`), 120000, 'idle'); };
const rec = () => w(`rec(${J(id)})`);
const verdict = () => run(`window.__w.m.ui.supportUi.get().verdicts[${J(id)}] ?? null`);
const stamp = () => run('window.__mxSupportLive.stats.rendered');

/** Triangles per part of the drawn build, and its brace triangles that straddle the plane x = 0 (engine frame). */
const parts = () => run(`(async () => {
  const layers = await window.__w.m.layers.appSupportLayers();
  const b = layers.supportLayer(${J(id)}).built;
  const out = {};
  const sig = {};
  let straddle = 0;
  for (const c of b.components) {
    out[c.part] = (out[c.part] ?? 0) + c.count / 3;
    let h = 0;
    for (let i = c.start; i < c.start + c.count; i++) { const v = b.indices[i]; h += b.positions[v * 3] * 3 + b.positions[v * 3 + 1] * 5 + b.positions[v * 3 + 2] * 7; }
    sig[c.part] = (sig[c.part] ?? 0) + h;
    if (c.part !== 'brace') continue;
    for (let i = c.start; i < c.start + c.count; i += 3) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) { const x = b.positions[b.indices[i + k] * 3]; lo = Math.min(lo, x); hi = Math.max(hi, x); }
      if (lo < -0.3 && hi > 0.3) straddle++;
    }
  }
  return { parts: out, sig, total: b.indices.length / 3, straddle };
})()`);

/** The real export, supports only, as the facet count of the STL it writes. */
const exportFacets = () => run(`(async () => {
  const { PrintManager } = await import('/src/core/PrintManager.js');
  const r = await PrintManager.collectExportFiles(['stl'], { acknowledgeWarnings: true, includeSupports: 'supportsOnly' });
  if (r.blocked) return { blocked: r.code };
  const bytes = r.files[0].bytes;
  return { facets: new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true) };
})()`);

/** Press a feature toggle by its accessible label. */
const toggle = (label) => run(`(() => {
  const b = document.querySelector('button[aria-pressed][aria-label=${J(label)}]');
  if (!b || b.disabled) return false; b.click(); return true; })()`);
const pressed = (label) => run(`document.querySelector('button[aria-pressed][aria-label=${J(label)}]')?.getAttribute('aria-pressed') === 'true'`);
const hasField = (label) => run(`[...document.querySelectorAll('label')].some(x => x.textContent.trim() === ${J(label)})`);
/** Set a number field, wait for the rebuild it triggers. */
async function setField(label, text) {
  const before = await stamp();
  const ok = await app.typeField(label, text);
  if (ok) { await waitFor(async () => (await stamp()) > before, 90000, `rebuild after ${label}`); await settle(); }
  return ok;
}
async function press(label) {
  const before = await stamp();
  const ok = await toggle(label);
  if (ok) { await waitFor(async () => (await stamp()) > before, 90000, `rebuild after ${label}`); await settle(); }
  return ok;
}
async function fresh(url, name) {
  id = await run(`window.__w.load(${J(url)}, ${J(name)})`);
  await run('window.__w.m.mode.supportMode.enter()');
  await sleep(600);
  check('Generate supports button works from the panel', await app.pressButton('Generate supports'));
  await waitFor(() => run('window.__mxSupportLive.stats.rendered >= 1'), 90000, 'first generation');
  await settle();
}

try {
  // ───────── t1 Tree ─────────
  await fresh(torus, 'ring part.stl');
  const base = await parts();
  check('t1 Tree: off by default, plain pillars', !(await pressed('Auto tree')) && !('tree-trunk' in base.parts) && !('tree-branch' in base.parts) && (base.parts.pillar ?? 0) > 0, JSON.stringify(base.parts));
  check('t1 merge distance is hidden until Auto tree is on', !(await hasField('Merge distance')));
  check('t1 Auto tree toggle works', (await press('Auto tree')) && (await rec()).settings.scatterAutoTree === true);
  const tree = await parts();
  const v1 = await verdict();
  console.log(`     tree build: parts ${JSON.stringify(tree.parts)}, fallbacks ${JSON.stringify(v1?.fallbacks ?? [])}`);
  check('t1 Tree: branches / trunks are built (or the tree fell back and says so)', ('tree-trunk' in tree.parts) || ('tree-branch' in tree.parts) || (v1?.fallbacks ?? []).includes('tree'), JSON.stringify(tree.parts));
  check('t1 merge distance, branch descent and safe distance fields are there', (await hasField('Merge distance')) && (await hasField('Branch descent')) && (await hasField('Safe distance')));
  await setField('Merge distance', '9999');
  check('t1 merge distance is clamped to the engine limit', (await rec()).settings.scatterMergeDistance === 1000, String((await rec()).settings.scatterMergeDistance));
  await setField('Merge distance', '3.5');
  const m35 = await parts();
  await setField('Branch descent', '6');
  await setField('Safe distance', '1.5');
  const r1 = (await rec()).settings;
  check('t1 values reach the record', r1.scatterMergeDistance === 3.5 && r1.scatterBranchDescent === 6 && r1.scatterSafeDistance === 1.5 && r1.preset === 'CUSTOM', JSON.stringify({ m: r1.scatterMergeDistance, d: r1.scatterBranchDescent, s: r1.scatterSafeDistance, p: r1.preset }));
  const tuned = await parts();
  check('t1 changing them rebuilds the supports', tuned.total !== m35.total || tuned.total !== tree.total, `${tree.total} -> ${m35.total} -> ${tuned.total}`);
  await press('Auto tree');
  const noTree = await parts();
  check('t1 Auto tree off returns to plain pillars', !('tree-trunk' in noTree.parts) && !('tree-branch' in noTree.parts), JSON.stringify(noTree.parts));

  // ───────── t3 Raft (torus) ─────────
  check('t3 Raft is on by default and drawn', (await pressed('Add raft')) && (noTree.parts.raft ?? 0) > 0);
  const withRaft = await exportFacets();
  check('t3 the export contains the raft (facets = drawn build)', withRaft.facets === noTree.total, `export ${withRaft.facets}, drawn ${noTree.total}`);
  for (const [label, text, key, want] of [['Floor thickness', '1.5', 'raftFloorThickness', 1.5], ['Wall height', '2', 'raftWallHeight', 2], ['Wall thickness', '0.8', 'raftWallThickness', 0.8], ['Wall lean', '45', 'raftWallAngle', 45], ['Expand', '5', 'raftExpandWidth', 5]]) {
    await setField(label, text);
    check(`t3 ${label} ${text}`, (await rec()).settings[key] === want, String((await rec()).settings[key]));
  }
  const tunedRaft = await parts();
  check('t3 parameters change the raft', tunedRaft.sig.raft !== noTree.sig.raft, `raft ${noTree.parts.raft} -> ${tunedRaft.parts.raft} tris, geometry changed ${tunedRaft.sig.raft !== noTree.sig.raft}`);
  await setField('Wall lean', '120');
  check('t3 wall lean is clamped to 89 (the engine never returns at 90)', (await rec()).settings.raftWallAngle === 89);
  const tunedTotal = (await parts()).total;
  await press('Add raft');
  const noRaft = await parts();
  const exportNoRaft = await exportFacets();
  check('t3 Raft off removes the raft and its parameters', !('raft' in noRaft.parts) && !(await hasField('Wall lean')), JSON.stringify(noRaft.parts));
  check('t3 the export without raft is smaller by the raft', exportNoRaft.facets === noRaft.total && exportNoRaft.facets < tunedTotal, `${tunedTotal} -> ${exportNoRaft.facets}`);
  await press('Add raft');

  // ───────── t4 Label ─────────
  const lab = await parts();
  check('t4 Label on by default, drawn on the raft', (await pressed('Add label')) && (lab.parts.label ?? 0) > 0, JSON.stringify(lab.parts));
  const placeholder = await run(`(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === 'Text'); return document.getElementById(l.htmlFor).placeholder; })()`);
  check('t4 default label is the object name made to fit (RING-PAR)', placeholder === 'RING-PAR', String(placeholder));
  const fieldBox = `(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === 'Text'); const i = document.getElementById(l.htmlFor); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`;
  const at = await run(fieldBox);
  await app.click(at[0], at[1]);
  await app.cdp.send('Input.insertText', { text: 'ab_c 1-2345' });
  await sleep(200);
  const typed = await run(`(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === 'Text'); return document.getElementById(l.htmlFor).value; })()`);
  const hint = await run(`[...document.querySelectorAll('.mx-hint')].some(x => x.textContent.includes('Only letters A-Z'))`);
  check('t4 the field uppercases, drops other characters, keeps 8 and shows the hint', typed === 'ABC1-234' && hint, `"${typed}" hint ${hint}`);
  const stamp0 = await stamp();
  await app.key('Enter');
  await waitFor(async () => (await stamp()) > stamp0, 90000, 'rebuild after label text');
  await settle();
  const labelled = await parts();
  check('t4 the text reaches the record and the build', (await rec()).settings.labelText === 'ABC1-234' && (labelled.parts.label ?? 0) > 0 && labelled.sig.label !== lab.sig.label, `${lab.parts.label} -> ${labelled.parts.label} label tris`);
  const labelExport = await exportFacets();
  check('t4 the export contains the embossed label (facets = drawn build)', labelExport.facets === labelled.total, `export ${labelExport.facets}, drawn ${labelled.total}`);
  await press('Add label');
  const noLabel = await parts();
  const noLabelExport = await exportFacets();
  check('t4 Label off removes it from the build and the export', !('label' in noLabel.parts) && noLabelExport.facets === noLabel.total && noLabelExport.facets < labelExport.facets, `${labelExport.facets} -> ${noLabelExport.facets}`);
  await press('Add label');

  // Screenshot of the whole panel with all four sections open (tree on so its fields show).
  await press('Auto tree');
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1500, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  await app.shot(OUT, 'support-panel-sections.png');
  await app.cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);
  await press('Auto tree');

  // ───────── t2 Brace + pruning ─────────
  await fresh(wallUrl, 'wall.stl');
  // The wall's own bottom contacts would be the nearest neighbours of the plates' pillars: remove them so the plate pillars pair across the wall.
  await run(`(async () => {
    const m = window.__w.m;
    const ids = (m.cache.cachedPlacement(${J(id)}) ?? []).filter(p => Math.abs(p.position[0]) <= 0.8).map(p => p.id);
    m.data.commitDelete(${J(id)}, ids);
    return ids.length;
  })()`);
  await waitFor(async () => (await rec()).deleted.length > 0, 20000, 'wall contacts deleted');
  await settle();
  const wall = await parts();
  const vw = await verdict();
  console.log(`     wall build: ${JSON.stringify(wall.parts)} straddling braces ${wall.straddle}, fallbacks ${JSON.stringify(vw?.fallbacks ?? [])}`);
  check('t2 pruning ran: fallbacks has brace-pruned, braces remain, none crosses the wall', (vw?.fallbacks ?? []).includes('brace-pruned') && (wall.parts.brace ?? 0) > 0 && wall.straddle === 0, `brace tris ${wall.parts.brace}, straddling ${wall.straddle}`);
  const shown = await run(`document.querySelector('[data-fallback="brace-pruned"]')?.textContent ?? null`);
  const line = await run(`document.querySelector('.sp-verdict')?.textContent ?? null`);
  check('t2 the notice is in the problem list and on the verdict line', !!shown?.includes('Only the cross-braces') && !!line?.includes('Only the cross-braces'), `${shown} | ${line}`);
  await app.shot(OUT, 'brace-pruned.png');
  for (const [label, text, key, want] of [['Brace angle', '55', 'trussAngle', 55], ['Brace spacing', '3', 'trussSpacing', 3], ['Min height', '4', 'trussMinHeight', 4], ['Distance limit', '40', 'trussDistanceLimit', 40]]) {
    await setField(label, text);
    check(`t2 ${label} ${text}`, (await rec()).settings[key] === want, String((await rec()).settings[key]));
  }
  await setField('Brace angle', '85');
  check('t2 brace angle is clamped to 60', (await rec()).settings.trussAngle === 60);
  await press('Cross-braces');
  const noBrace = await parts();
  const vn = await verdict();
  check('t2 Cross-braces off removes them and the notice', !('brace' in noBrace.parts) && !(vn?.fallbacks ?? []).includes('brace-pruned') && !(await hasField('Brace angle')), JSON.stringify(noBrace.parts));

  const issues = app.problems.filter((p) => !/Download the React DevTools/.test(p));
  check('no console errors or exceptions', issues.length === 0, issues.slice(0, 3).join(' | '));
} catch (error) {
  failures.push(`crashed: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await app.close();
}
if (failures.length) { console.error(`\n${failures.length} failure(s): ${failures.join('; ')}`); process.exit(1); }
console.log('\nall features checks passed');
