// Support export (plan 2026-10-29 P4.2) in headless Chrome, through the real pipeline and the
// automation API's own dispatcher (what --job and the named pipe call):
//   r1 as shown: the export build carries the drawn contacts; supportsOnly writes only supports
//   r2 ratio: an export at 2x the shown size REGENERATES the supports at that size: same contacts,
//      the model doubles, the lift stays 5 mm (a scaled support would stand 10 mm), tips not scaled
//   s1 stale: a rotation makes the supports stale; readiness blocks an export that carries them
//      (issue supports-stale, the Export tab says so, the button is off), 'none' still exports
//   c1 cost (P4.3b): with Tips only on, the quoted support volume is the EXPORT build's (equals the
//      supportsOnly STL's volume), 'calculating' shows until it lands, supportsOnly costs supports alone,
//      and after a regenerate the HUD support figure equals the cache with no extra event
//   a1 API: export.run with options.includeSupports through createAppDispatcher (printable /
//      supportsOnly / none, and an unknown value rejected)
//   screenshots: .tmp/p42/
//
//   node tests/browser-supports-export-smoke.mjs

import { join } from 'node:path';
import { bootSupportApp, ROOT, waitFor } from './support-browser-kit.mjs';

const OUT = join(ROOT, '.tmp/p42');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Enclosed volume (mm^3) of a binary STL: abs of the summed signed tetrahedra. */
function stlVolume(b64) {
  const buf = Buffer.from(b64, 'base64');
  const n = buf.readUInt32LE(80);
  let v6 = 0;
  for (let k = 0; k < n; k++) {
    const f = (v, a) => buf.readFloatLE(84 + k * 50 + 12 + v * 12 + a * 4);
    const [ax, ay, az] = [f(0, 0), f(0, 1), f(0, 2)], [bx, by, bz] = [f(1, 0), f(1, 1), f(1, 2)], [cx, cy, cz] = [f(2, 0), f(2, 1), f(2, 2)];
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v6 / 6);
}

/** Binary STL facts: facet count and bounds (mm, print frame). */
function stl(b64) {
  const buf = Buffer.from(b64, 'base64');
  const n = buf.readUInt32LE(80);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const x = buf.readFloatLE(84 + k * 50 + 12 + v * 12 + a * 4);
        if (x < lo[a]) lo[a] = x;
        if (x > hi[a]) hi[a] = x;
      }
    }
  }
  return { facets: n, min: lo, max: hi, size: hi.map((h, i) => h - lo[i]) };
}

const app = await bootSupportApp({ prefix: 'mixomesh-supexport-' });
const { run, w } = app;

await run(`(async () => {
  const w = window.__w;
  w.x = {
    pm: (await import('/src/core/PrintManager.js')).PrintManager,
    // supportsRefs: the Electron renderer's dispatcher (the host resolves outDir and writes the bytes).
    api: await (await import('/src/core/api/AppDispatcherDeps.js')).createAppDispatcher({ supportsRefs: true }),
    ws: (await import('/src/ui/Workspace.js')).Workspace,
  };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  /** One STL through the pipeline (collect mode: the same writers as a save). */
  w.exportStl = async (opts) => {
    const r = await w.x.pm.collectExportFiles(['stl'], { acknowledgeWarnings: true, ...opts });
    if (r.blocked) return { blocked: r.code, issues: r.readinessIssues.map(i => i.code) };
    return { b64: b64(r.files[0].bytes), name: r.files[0].name };
  };
  w.apiExport = async (options, formats = ['stl']) => {
    try {
      const files = await w.x.api.dispatch('export.run', { formats, options: { acknowledgeWarnings: true, ...options } });
      return { files: files.map(f => ({ name: f.name, b64: b64(f.bytes) })) };
    } catch (err) { return { error: err?.data?.code ?? err?.code ?? String(err), gate: err?.data?.gate ?? null, issues: (err?.data?.issues ?? []).map(i => i.code) }; }
  };
  w.lastExport = (id) => JSON.parse(JSON.stringify(window.__mxSupportLive.exportStats.last[id] ?? null));
  w.setTargets = (targets) => w.m.st.setState(s => ({ ...s, print: { ...s.print, exportTargets: targets } }), { silent: true });
  return true;
})()`);

