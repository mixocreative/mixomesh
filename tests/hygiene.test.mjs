// Bundle-4 hygiene regressions (review A8 + M13 + M17).
//   node --import ./tests/register-hooks.mjs tests/hygiene.test.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { installEnv } from './env.mjs';
import printers from '../src/config/printers.json' with { type: 'json' };

installEnv();
console.error = () => {};
const { subscribe, setState, getState } = await import('../src/core/StateManager.js');
const { GroupCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { detectCapabilities } = await import('../src/core/storage/capabilities.js');
const { REPAIR_TRIANGLE_CAP } = await import('../src/core/repair/MeshRepair.js');
const { DEFAULT_BOOLEAN_TRIANGLE_CAP } = await import('../src/core/BooleanService.js');

SceneManager.attachToSelection = () => {};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('A8: subscribe(undefined event) throws in dev instead of silently dying', () => {
  // EVENTS.TYPO_NAME is undefined — the PrintPanel OBJECT_ADDED bug shape.
  assert.throws(() => subscribe(undefined, () => {}), /unknown event/i);
});

await test('printers.json v2: every row validates (required fields, numeric bed, known enums)', async () => {
  const P = await import('../src/core/print/PrinterProfiles.js');
  const num = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  assert.ok(Object.keys(printers).length >= 20, 'ships the full printer list');
  for (const id of ['mimaki-3duj-553', 'mimaki-3duj-2207', 'bambu-x1c', 'bambu-a1', 'bambu-a1-mini', 'prusa-mk4', 'elegoo-saturn-4-ultra', 'generic-obj-mtl-png', 'custom']) {
    assert.ok(printers[id], `legacy id ${id} still present`);
  }
  for (const [id, p] of Object.entries(printers)) {
    for (const k of ['displayName', 'vendor', 'process', 'bed', 'colour', 'export', 'validation', 'defaultMaterialId']) assert.ok(k in p, `${id}: ${k}`);
    assert.ok(P.PRINTER_PROCESSES.includes(p.process), `${id}: process`);
    for (const ax of ['x', 'y', 'z']) {
      if (id === 'custom') assert.ok(p.bed[ax] === null || num(p.bed[ax]), `${id}: bed.${ax}`);
      else assert.ok(num(p.bed[ax]), `${id}: bed.${ax} numeric`);
    }
    assert.ok(P.PRINTER_COLOUR_MODES.includes(p.colour.mode), `${id}: colour.mode`);
    assert.equal(typeof p.colour.alpha, 'boolean', id);
    assert.ok(Number.isInteger(p.colour.maxTextureSize) && p.colour.maxTextureSize >= 0, `${id}: maxTextureSize`);
    assert.ok(Number.isInteger(p.colour.maxTexturesPerObject) && p.colour.maxTexturesPerObject >= 0, `${id}: maxTexturesPerObject`);
    assert.ok(P.PRINTER_FORMATS.includes(p.export.recommended), `${id}: recommended is a known format`);
    assert.equal(typeof p.export.splitByMaterial, 'boolean', id);
    assert.ok(P.PRINTER_OBJ_AXES.includes(p.export.obj.axis), `${id}: obj.axis`);
    assert.ok(P.PRINTER_3MF_FLAVOURS.includes(p.export.threeMF.flavour), `${id}: 3mf flavour`);
    assert.equal(typeof p.export.threeMF.metadata, 'boolean', id);
    assert.equal(typeof p.validation.requireWatertight, 'boolean', id);
    for (const k of ['minWallMM', 'minFeatureMM']) assert.ok(num(p.validation[k]), `${id}: validation.${k}`);
  }
});

await test('AGENTS.md rule 6 carries the Printer default amendment (schema and rule cannot drift)', () => {
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const rule6 = agents.slice(agents.indexOf('6. Export format'), agents.indexOf('7. One-mesh'));
  assert.ok(rule6.length > 50, 'rule 6 found');
  assert.ok(rule6.includes('Printer default'), 'rule 6 mentions Printer default');
});

// Material presets moved to the user-editable public/config/materials.json
// (owner ask 2026-09-18). The shipped file must parse through the same
// validator the app uses, every printer's defaultMaterialId must exist in it,
// and every entry must be quotable (positive density, numeric prices).
await test('materials.json presets parse, are complete, and every printer default exists', async () => {
  const { parseMaterialPresets } = await import('../src/core/print/MaterialPresets.js');
  const raw = JSON.parse(readFileSync(new URL('../public/config/materials.json', import.meta.url), 'utf8'));
  const list = parseMaterialPresets(raw);
  assert.ok(list.length >= 10, 'ships a useful set of presets');
  for (const m of list) {
    assert.ok(m.densityGcm3 > 0, `${m.id}: densityGcm3 > 0`);
    assert.ok(m.supportDensityGcm3 > 0, `${m.id}: supportDensityGcm3 > 0`);
    assert.equal(typeof m.pricePerGram, 'number', `${m.id}: pricePerGram`);
    assert.equal(typeof m.supportPricePerGram, 'number', `${m.id}: supportPricePerGram`);
    assert.equal(typeof m.defaultSupportPercent, 'number', `${m.id}: defaultSupportPercent`);
    assert.ok(['FDM', 'Resin', 'SLS', 'Full-colour', 'Custom'].includes(m.process), `${m.id}: known process`);
  }
  const ids = new Set(list.map(m => m.id));
  for (const [pid, profile] of Object.entries(printers)) {
    assert.ok(ids.has(profile.defaultMaterialId), `${pid}: defaultMaterialId "${profile.defaultMaterialId}" must be a preset`);
  }
  // The validator is not decorative: duplicates, bad density and non-numeric prices are rejected.
  assert.throws(() => parseMaterialPresets({ materials: [{ id: 'a', densityGcm3: 1 }, { id: 'a', densityGcm3: 1 }] }), /duplicate id/);
  assert.throws(() => parseMaterialPresets({ materials: [{ id: 'a', densityGcm3: 0 }] }), /densityGcm3/);
  assert.throws(() => parseMaterialPresets({ materials: [{ id: 'a', densityGcm3: 1, pricePerGram: 'cheap' }] }), /pricePerGram/);
  assert.throws(() => parseMaterialPresets({ materials: [] }), /non-empty/);
});

// (M13 cursor-scaling-on-world-rescale test removed with RescaleWorldCommand in
// the per-object ratio redesign 2026-06-16 — there is no global scene rescale.)

await test('watertight-repair-and-cost task 7: HUD triangle budget > repair cap > boolean cap, web and desktop', () => {
  assert.ok(REPAIR_TRIANGLE_CAP > DEFAULT_BOOLEAN_TRIANGLE_CAP,
    `repair cap (${REPAIR_TRIANGLE_CAP}) must exceed the boolean cap (${DEFAULT_BOOLEAN_TRIANGLE_CAP})`);
  const web = detectCapabilities({ hasFSA: true, hasIDB: true });
  const desktop = detectCapabilities({
    desktop: true,
    desktopCaps: { persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true },
  });
  assert.ok(web.triangleBudget > REPAIR_TRIANGLE_CAP,
    `web triangle budget (${web.triangleBudget}) must exceed the repair cap (${REPAIR_TRIANGLE_CAP})`);
  assert.ok(desktop.triangleBudget > REPAIR_TRIANGLE_CAP,
    `desktop triangle budget (${desktop.triangleBudget}) must exceed the repair cap (${REPAIR_TRIANGLE_CAP})`);
});

await test('M17: undoing a nested group restores the Babylon parent, not scene root', () => {
  const fakeScene = { transformNodes: [] };
  SceneManager.getScene = () => fakeScene;

  // Outer group gOut already exists with a live TransformNode.
  const nOut = { name: 'Outer', parent: null, metadata: { groupId: 'gOut' },
                 setParent(p) { this.parent = p; }, dispose() { this._disposed = true; } };
  fakeScene.transformNodes.push(nOut);

  const m = {
    name: 'm1', metadata: { meshId: 'm1' }, parent: nOut,
    position: { x: 0, y: 0, z: 0 },
    getAbsolutePosition() { return { x: 0, y: 0, z: 0 }; },
    setParent(p) { this.parent = p; },
  };
  meshes.set('m1', m);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { m1: { id: 'm1', name: 'm1', assetId: 'a1', parentId: 'gOut',
        visible: true, locked: false, isGhost: false, isPrintPart: true } },
      groups: { gOut: { id: 'gOut', name: 'Outer', parentId: null, childIds: ['m1'] } },
    },
  }), { silent: true });

  const cmd = new GroupCommand(['m1'], 'Inner');
  cmd.execute();
  assert.notEqual(m.parent, nOut, 'execute parents the mesh under the new inner node');
  const inner = Object.values(getState().scene.groups).find(group => group.name === 'Inner');
  assert.equal(inner?.origin, 'user', 'groups created in the editor preserve intentional empty groups');

  cmd.undo();
  assert.equal(getState().scene.objects.m1.parentId, 'gOut', 'state parent restored');
  assert.equal(m.parent, nOut,
    'Babylon parent must return to the OUTER group node, not scene root (M17)');
});

