// Boolean subtract + intersect through the real context menu (ADR 0002). Two
// 10 mm OBJ cubes go through the real import; the second moves +5 mm on X so
// they overlap by half. Selecting [A, B] (A first = the subtract base) and
// clicking Combine > Subtract / Intersect must leave one welded, watertight,
// consistently wound 5 x 10 x 10 mm box (500 mm^3): A - B keeps A's low-X
// half, A n B the shared middle. Undo must bring back both 1000 mm^3 cubes.
// The result must also stay where the operands were. Subtract runs a second
// time with Worker hidden, so the main-thread CSG2 fallback is checked too.
// The geometry truth is computed here from the result's world-space vertices,
// not by the app. Needs Chrome + Vite:
//
//   node tests/browser-boolean-smoke.mjs

import { launchApp, assert } from './cdp-harness.mjs';

const BU_TO_MM = 1000;
const CUBE_MM = 10;
const OFFSET_MM = 5;

// Outward counter-clockwise quads, right-handed, 0..10 mm.
const CUBE_OBJ = (name) => [
  `o ${name}`,
  'v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0',
  'v 0 0 10', 'v 10 0 10', 'v 10 10 10', 'v 0 10 10',
  'f 1 4 3 2', 'f 5 6 7 8', 'f 1 2 6 5', 'f 4 8 7 3', 'f 1 5 8 4', 'f 2 3 7 6',
].join('\n') + '\n';

// What the page hands back for one object: world-space mm positions + indices.
const GEOMETRY_OF = `(id) => {
  const m = window.__al.AssetLoader.getBabylonMesh(id);
  if (!m) return null;
  m.computeWorldMatrix(true);
  const W = m.getWorldMatrix();
  const p = m.getVerticesData('position');
  const pos = [];
  for (let i = 0; i < p.length; i += 3) {
    const v = BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(p[i], p[i + 1], p[i + 2]), W);
    pos.push(v.x * ${BU_TO_MM}, v.y * ${BU_TO_MM}, v.z * ${BU_TO_MM});
  }
  return { enabled: m.isEnabled(), pos, idx: Array.from(m.getIndices()) };
}`;