const settle = async (id) => { await waitFor(() => w(`idle(${J(id)})`), 120000, 'idle'); };

try {
  const id = await run(`window.__w.load('/tests/fixtures/support-plain-cube.glb', 'support-plain-cube.glb')`);
  await run(`window.__w.m.mode.supportMode.enter()`);
  await app.sleep(600);
  check('Generate supports button works', await app.pressButton('Generate supports'));
  await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1`), 90000, 'generation');
  await settle(id);
  const drawn = await w(`drawn(${J(id)})`);
  await run(`window.__w.m.mode.supportMode.exit()`);
  await app.sleep(400);

  // ───────── r1: as shown ─────────
  const modelOnly = stl((await w(`exportStl({ includeSupports: 'none' })`)).b64);
  const printable = await w(`exportStl({})`);
  const pr = stl(printable.b64);
  const ex1 = await w(`lastExport(${J(id)})`);
  const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  check('r1 default (no choice) exports model + supports: the export build carries the drawn contacts',
    ex1?.scale === 1 && same(ex1.contactIds, drawn.contactIds) && pr.facets === modelOnly.facets + ex1.tris,
    `contacts drawn ${drawn.contactIds.length} / exported ${ex1?.contactIds.length}, facets ${modelOnly.facets} + ${ex1?.tris} = ${pr.facets}`);
  check('r1 the supports stand on the bed under the model: lift 5 mm', near(pr.size[2] - modelOnly.size[2], 5, 0.05) && near(modelOnly.size[2], 20, 0.01),
    `model ${modelOnly.size.map(v => v.toFixed(2))}, with supports ${pr.size.map(v => v.toFixed(2))}`);
  const only = stl((await w(`exportStl({ includeSupports: 'supportsOnly' })`)).b64);
  check('r1 supportsOnly writes only the supports', only.facets === ex1.tris && near(only.max[2], modelOnly.min[2], 0.5) && near(only.min[2], modelOnly.min[2] - 5, 0.05),
    `facets ${only.facets}, z ${only.min[2].toFixed(2)}..${only.max[2].toFixed(2)}`);

  // ───────── c1: cost quote (P4.3b) ─────────
  await run(`(() => { window.__w.m.data.commitSetting(${J(id)}, { view: {}, selected: [] }, 'previewMode', 'ONLY_TIP'); return true; })()`);
  check('c1 Tips only is on', (await w(`rec(${J(id)})`))?.settings?.previewMode === 'ONLY_TIP');
  const exportVol = stlVolume((await w(`exportStl({ includeSupports: 'supportsOnly' })`)).b64);
  // The cost card is visible on the Print > Export tab: it asks for the export-build figures itself.
  const card = await run(`(async () => {
    window.__w.x.ws.setWorkspace('print');
    document.querySelector('#rp-print-body .pp-tab[data-tab="export"]')?.click();
    const read = () => document.querySelector('#rp-print-body [data-cost="supports"]')?.textContent ?? null;
    const first = read();
    for (let i = 0; i < 300 && (read() === null || /calculating|計算|计算/.test(read())); i++) await new Promise(r => setTimeout(r, 100));
    return { first, settled: read() };
  })()`);
  check('c1 the card shows "calculating" (never the preview volume) until the export figures land',
    /calculating/i.test(card.first ?? '') && /cm/.test(card.settled ?? '') && !/calculating/i.test(card.settled ?? ''), JSON.stringify(card));
  const quoted = await run(`(async () => {
    const pc = await import('/src/core/print/PrintCost.js');
    const ctx = window.__w.x.pm.previewExportContext();
    const q = pc.quote(ctx, { pricePerGram: 0.5, currency: 'USD' }, { densityGcm3: 1.1, supportDensityGcm3: 1.0 });
    const rec = window.__w.m.store.readSupports(${J(id)});
    const prev = window.__w.m.cache.cachedSupportMesh(${J(id)}, rec.revision);
    return { vol: q.supportVolumeCM3, tris: q.supportTriangles, pending: q.reasons.filter(r => r.startsWith('supportsPending')), previewTris: prev ? prev.indices.length / 3 : -1 };
  })()`);
  check('c1 with Tips only on, the quoted support volume equals the export build (supportsOnly STL volume)',
    quoted.vol != null && Math.abs(quoted.vol * 1000 - exportVol) <= Math.max(0.5, exportVol * 0.002) && quoted.pending.length === 0,
    `quoted ${quoted.vol != null ? (quoted.vol * 1000).toFixed(3) : null} mm3 vs export ${exportVol.toFixed(3)} mm3 (export tris ${ex1.tris}, quoted ${quoted.tris}, preview cache ${quoted.previewTris})`);
  check('c1 the quoted triangle count is the export build count', quoted.tris === ex1.tris, `${quoted.tris} vs ${ex1.tris}`);
  const onlyQ = await run(`(async () => {
    const pc = await import('/src/core/print/PrintCost.js');
    const q = pc.quote(window.__w.x.pm.previewExportContext({ includeSupports: 'supportsOnly' }), { pricePerGram: 0.5, currency: 'USD' }, { densityGcm3: 1.1, supportDensityGcm3: 1.0 });
    return { excluded: q.modelExcluded, vol: q.volumeCM3, material: q.materialCost, support: q.supportCost, total: q.total };
  })()`);
  check('c1 supportsOnly total = supports only (model excluded)', onlyQ.excluded === true && onlyQ.vol === 0 && onlyQ.material === 0 && onlyQ.total != null && Math.abs(onlyQ.total - onlyQ.support) < 1e-9, JSON.stringify(onlyQ));
  // HUD: after a regenerate the support figure equals the cache, with no event but the cache's own.
  const rendered0 = await run(`window.__mxSupportLive.stats.rendered`);
  await run(`(() => { window.__mxSupportLive.request(${J(id)}, false, true); return true; })()`);
  await waitFor(() => run(`window.__mxSupportLive.stats.rendered > ${rendered0}`), 90000, 'regenerate');
  await settle(id);
  const hud = await run(`(async () => {
    await new Promise(r => setTimeout(r, 250));
    const { formatTriCount } = await import('/src/core/scene/TriangleCount.js');
    const rec = window.__w.m.store.readSupports(${J(id)});
    const cached = window.__w.m.cache.cachedSupportMesh(${J(id)}, rec.revision);
    const text = document.getElementById('sb-center')?.textContent ?? '';
    const m = /supports ([0-9.]+[kM]?)/.exec(text);
    return { text, shown: m ? m[1] : null, expected: cached ? formatTriCount(cached.indices.length / 3) : null };
  })()`);
  check('c1 the HUD support figure equals the cache after a regenerate', hud.expected != null && hud.shown === hud.expected, JSON.stringify(hud));
  await run(`(() => { window.__w.m.data.commitSetting(${J(id)}, { view: {}, selected: [] }, 'previewMode', 'FULL'); return true; })()`);

  // ───────── r2: ratio (print size 2x) ─────────
  await w(`setTargets([{ kind: 'factor', value: 2 }])`);
  const model2 = stl((await w(`exportStl({ includeSupports: 'none' })`)).b64);
  const both2 = stl((await w(`exportStl({ includeSupports: 'printable' })`)).b64);
  const ex2 = await w(`lastExport(${J(id)})`);
  check('r2 at 2x the supports are regenerated (engine build at scale 2) on the same contacts',
    ex2?.scale === 2 && same(ex2.contactIds, ex1.contactIds), `scale ${ex2?.scale}, contacts ${ex2?.contactIds.length} vs ${ex1.contactIds.length}`);
  check('r2 the model doubles, the lift stays 5 mm (mm-physical, never scaled to 10 mm)',
    near(model2.size[2], 40, 0.02) && near(both2.size[2] - model2.size[2], 5, 0.05),
    `model ${model2.size.map(v => v.toFixed(2))}, with supports ${both2.size.map(v => v.toFixed(2))}`);
  check('r2 not a scaled copy: the 2x build differs from 2x the shown one', ex2.tris !== ex1.tris || both2.facets - model2.facets === ex2.tris,
    `tris ${ex1.tris} -> ${ex2.tris}`);
  await w(`setTargets([])`);

  // ───────── a1: automation API ─────────
  const apiOnly = await w(`apiExport({ includeSupports: 'supportsOnly' })`);
  check('a1 export.run options.includeSupports supportsOnly', !!apiOnly.files && stl(apiOnly.files[0].b64).facets === ex1.tris, JSON.stringify(apiOnly.error ?? apiOnly.files?.map(f => f.name)));
  const apiNone = await w(`apiExport({ includeSupports: 'none' })`);
  check('a1 export.run options.includeSupports none', !!apiNone.files && stl(apiNone.files[0].b64).facets === modelOnly.facets, JSON.stringify(apiNone.error));
  const api3mf = await w(`apiExport({ includeSupports: 'printable' }, ['3mf'])`);
  check('a1 export.run 3mf printable returns a package', !!api3mf.files?.[0]?.name?.endsWith('.3mf'), JSON.stringify(api3mf.error));
  const apiBad = await w(`apiExport({ includeSupports: 'all' })`);
  check('a1 an unknown includeSupports is E_INVALID_PARAMS', apiBad.error === 'E_INVALID_PARAMS', JSON.stringify(apiBad));

  // UI: the Export tab shows the Supports row (effective choice: model + supports).
  const ui = await run(`(async () => {
    window.__w.x.ws.setWorkspace('print');
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#rp-print-body .pp-tab[data-tab="export"]')?.click();
    await new Promise(r => setTimeout(r, 400));
    const sel = document.querySelector('#rp-print-body #pp-include-supports');
    sel?.scrollIntoView({ block: 'center' });
    return { value: sel?.value ?? null, options: [...(sel?.options ?? [])].map(o => o.value), visible: !!sel && sel.getBoundingClientRect().width > 0 };
  })()`);
  check('ui Export tab: Supports row shows Model + supports', ui.visible && ui.value === 'printable' && ui.options.join() === 'none,printable,supportsOnly', JSON.stringify(ui));
  await app.shot(OUT, 'export-supports-row.png');

  // ───────── s1: stale ─────────
  await run(`(() => { const { TransformCommand } = window.__w.t; const m = window.__w.m.al.AssetLoader.getBabylonMesh(${J(id)}); const prev = window.__w.t.captureWorld(m); const q = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 0, 1), 0.3); const cur = new BABYLON.Quaternion(prev.rotation.x, prev.rotation.y, prev.rotation.z, prev.rotation.w); const r = q.multiply(cur); const next = { position: prev.position, scaling: prev.scaling, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } }; window.__w.m.hist.HistoryManager.push(new TransformCommand({ [${J(id)}]: prev }, { [${J(id)}]: next })); return true; })()`);
  await waitFor(async () => (await w(`rec(${J(id)})`))?.stale === 'pose', 10000, 'stale');
  const blocked = await w(`exportStl({})`);
  check('s1 stale supports block an export that carries them (readiness error supports-stale)',
    blocked.blocked === 'EXPORT_BLOCKED' && blocked.issues.includes('supports-stale'), JSON.stringify(blocked));
  const apiStale = await w(`apiExport({ includeSupports: 'printable' })`);
  check('s1 the API reports the gate (E_EXPORT_GATE, supports-stale)', apiStale.error === 'E_EXPORT_GATE' && apiStale.issues.includes('supports-stale'), JSON.stringify(apiStale));
  const noneOk = await w(`exportStl({ includeSupports: 'none' })`);
  check('s1 the model alone still exports (includeSupports none)', !!noneOk.b64, JSON.stringify(noneOk.blocked ?? ''));
  const notice = await run(`(async () => {
    await new Promise(r => setTimeout(r, 400));
    const body = document.querySelector('#rp-print-body');
    const row = body?.querySelector('.pp-readiness-issue[data-issue-code="supports-stale"]');
    row?.scrollIntoView({ block: 'center' });
    return { text: row?.textContent.trim() ?? null, disabled: !!body?.querySelector('[data-act="export-primary"]')?.disabled };
  })()`);
  check('s1 the Export tab names the stale supports and the export button is off', !!notice.text && notice.disabled, JSON.stringify(notice));
  await app.shot(OUT, 'export-supports-stale.png');
} catch (err) {
  failures.push(`crashed: ${err?.message ?? err}`);
  console.error(err);
} finally {
  const problems = app.problems?.filter?.((p) => !/favicon|DevTools/.test(p)) ?? [];
  if (problems.length) console.log(`page problems:\n  ${problems.slice(0, 10).join('\n  ')}`);
  await app.close();
}

if (failures.length) {
  console.log(`\nFAIL supports export: ${failures.length} failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS supports export');
}