// ── M11: vendored third-party provenance + offline posture ──────────────
// The repair engine and the CSG kernel exist under public/vendor/ precisely
// so nothing in the export path fetches from a CDN at runtime. Both halves of
// that are asserted here: the files are all present with their licences and
// an attribution header, and no vendored file carries a fetchable URL.

// The 7 payload files (Blueprint §0.5 / public/vendor/NOTICE.md) plus the
// provenance record itself.
const VENDOR_FILES = [
  'public/vendor/meshfix/LICENSE',
  'public/vendor/meshfix/mesh-fix-core.js',
  'public/vendor/meshfix/mesh-fix-core.wasm',
  'public/vendor/meshfix/mesh-fix-lib.js',
  'public/vendor/manifold-3d/LICENSE',
  'public/vendor/manifold-3d/manifold.js',
  'public/vendor/manifold-3d/manifold.wasm',
];
const VENDOR_JS = VENDOR_FILES.filter(f => f.endsWith('.js'));
// http(s) literals that are legitimately present: XML NAMESPACE identifiers
// for the 3MF container format (mesh-fix-lib.js ships its own, unused, 3MF
// writer). A namespace is an identifier, never fetched. Any other host is a
// potential runtime network dependency and fails this test.
const NAMESPACE_HOSTS = ['schemas.microsoft.com', 'schemas.openxmlformats.org'];

