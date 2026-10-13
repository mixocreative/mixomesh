// Selection accepts group ids (overhaul task 2.1). Run:
//   node --import ./tests/register-hooks.mjs --test tests/selection-groups.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { EVENTS } = await import('../src/core/events.js');

const visuals = { attached: [] };
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
SceneManager.attachToSelection = (meshes) => { visuals.attached = meshes; };

const meshes = new Map();
const groupNodes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;
SceneManager.getScene = () => ({ transformNodes: [...groupNodes.values()] });

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}

function group(id, childIds, over = {}) {
  return { id, name: id, parentId: null, childIds, visible: true, locked: false, ...over };
}

function reset() {
  StateManager.replaceState(StateManager.freshState());
  meshes.clear();
  groupNodes.clear();
  visuals.attached = [];
  const objects = {
    a: obj('a', { parentId: 'g1' }),
    b: obj('b', { parentId: 'g1' }),
    c: obj('c'),
    // Logical object: lead `lead`, hidden material part `lead.part`.
    lead: obj('lead', { logicalObjectId: 'lead' }),
    'lead.part': obj('lead.part', { logicalObjectId: 'lead', isInternalPart: true }),
    ghost: obj('ghost', { isGhost: true }),
  };
  const groups = {
    g1: group('g1', ['a', 'b']),
    g2: group('g2', ['g1'], {}),
    gNoNode: group('gNoNode', []),
  };
  for (const id of Object.keys(objects)) meshes.set(id, { name: id, kind: 'mesh' });
  meshes.delete('ghost');
  groupNodes.set('g1', { name: 'g1', metadata: { groupId: 'g1' } });
  groupNodes.set('g2', { name: 'g2', metadata: { groupId: 'g2' } });
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: [], activeId: null },
    scene: { ...s.scene, objects, groups },
  }), { silent: true });
}

test('set() accepts a group id without expanding it into children', () => {
  reset();
  Selection.set(['g1']);
  assert.deepEqual(Selection.getSelectedIds(), ['g1']);
  assert.equal(Selection.getActiveId(), 'g1');
  assert.equal(Selection.contains('g1'), true);
  assert.equal(Selection.contains('a'), false);
});

test('add() and toggle() accept group ids', () => {
  reset();
  Selection.add('g1');
  assert.deepEqual(Selection.getSelectedIds(), ['g1']);
  Selection.add('g2');
  assert.deepEqual(Selection.getSelectedIds(), ['g1', 'g2']);
  assert.equal(Selection.getActiveId(), 'g2');
  Selection.toggle('g1');
  assert.deepEqual(Selection.getSelectedIds(), ['g2']);
  Selection.toggle('g1');
  assert.deepEqual(Selection.getSelectedIds(), ['g2', 'g1']);
  assert.equal(Selection.getActiveId(), 'g1');
  Selection.remove('g2');
  assert.deepEqual(Selection.getSelectedIds(), ['g1']);
});

test('mixed object + group selection; getSelectedNodes reports kinds', () => {
  reset();
  Selection.set(['c', 'g1', 'lead.part'], 'g1');
  assert.deepEqual(Selection.getSelectedIds(), ['c', 'g1', 'lead']);
  assert.equal(Selection.getActiveId(), 'g1');
  const nodes = Selection.getSelectedNodes();
  assert.deepEqual(nodes.map(n => [n.id, n.kind]), [
    ['c', 'object'], ['g1', 'group'], ['lead', 'object'],
  ]);
  assert.equal(nodes[1].node, groupNodes.get('g1'));
  assert.equal(nodes[0].node, meshes.get('c'));
});

test('getSelectedResolved() stays object-only with logical-part expansion', () => {
  reset();
  Selection.set(['c', 'g1', 'lead']);
  assert.deepEqual(Selection.getSelectedResolved().map(r => r.id), ['c', 'lead', 'lead.part']);
  assert.ok(Selection.getSelectedResolved().every(r => r.mesh && r.mesh.kind === 'mesh'));
  // Task 2.2: the pivot receives the group NODE too (rigid group transform).
  assert.deepEqual(visuals.attached.map(m => m.name), ['c', 'g1', 'lead', 'lead.part']);
});

test('unknown ids and ghosts are ignored', () => {
  reset();
  Selection.set(['nope', 'g1', 'ghost']);
  assert.deepEqual(Selection.getSelectedIds(), ['g1']);
  Selection.add('nope');
  Selection.toggle('also-nope');
  assert.deepEqual(Selection.getSelectedIds(), ['g1']);
  Selection.setActive('nope');
  assert.equal(Selection.getActiveId(), 'g1');
});

test('group without a live node stays selected but is skipped by getSelectedNodes', () => {
  reset();
  Selection.set(['gNoNode', 'c']);
  assert.deepEqual(Selection.getSelectedIds(), ['gNoNode', 'c']);
  assert.deepEqual(Selection.getSelectedNodes().map(n => n.id), ['c']);
});

test('active id can be a group; events keep their shape', () => {
  reset();
  const seen = [];
  const offSel = StateManager.subscribe(EVENTS.SELECTION_CHANGED, p => seen.push(['sel', p]));
  const offAct = StateManager.subscribe(EVENTS.ACTIVE_OBJECT_CHANGED, p => seen.push(['act', p]));
  try {
    Selection.set(['c', 'g1'], 'c');
    Selection.setActive('g1');
    assert.equal(Selection.getActiveId(), 'g1');
    assert.deepEqual(seen, [
      ['sel', { selectedIds: ['c', 'g1'], activeId: 'c' }],
      ['act', { activeId: 'c' }],
      ['act', { activeId: 'g1' }],
    ]);
  } finally {
    offSel?.();
    offAct?.();
  }
});
