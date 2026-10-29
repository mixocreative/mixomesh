// Supports persistence (plan 2026-10-29 P4.1): the walk scenarios i1-i3 in headless Chrome.
//   i1 save + reopen keeps deleted / manual / overrides / stamps / settings and regenerates the same tips;
//      a changed asset marks the supports stale (geometry)
//   i2 autosave restore keeps them
//   i3 an old (3.5) project without supports opens unchanged, no supports
//
//   node tests/browser-supports-persist-smoke.mjs [--make-fixture]   (writes tests/fixtures/old-3.5-no-supports.mixo)

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootSupportApp, torusStl, ROOT, waitFor } from './support-browser-kit.mjs';

const MAKE_FIXTURE = process.argv.includes('--make-fixture');
const FIXTURE = join(ROOT, 'tests/fixtures/old-3.5-no-supports.mixo');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;

const tmp = join(ROOT, '.tmp/p41');
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, 'torus.stl'), torusStl());
writeFileSync(join(tmp, 'small.stl'), torusStl(14, 5, 24, 12));
writeFileSync(join(tmp, 'other.stl'), torusStl(30, 5, 72, 36));

const app = await bootSupportApp({ prefix: 'mixomesh-persist-' });
const { run, w } = app;

await run(`(async () => {
  const w = window.__w;
  w.p = {
    ser: await import('/src/core/persist/ProjectSerializer.js'),
    auto: await import('/src/core/persist/Autosave.js'),
    cmds: await import('/src/supports/commands/index.ts'),
  };
  /** The whole saved document, as a file round trip would deliver it. */
  w.doc = async () => JSON.parse(JSON.stringify(await w.p.ser.buildDocument({ skipTextureImages: true })));
  w.open = async (doc) => { w.m.mode.supportMode.exit(); await w.m.loader.loadProject(doc); await new Promise(r => setTimeout(r, 1500)); return Object.keys(w.m.st.getState().scene.objects)[0]; };
  w.hand = (id) => {
    const placed = w.m.cache.cachedPlacement(id) ?? [];
    const c = w.p.cmds;
    const del = placed.slice(0, 4).map(p => p.id);
    const over = placed.slice(10, 12).map(p => p.id);
    const p0 = placed[40];
    const stamp = { kind: 'paint', center: [...placed[70].position], radius: 2.5, normal: [0, -1, 0] };
    c.commitSupportEdits([
      new c.DeleteSupportsCommand(id, del),
      new c.SetOverrideCommand(id, over, { pointDiameter: 0.5 }),
      new c.AddSupportCommand(id, { point: [p0.position[0] + 0.3, p0.position[1], p0.position[2]], normal: [0, -1, 0], worldNormal: [0, -1, 0], candidates: [], minFromUpDeg: 10 }),
      new c.StampStrokeCommand(id, [stamp]),
      new c.ChangeSettingsCommand(id, { liftHeight: 7 }),
    ], 'hand work');
    return { del, over };
  };
  /** What must survive: the hand work, settings, build stamps (not the revision, which is session-local). */
  w.keep = (id) => {
    const r = w.m.store.readSupports(id);
    return r && JSON.stringify({ settings: r.settings, deleted: r.deleted, manual: r.manual, overrides: r.overrides, stamps: r.stamps, sourceHash: r.sourceHash, pose: r.pose, placed: r.placed });
  };
  w.tips = async (id) => {
    const d = await w.drawn(id);
    return { drawn: [...d.contactIds].sort(), placement: (w.m.cache.cachedPlacement(id) ?? []).map(p => p.id).sort(), tris: d.tris };
  };
  return true;
})()`);

