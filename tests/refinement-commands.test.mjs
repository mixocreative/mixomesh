import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const State = await import('../src/core/StateManager.js');
const History = await import('../src/core/HistoryManager.js');
const { RefinementController, refinementAffectedIds, installRefinementSubscriptions } = await import('../src/core/refinement/RefinementController.js');
const { EVENTS } = await import('../src/core/events.js');

function reset() {
  History.clear();
  State.setState(s => ({ ...s, scene: { ...s.scene, objects: {
    lead: { id: 'lead', name: 'Mixo object', mixoProvenance: { origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2 }, mixoRefinement: [{ primitiveId: 'p', version: 1, creaseByVertex: new Float32Array(3), sharpEdges: new Uint32Array() }] },
  } } }), { silent: true });
}

function sourceMesh(isVisible = true) {
  return {
    id: 'lead', metadata: { mixoPrimitiveId: 'p' }, isVisible,
    getTotalVertices: () => 3,
    getVerticesData: kind => kind === 'position' ? [0,0,0,1,0,0,0,1,0] : null,
    getIndices: () => [0,1,2],
  };
}

test('manual setting starts Off/original/idle and is undoable', () => {
  reset();
  assert.deepEqual(History.refinementSetting(State.getState().scene.objects.lead), { requestedLevel: 0, preview: 'original', status: 'idle', error: null });
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 1 }));
  assert.equal(State.getState().scene.objects.lead.printRefinement.requestedLevel, 1);
  History.undo();
  assert.equal(History.refinementSetting(State.getState().scene.objects.lead).requestedLevel, 0);
  History.redo();
  assert.equal(State.getState().scene.objects.lead.printRefinement.requestedLevel, 1);
});

test('selecting a level never starts a worker job', () => {
  reset();
  let started = 0;
  const controller = RefinementController.create({ refine: async () => { started++; }, sourceMeshes: () => [] });
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 2 }));
  assert.equal(started, 0);
  controller.dispose();
});

test('cancel and failure preserve original preview, retry starts a new job', async () => {
  reset();
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 1 }));
  let calls = 0;
  const controller = RefinementController.create({
    sourceMeshes: () => [sourceMesh()],
    refine: async () => { calls++; throw new Error('test failure'); }, validate: async () => [],
  });
  await controller.build('lead');
  assert.equal(State.getState().scene.objects.lead.printRefinement.status, 'failed');
  assert.equal(State.getState().scene.objects.lead.printRefinement.preview, 'original');
  await controller.build('lead');
  assert.equal(calls, 2);
  controller.dispose();
});

test('size-limit failure gives a usable lower-level recovery hint', async () => {
  reset();
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 2 }));
  const controller = RefinementController.create({
    sourceMeshes: () => [sourceMesh()],
    refine: async () => { throw new Error('refinement size limit exceeded'); },
  });
  await controller.build('lead');
  assert.match(State.getState().scene.objects.lead.printRefinement.error.message, /lower level/i);
  controller.dispose();
});

test('ready preview switches original and derived without exposing a hidden source', async () => {
  reset();
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 1 }));
  const source = sourceMesh(false);
  const derived = { isVisible: false, dispose() { this.disposed = true; } };
  const controller = RefinementController.create({ sourceMeshes: () => [source], refine: async () => ({ geometries: [{}] }), derive: () => [derived], validate: async () => [] });
  assert.equal(await controller.build('lead'), true);
  assert.equal(derived.isVisible, false);
  History.push(new History.SetPrintRefinementCommand('lead', { preview: 'refined' }));
  controller.syncPreview('lead');
  assert.equal(source.isVisible, false);
  assert.equal(derived.isVisible, false, 'a hidden source stays hidden in refined preview');
  controller.cancel('lead');
  assert.equal(source.isVisible, false);
  assert.equal(derived.disposed, true);
  controller.dispose();
});

test('a cancelled late worker result is discarded after project reopen', async () => {
  reset();
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 1 }));
  let finish;
  const source = sourceMesh();
  const controller = RefinementController.create({ sourceMeshes: () => [source], refine: () => new Promise(resolve => { finish = resolve; }), derive: () => { throw new Error('stale result used'); }, validate: async () => [] });
  const pending = controller.build('lead');
  controller.dispose();
  finish({ geometry: {} });
  assert.equal(await pending, false);
});

test('undo cannot restore ready status when the refined cache is absent', () => {
  reset();
  const controller = RefinementController.create();
  const unsubscribe = installRefinementSubscriptions(controller);
  State.setState(s => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects,
    lead: { ...s.scene.objects.lead, printRefinement: { requestedLevel: 1, preview: 'original', status: 'ready', error: null } },
  } } }), { silent: true });
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 2 }));
  assert.equal(State.getState().scene.objects.lead.printRefinement.status, 'stale');
  History.undo();
  assert.equal(State.getState().scene.objects.lead.printRefinement.requestedLevel, 1);
  assert.equal(State.getState().scene.objects.lead.printRefinement.status, 'stale');
  unsubscribe();
  controller.dispose();
});

test('transform arrays and asset relinks invalidate their logical-object leads', () => {
  const objects = {
    lead: { id: 'lead', assetId: 'asset-a' },
    sibling: { id: 'sibling', logicalObjectId: 'lead', assetId: 'asset-a' },
    other: { id: 'other', assetId: 'asset-b' },
  };
  assert.deepEqual(refinementAffectedIds({ meshIds: ['sibling'] }, objects), ['lead']);
  assert.deepEqual(refinementAffectedIds({ assetId: 'asset-a' }, objects), ['lead']);
});

test('visibility event hides a previously visible refined preview', async () => {
  reset();
  History.push(new History.SetPrintRefinementCommand('lead', { requestedLevel: 1 }));
  const source = sourceMesh();
  const derived = { isVisible: false, dispose() {} };
  const controller = RefinementController.create({
    sourceMeshes: () => [source], refine: async () => ({ geometries: [{}] }),
    derive: () => [derived], validate: async () => [],
  });
  const unsubscribe = installRefinementSubscriptions(controller);
  try {
    assert.equal(await controller.build('lead'), true);
    History.push(new History.SetPrintRefinementCommand('lead', { preview: 'refined' }));
    assert.equal(derived.isVisible, true);
    State.setState(s => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects,
      lead: { ...s.scene.objects.lead, visible: false },
    } } }), { silent: true });
    State.dispatch(EVENTS.VISIBILITY_CHANGED, { meshId: 'lead', visible: false });
    assert.equal(derived.isVisible, false);
  } finally { unsubscribe(); controller.dispose(); }
});