/** Weld by position (1e-3 mm grid), then measure the closed surface. */
function measure({ pos, idx }) {
  const key = (i) => [0, 1, 2].map(a => Math.round(pos[i * 3 + a] * 1000)).join(',');
  const ids = new Map();
  const weld = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const k = key(i);
    if (!ids.has(k)) ids.set(k, ids.size);
    weld.push(ids.get(k));
  }
  const directed = new Map();
  let volume = 0;
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const [p, q, r] = [P(a), P(b), P(c)];
    volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const e = `${weld[u]}>${weld[v]}`;
      directed.set(e, (directed.get(e) ?? 0) + 1);
    }
  }
  let badEdges = 0;
  for (const [e, n] of directed) {
    const [u, v] = e.split('>');
    if (n !== 1 || directed.get(`${v}>${u}`) !== 1) badEdges++;
  }
  const min = [0, 1, 2].map(a => Math.min(...pos.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map(a => Math.max(...pos.filter((_, i) => i % 3 === a)));
  return { triangles: idx.length / 3, volume: Math.abs(volume), watertight: badEdges === 0, badEdges, min, max };
}

const close = (a, b, tol) => Math.abs(a - b) <= tol;

async function runOp(app, op, expectLowX, { inline = false } = {}) {
  const label = inline ? `${op} (main-thread CSG2)` : op;
  const step = async (label, body) => {
    const res = await app.run(`(async () => {
      try {
        const B = window.BABYLON;
        const al = window.__al = await import('/src/core/AssetLoader.js');
        const st = await import('/src/core/StateManager.js');
        const geometryOf = ${GEOMETRY_OF};
        ${body}
      } catch (err) { return { error: String(err?.stack ?? err) }; }
    })()`);
    if (res?.error) throw new Error(`${op} ${label}: ${res.error}`);
    return res;
  };

  const setup = await step('import', `
    const before = Object.keys(st.getState().scene.objects);
    const [a] = await al.AssetLoader.loadFromBlob(new Blob([${JSON.stringify(CUBE_OBJ('cubeA'))}]), '${op}-a.obj');
    const [b] = await al.AssetLoader.loadFromBlob(new Blob([${JSON.stringify(CUBE_OBJ('cubeB'))}]), '${op}-b.obj');
    const ma = al.AssetLoader.getBabylonMesh(a), mb = al.AssetLoader.getBabylonMesh(b);
    // Rest-pose bounds: the import scale-pop may still be running, and the
    // Boolean has to settle it itself.
    const restMin = (m) => m.getBoundingInfo().boundingBox.minimum.add(m.getAbsolutePosition());
    const shift = restMin(ma).add(new B.Vector3(${OFFSET_MM / BU_TO_MM}, 0, 0)).subtract(restMin(mb));
    mb.setAbsolutePosition(mb.getAbsolutePosition().add(shift));
    mb.computeWorldMatrix(true);
    return { a, b, before };`);
  const { a, b } = setup;

  await step('menu', `
    const { Selection } = await import('/src/core/Selection.js');
    const { ContextMenu } = await import('/src/ui/ContextMenu.js');
    if (${inline}) { window.__RealWorker = window.Worker; window.Worker = undefined; }
    Selection.set(['${a}', '${b}'], '${b}');
    ContextMenu.open({ x: 400, y: 300, source: 'viewport', hit: true, targetKind: 'object', targetId: '${a}' });
    const header = document.querySelector('.context-menu [data-submenu="combine"]');
    if (!header) return { error: 'context menu has no Combine submenu' };
    header.click();
    const item = document.querySelector('.cm-submenu[data-submenu-for="combine"] [data-action="bool-${op}"]');
    if (!item || item.classList.contains('cm-disabled')) return { error: 'Combine > ${op} missing or disabled with two objects selected' };
    item.click();
    return {};`);

  const known = JSON.stringify([...setup.before, a, b]);
  let resultId = null;
  const deadline = Date.now() + 120000;
  while (!resultId && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    resultId = (await step('wait', `
      const keys = Object.keys(st.getState().scene.objects);
      const known = new Set(${known});
      if (keys.includes('${a}') || keys.includes('${b}')) return { id: null };
      return { id: keys.find(k => !known.has(k)) ?? null };`)).id;
  }
  if (!resultId) {
    const toast = await app.run(`document.querySelector('.toast')?.textContent ?? 'none'`);
    throw new Error(`${op}: no result object within 120 s (toast: ${toast})`);
  }

  const res = await step('measure + undo', `
    if (window.__RealWorker) { window.Worker = window.__RealWorker; delete window.__RealWorker; }
    const result = geometryOf('${resultId}');
    const hm = await import('/src/core/HistoryManager.js');
    hm.undo();
    const objs = st.getState().scene.objects;
    const undone = {
      operandsBack: !!objs['${a}'] && !!objs['${b}'], resultGone: !objs['${resultId}'],
      a: geometryOf('${a}'), b: geometryOf('${b}'), resultEnabled: geometryOf('${resultId}')?.enabled ?? false,
    };
    hm.push(new hm.DeleteCommand(['${a}', '${b}']));
    return { result, undone };`);

  // The operands' resting truth, read after undo brought them back.
  const u = res.undone;
  assert(u.operandsBack && u.resultGone && !u.resultEnabled, `${label}: undo should restore both operands and remove the result (${JSON.stringify({ back: u.operandsBack, gone: u.resultGone, enabled: u.resultEnabled })})`);
  for (const name of ['a', 'b']) {
    const m = measure(u[name]);
    assert(u[name].enabled && m.watertight && close(m.volume, 1000, 0.5),
      `${label}: after undo cube ${name} should be back as a closed 1000 mm^3 cube, got ${m.volume.toFixed(2)} mm^3, ${m.badEdges} bad edges (enabled ${u[name].enabled})`);
  }
  const ax = measure(u.a);
  assert(close(measure(u.b).min[0] - ax.min[0], OFFSET_MM, 0.01), `${label}: cube B should sit ${OFFSET_MM} mm along x from cube A`);
  const r = measure(res.result);
  const size = r.max.map((v, i) => v - r.min[i]);
  console.log(JSON.stringify({ op: label, triangles: r.triangles, volume: +r.volume.toFixed(3), watertight: r.watertight,
    sizeMM: size.map(v => +v.toFixed(3)), xFromA: [+(r.min[0] - ax.min[0]).toFixed(3), +(r.max[0] - ax.min[0]).toFixed(3)] }));
  assert(close(r.volume, 500, 0.5), `${label}: result volume ${r.volume.toFixed(3)} mm^3, expected 500 (half of a 10 mm cube)`);
  assert(r.watertight, `${label}: result is not watertight / consistently wound (${r.badEdges} edges not shared by exactly one opposite pair)`);
  assert(r.triangles >= 12, `${label}: a box needs at least 12 triangles, got ${r.triangles}`);
  const sorted = [...size].sort((x, y) => x - y);
  assert(close(sorted[0], 5, 0.01) && close(sorted[1], 10, 0.01) && close(sorted[2], 10, 0.01),
    `${label}: result should measure 5 x 10 x 10 mm, got ${size.map(v => v.toFixed(3)).join(' x ')}`);
  const lowX = r.min[0] - ax.min[0];
  assert(close(lowX, expectLowX, 0.01) && close(r.max[0] - ax.min[0], expectLowX + 5, 0.01),
    `${label}: result should span x ${expectLowX}..${expectLowX + 5} mm from cube A's low face, got ${lowX.toFixed(3)}..${(r.max[0] - ax.min[0]).toFixed(3)} (the result moved)`);
  assert([1, 2].every(i => close(r.min[i], ax.min[i], 0.01) && close(r.max[i], ax.max[i], 0.01)),
    `${label}: result should keep cube A's y/z extent ${JSON.stringify([ax.min, ax.max])}, got ${JSON.stringify([r.min, r.max])} (the result moved)`);

  console.log(`PASS boolean ${label}: ${r.triangles} triangles, ${r.volume.toFixed(2)} mm^3, watertight, x ${expectLowX}..${expectLowX + 5} mm; undo restores both cubes`);
}

async function main() {
  const app = await launchApp({ prefix: 'mixomesh-boolean-' });
  try {
    await runOp(app, 'subtract', 0);
    await runOp(app, 'intersect', CUBE_MM - OFFSET_MM);
    await runOp(app, 'subtract', 0, { inline: true });
    assert(app.exceptions.length === 0, `page exceptions:\n${app.exceptions.join('\n')}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
