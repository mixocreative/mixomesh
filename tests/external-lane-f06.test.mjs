// cia F-06: a launch batch parked in its unsaved-changes dialog and an automation request
// share one lane. An API import must not report success into a scene that the user is
// about to replace by answering Discard.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLaunchRunner } from '../src/core/LaunchRequests.js';
import { createDispatcher } from '../src/core/api/ApiDispatcher.js';
import { createExternalLane } from '../src/core/api/ExternalLane.js';

test('API import waits for a launch open that is waiting on the dirty dialog', async () => {
  const lane = createExternalLane();
  const scene = { objects: { old: { id: 'old', name: 'Old', logicalObjectId: 'old' } } };
  const log = [];
  let answerDialog;
  const dialog = new Promise(r => { answerDialog = r; });

  const launch = createLaunchRunner({
    lane,
    storage: { readFile: async ref => ({ name: ref }) },
    openProject: async () => {
      log.push('dialog-open');
      await dialog;                       // user has not answered Save / Discard yet
      scene.objects = { b: { id: 'b', name: 'B', logicalObjectId: 'b' } };
      log.push('project-replaced');
    },
    mountLibrary: async () => {},
    importAssets: async () => {},
    toast: () => {},
    t: k => k,
    isBusy: () => false,
    sleep: async () => {},
  });
  const api = createDispatcher({
    lane,
    state: { getState: () => ({ scene, project: { name: 'P' } }), subscribe: () => () => {} },
    persistence: { isDirty: () => false, hasSaveTarget: () => true },
    importPicked: async () => {
      log.push('api-import');
      scene.objects.n = { id: 'n', name: 'Imported', logicalObjectId: 'n' };
    },
    isBusy: () => false, sleep: async () => {},
  });

  const batch = launch.handle({ id: 1, items: [{ kind: 'project', ref: 'B.mixo', name: 'B.mixo' }], library: null, errors: [] });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(log, ['dialog-open']);

  const imported = api.dispatch('scene.import', { files: [{ ref: 'tok', name: 'part.stl' }] });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(log, ['dialog-open'], 'import must not run while the dialog is open');

  answerDialog('discard');
  await batch;
  const result = await imported;
  assert.deepEqual(log, ['dialog-open', 'project-replaced', 'api-import']);
  assert.deepEqual(result.added.map(o => o.id), ['n']);
  assert.ok(scene.objects.n, 'the reported object is in the scene');
});