await test('M11: all 7 vendored files exist, plus the NOTICE provenance record', () => {
  assert.equal(VENDOR_FILES.length, 7);
  for (const file of [...VENDOR_FILES, 'public/vendor/NOTICE.md']) {
    assert.ok(existsSync(file), `${file} is missing`);
    assert.ok(statSync(file).size > 0, `${file} is empty`);
  }
  const notice = readFileSync('public/vendor/NOTICE.md', 'utf8');
  assert.match(notice, /github\.com\/hololocheck\/MeshFixLib/, 'NOTICE names the MeshFixLib repo');
  assert.match(notice, /2377e2ef3015e628a31815eadcba7a87bda30778/, 'NOTICE pins the upstream revision');
  assert.match(notice, /manifold-3d@3\.4\.0/, 'NOTICE pins the Manifold version');
  assert.match(notice, /Apache-2\.0/);
  assert.match(notice, /MIT/);
});

await test('M11: every vendored .js carries a one-line attribution header', () => {
  for (const file of VENDOR_JS) {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0];
    assert.match(first, /^\/\/ VENDORED THIRD-PARTY FILE/, `${file} has no attribution header`);
    assert.match(first, /https:\/\/github\.com\//, `${file} header has no upstream URL`);
    assert.match(first, /\b(MIT|Apache-2\.0)\b/, `${file} header has no licence`);
    assert.match(first, /NOTICE\.md/, `${file} header does not point at the provenance record`);
  }
});

await test('M11: no vendored file carries a fetchable URL (no runtime CDN)', () => {
  for (const file of VENDOR_JS) {
    const text = readFileSync(file, 'utf8');
    const header = text.split('\n', 1)[0];
    for (const url of text.match(/https?:\/\/[^\s"'`)\\]+/g) ?? []) {
      if (header.includes(url)) continue;                       // our own attribution line
      const host = url.replace(/^https?:\/\//, '').split('/')[0];
      assert.ok(NAMESPACE_HOSTS.includes(host),
        `${file} references ${url} — vendored code must never fetch over the network`);
    }
    assert.equal(/\b(?:fetch|importScripts)\(\s*["'`]https?:/.test(text), false,
      `${file} fetches a remote URL at runtime`);
  }
});

// ── T7: fixtures must match their generators ────────────────────────────
// A committed .glb that has drifted from the script that produced it makes
// every smoke assertion about it meaningless (the smoke would be measuring
// geometry nobody can reproduce). `npm run fixtures` regenerates both.
await test('T7: committed .glb fixtures match their generator output byte for byte', async () => {
  for (const mod of ['./fixtures/make-open-tetra.mjs', './fixtures/make-textured-quad.mjs']) {
    const { glbBytes, outPath } = await import(mod);
    assert.ok(existsSync(outPath), `${outPath} is missing — run npm run fixtures`);
    const committed = readFileSync(outPath);
    assert.equal(committed.length, glbBytes.length,
      `${outPath} is ${committed.length} bytes, generator produces ${glbBytes.length} — run npm run fixtures`);
    assert.ok(committed.equals(glbBytes),
      `${outPath} has drifted from ${mod} — run npm run fixtures`);
  }
});

// ── Stitch local state ignores ────────────────────────────────────────────────
// Google Stitch design-tool artifacts and configuration must not be version-controlled.
await test('Stitch local state (.stitch/ and .stitch.json) is ignored', () => {
  const gitignore = readFileSync('.gitignore', 'utf8');
  assert.ok(gitignore.includes('.stitch/'), '.gitignore must ignore .stitch/ directory');
  assert.ok(gitignore.includes('.stitch.json'), '.gitignore must ignore .stitch.json file');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
