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

await test('printer profiles contain build-volume reference data + a materials table only', () => {
  for (const [id, profile] of Object.entries(printers)) {
    assert.deepEqual(Object.keys(profile).sort(), ['bed', 'displayName', 'materials', 'vendor'], id);
    assert.equal(['format', 'pipeline', 'colorMode'].some(key => key in profile), false, id);
  }
});

await test('watertight-repair-and-cost task 6: every printer has ≥1 material with a positive density', () => {
  for (const [id, profile] of Object.entries(printers)) {
    assert.ok(Array.isArray(profile.materials) && profile.materials.length > 0, `${id}: materials must be a non-empty array`);
    for (const material of profile.materials) {
      assert.equal(typeof material.id, 'string', `${id}: material.id`);
      assert.ok(material.id.length > 0, `${id}: material.id non-empty`);
      assert.equal(typeof material.name, 'string', `${id}: material.name`);
      assert.ok(material.densityGcm3 > 0, `${id}/${material.id}: densityGcm3 must be positive`);
      assert.equal(typeof material.pricePerGram, 'number', `${id}/${material.id}: pricePerGram`);
      assert.ok(material.supportDensityGcm3 > 0, `${id}/${material.id}: supportDensityGcm3 must be positive`);
      assert.equal(typeof material.supportPricePerGram, 'number', `${id}/${material.id}: supportPricePerGram`);
      assert.equal(typeof material.defaultSupportPercent, 'number', `${id}/${material.id}: defaultSupportPercent`);
    }
  }
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

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
