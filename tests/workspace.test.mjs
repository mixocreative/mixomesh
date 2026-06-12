// Workspace presets (Blueprint PART 13b). Covers the pure contract pieces:
// state defaults, the panel-visibility resolution rule (manual override
// beats workspace default, outliner pinned), localStorage blob parsing, and
// the .mixo strip (workspace layout is per-user, never a project artefact).
//   node --import ./tests/register-hooks.mjs tests/workspace.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { WORKSPACES, WORKSPACE_DEFAULTS, resolvePanelVisible, parseStored } =
  await import('../src/ui/Workspace.js');
const { freshState, setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { __test } = await import('../src/core/PersistenceManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('freshState defaults: workspace layout, no overrides', () => {
  const ui = freshState().ui;
  assert.equal(ui.workspace, 'layout');
  assert.deepEqual(ui.panelCollapsed, { left: false, right: false, bottom: false });
});

await test('defaults table: three workspaces, outliner widths sane', () => {
  assert.deepEqual(WORKSPACES, ['layout', 'shade', 'print']);
  for (const ws of WORKSPACES) {
    const d = WORKSPACE_DEFAULTS[ws];
    assert.ok(d.outlinerWidth >= 140 && d.rightWidth >= 200 && d.assetHeight >= 80, ws);
  }
  assert.equal(WORKSPACE_DEFAULTS.layout.bottom, true,  'Layout = drop-target focus');
  assert.equal(WORKSPACE_DEFAULTS.shade.bottom,  false, 'Shade collapses the asset panel');
  assert.equal(WORKSPACE_DEFAULTS.print.bottom,  false, 'Print collapses the asset panel');
});

await test('resolution rule: override beats default; outliner pinned', () => {
  const none = { left: false, right: false, bottom: false };
  // Workspace default decides when no override.
  assert.equal(resolvePanelVisible('layout', none, 'bottom'), true);
  // false-override means "user explicitly popped it back up".
  assert.equal(resolvePanelVisible('shade', none, 'bottom'), true,
    'panelCollapsed.bottom=false re-shows a workspace-hidden panel');
  assert.equal(resolvePanelVisible('shade', { ...none, bottom: undefined }, 'bottom'), false,
    'absent override defers to the Shade default (hidden)');
  // true-override always hides.
  assert.equal(resolvePanelVisible('layout', { ...none, right: true }, 'right'), false);
  // Outliner is pinned: workspace defaults never hide it.
  assert.equal(resolvePanelVisible('print', none, 'left'), true);
  assert.equal(resolvePanelVisible('print', { ...none, left: true }, 'left'), false,
    'manual collapse still allowed');
});

await test('parseStored: valid blob round-trips, garbage/wrong-version → null', () => {
  const good = parseStored(JSON.stringify({
    v: 1, workspace: 'shade',
    panelCollapsed: { right: true },
    widths: { shade: { outlinerWidth: 200 } },
  }));
  assert.equal(good.workspace, 'shade');
  assert.deepEqual(good.panelCollapsed, { left: false, right: true, bottom: false });
  assert.equal(good.widths.shade.outlinerWidth, 200);

  assert.equal(parseStored('not json'), null);
  assert.equal(parseStored(JSON.stringify({ v: 99, workspace: 'shade' })), null, 'future version rejected');
  assert.equal(parseStored(JSON.stringify({ v: 1, workspace: 'bogus' })).workspace, 'layout',
    'unknown workspace falls back to layout');
});

await test('.mixo documents never carry workspace layout (13b per-user rule)', async () => {
  SceneManager.saveCameraState = () => ({
    alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
  });
  AssetLoader.getAssetBytes = async () => null;
  AssetLoader.getBabylonMesh = () => null;
  setState(s => ({
    ...s,
    ui: { ...s.ui, workspace: 'print', panelCollapsed: { left: false, right: true, bottom: true } },
  }), { silent: true });

  const doc = await __test._buildDocument({ skipEmbed: true });
  assert.equal(doc.ui.workspace, undefined, 'workspace stripped from the document');
  assert.equal(doc.ui.panelCollapsed, undefined, 'panelCollapsed stripped');
  assert.equal(doc.ui.scaleLocked, true, 'other ui fields still persist');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
