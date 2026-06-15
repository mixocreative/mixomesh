import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { DeleteCommand, DuplicateCommand } = await import('../src/core/HistoryManager.js');

SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
SceneManager.attachToSelection = () => {};

function resetState() {
  AssetLoader.resetAll();
  StateManager.replaceState(StateManager.freshState());
}

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}

function mesh(name) {
  return {
    name,
    parent: null,
    metadata: {},
    isVisible: true,
    enabled: true,
    position: { x: 0, y: 0, z: 0 },
    setParent(parent) { this.parent = parent; },
    setEnabled(enabled) { this.enabled = enabled; },
    getChildMeshes() { return []; },
    clone(newName, parent) {
      const copy = mesh(newName);
      copy.parent = parent;
      copy.metadata = { ...(this.metadata ?? {}) };
      copy.isVisible = this.isVisible;
      return copy;
    },
  };
}

function seedLogicalObject(over = {}) {
  const objects = {
    partA: obj('partA', { name: 'Mug', sourceGroupId: 'sg_mug', logicalObjectId: 'partA', ...over.lead }),
    partB: obj('partB', { name: 'Mug__part1', sourceGroupId: 'sg_mug', logicalObjectId: 'partA', isInternalPart: true, ...over.part }),
  };
  StateManager.setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      groups: over.groups ?? s.scene.groups,
      objects,
    },
  }), { silent: true });
  AssetLoader.bindRestoredMesh('partA', mesh('Mug'), 'a1');
  AssetLoader.bindRestoredMesh('partB', mesh('Mug__part1'), 'a1');
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetState();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('selecting an internal split part selects the visible logical object', () => {
  seedLogicalObject();

  Selection.set(['partB'], 'partB');

  assert.deepEqual(Selection.getSelectedIds(), ['partA']);
  assert.equal(Selection.getActiveId(), 'partA');
  assert.deepEqual(Selection.getSelectedResolved().map(r => r.id), ['partA', 'partB']);
});

await test('delete command removes every internal split part for a logical object', () => {
  seedLogicalObject();

  new DeleteCommand(['partA']).execute();

  assert.deepEqual(Object.keys(StateManager.getState().scene.objects), []);
});

await test('duplicate command creates an independent logical split object', () => {
  seedLogicalObject({
    lead: { parentId: 'grp_1' },
    part: { parentId: 'grp_1' },
    groups: { grp_1: { id: 'grp_1', name: 'Shelf', parentId: null, childIds: ['partA', 'partB'] } },
  });

  new DuplicateCommand(['partA']).execute();

  const state = StateManager.getState();
  const clones = Object.values(state.scene.objects).filter(o => !['partA', 'partB'].includes(o.id));
  assert.equal(clones.length, 2, 'lead + internal split part should both be cloned');
  const lead = clones.find(o => !o.isInternalPart);
  const internal = clones.find(o => o.isInternalPart);
  assert.ok(lead, 'duplicated logical object needs a visible lead');
  assert.ok(internal, 'duplicated logical object needs its internal material part');
  assert.equal(lead.logicalObjectId, lead.id);
  assert.equal(internal.logicalObjectId, lead.id);
  assert.equal(internal.sourceGroupId, lead.sourceGroupId);
  assert.notEqual(lead.sourceGroupId, 'sg_mug');
  assert.ok(state.scene.groups.grp_1.childIds.includes(lead.id));
  assert.ok(state.scene.groups.grp_1.childIds.includes(internal.id));
  assert.deepEqual(Selection.getSelectedIds(), [lead.id]);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