const idOf = () => run(`Object.keys(window.__w.m.st.getState().scene.objects)[0]`);
const settle = async (id) => { await waitFor(() => w(`idle(${J(id)})`), 120000, 'idle'); };
/** Enter Support Mode on the (only) object and wait until the job landed; returns the tip sets. */
async function enterAndSettle(id) {
  await run(`window.__w.m.sel.Selection.set([${J(id)}], ${J(id)}); true`);
  await run(`window.__w.m.mode.supportMode.enter()`);
  await waitFor(() => run(`(window.__w.m.cache.cachedPlacement(${J(id)}) ?? []).length > 0`), 90000, 'placement rebuilt');
  await settle(id);
  return w(`tips(${J(id)})`);
}
async function generateFresh(file) {
  const id = await run(`window.__w.load('/.tmp/p41/${file}', ${J(file)})`);
  await run(`window.__w.m.mode.supportMode.enter()`);
  await app.sleep(600);
  const ok = await app.pressButton('Generate supports');
  await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1`), 90000, 'generation');
  await settle(id);
  return { id, ok };
}
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

try {
  if (MAKE_FIXTURE) {
    const id = await run(`window.__w.load('/.tmp/p41/small.stl', 'small.stl')`);
    const doc = await w('doc()');
    doc.version = '3.5';
    for (const o of doc.sceneObjects) delete o.supports;
    writeFileSync(FIXTURE, JSON.stringify(doc));
    console.log(`fixture written: ${FIXTURE} (object ${id})`);
    await app.close();
    process.exit(0);
  }

  // ───────── i1: save + reopen ─────────
  const first = await generateFresh('torus.stl');
  let id = first.id;
  check('i1 Generate supports works', first.ok);
  await w(`hand(${J(id)})`);
  await settle(id);
  const before = await w(`keep(${J(id)})`);
  const tipsBefore = await w(`tips(${J(id)})`);
  const rec0 = await w(`rec(${J(id)})`);
  check('i1 hand work is on the record', rec0.deleted.length >= 4 && rec0.manual.length === 1 && Object.keys(rec0.overrides).length === 2 && rec0.stamps.kinds.length === 1 && rec0.settings.liftHeight === 7,
    `deleted ${rec0.deleted.length}, manual ${rec0.manual.length}, overrides ${Object.keys(rec0.overrides).length}, stamps ${rec0.stamps.kinds.length}`);
  const doc1 = await w('doc()');
  const saved = doc1.sceneObjects[0].supports;
  check('i1 the saved document carries the record and version 3.6', doc1.version === '3.6' && saved && JSON.stringify(saved.deleted) === JSON.stringify(rec0.deleted) && saved.manual.length === 1, `version ${doc1.version}`);

  id = await w(`open(${J(doc1)})`);
  check('i1 reopen restores the record unchanged', (await w(`keep(${J(id)})`)) === before);
  check('i1 reopened supports are not stale', (await w(`rec(${J(id)})`)).stale === null);
  const tipsAfter = await enterAndSettle(id);
  check('i1 same tips regenerated (placement and drawn id sets)', sameSet(tipsBefore.placement, tipsAfter.placement) && sameSet(tipsBefore.drawn, tipsAfter.drawn) && tipsAfter.tris === tipsBefore.tris,
    `placement ${tipsBefore.placement.length}/${tipsAfter.placement.length}, drawn ${tipsBefore.drawn.length}/${tipsAfter.drawn.length}, tris ${tipsBefore.tris}/${tipsAfter.tris}`);
  check('i1 hand work intact after regeneration', (await w(`keep(${J(id)})`)) === before);

  // changed asset: same project, other geometry bytes -> stale (geometry), regenerates on entry
  const other = readFileSync(join(tmp, 'other.stl')).toString('base64');
  const changed = JSON.parse(JSON.stringify(doc1));
  for (const a of changed.assetLibrary) { a.fileData = other; delete a.contentHash; }
  id = await w(`open(${J(changed)})`);
  const staleRec = await w(`rec(${J(id)})`);
  check('i1b a changed asset marks the supports stale (geometry), hand work kept', staleRec?.stale === 'geometry' && (await w(`keep(${J(id)})`)) === before, `stale ${staleRec?.stale}, stored hash ${staleRec?.sourceHash}`);
  await run(`window.__w.m.sel.Selection.set([${J(id)}], ${J(id)}); window.__w.m.mode.supportMode.enter()`);
  await waitFor(async () => (await w(`rec(${J(id)})`))?.stale === null, 120000, 'rekey on entry');
  await settle(id);
  const rekeyed = await w(`rec(${J(id)})`);
  check('i1b entering Support Mode regenerates against the new geometry (not stale, new hash)', rekeyed.stale === null && rekeyed.sourceHash !== saved.sourceHash, `hash ${rekeyed.sourceHash} vs ${saved.sourceHash}, revision ${rekeyed.revision}`);

  // ───────── i2: autosave restore ─────────
  const second = await generateFresh('torus.stl');
  id = second.id;
  await w(`hand(${J(id)})`);
  await settle(id);
  const before2 = await w(`keep(${J(id)})`);
  const tips2 = await w(`tips(${J(id)})`);
  const ticked = await run(`window.__w.p.auto.autosaveTick()`);
  check('i2 an autosave snapshot was written', ticked === true);
  await run(`window.__w.m.mode.supportMode.exit(); window.__w.m.loader.resetWorld(); true`);
  const recovered = await run(`window.__w.p.auto.recoverAutosave()`);
  check('i2 recoverAutosave loaded the snapshot', recovered === true);
  await app.sleep(1500);
  id = await idOf();
  check('i2 autosave restore keeps the hand work and settings', (await w(`keep(${J(id)})`)) === before2);
  const tips2b = await enterAndSettle(id);
  check('i2 same tips after the restore', sameSet(tips2.placement, tips2b.placement) && sameSet(tips2.drawn, tips2b.drawn), `placement ${tips2.placement.length}/${tips2b.placement.length}, drawn ${tips2.drawn.length}/${tips2b.drawn.length}`);

  // ───────── i3: old version fixture ─────────
  const old = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  check('i3 the fixture is a 3.5 document without supports', old.version === '3.5' && old.sceneObjects.every((o) => !('supports' in o)));
  id = await w(`open(${J(old)})`);
  const state = await run(`(() => { const o = Object.values(window.__w.m.st.getState().scene.objects); return { n: o.length, names: o.map(x => x.name), hasSupports: o.some(x => 'supports' in x), ghost: o.some(x => x.isGhost) }; })()`);
  check('i3 old project loads unchanged: same objects, no supports', state.n === old.sceneObjects.length && !state.hasSupports && !state.ghost && state.names[0] === old.sceneObjects[0].name, J(state));
  const resaved = await w('doc()');
  check('i3 re-saving it writes 3.6 and still no supports', resaved.version === '3.6' && resaved.sceneObjects.every((o) => o.supports === undefined));
  await run(`window.__w.m.sel.Selection.set([${J(id)}], ${J(id)}); window.__w.m.mode.supportMode.enter()`);
  await app.sleep(600);
  check('i3 Support Mode opens and Generate works on it', await app.pressButton('Generate supports'));
  await waitFor(() => run(`window.__mxSupportLive.stats.rendered >= 1`), 90000, 'generation on old project');
  await settle(id);
  check('i3 supports exist after Generate', (await w(`counts(${J(id)})`)).auto > 0);

  check('no page errors', app.problems.length === 0, app.problems.slice(0, 3).join(' | '));
} catch (error) {
  failures.push(`crashed: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await app.close();
}
if (failures.length) { console.error(`\n${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('\nsupports persistence smoke: all ok');
