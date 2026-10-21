// cia F-04: project.open / project.new with confirm:true over unsaved work must keep the
// work marked unsaved when the open fails, so closing the window still warns.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher } from '../src/core/api/ApiDispatcher.js';

function setup({ readFile, openPicked, newProject } = {}) {
  let dirty = true;
  const d = createDispatcher({
    state: { getState: () => ({ scene: { objects: {} }, project: { name: 'P' } }), subscribe: () => () => {} },
    persistence: {
      isDirty: () => dirty,
      discardChanges: () => { dirty = false; return () => { dirty = true; }; },
      openPicked: openPicked ?? (async () => { dirty = false; }),
      newProject: newProject ?? (async () => { dirty = false; }),
      hasSaveTarget: () => true,
    },
    readFile: readFile ?? (async () => ({ text: async () => '{}' })),
    isBusy: () => false, sleep: async () => {},
  });
  return { d, isDirty: () => dirty };
}

const file = { ref: 'ref_x', name: 'other.mixo' };
const codeOf = p => p.then(() => 'ok', e => e?.data?.code ?? String(e));

test('open of an unreadable file keeps the unsaved work dirty', async () => {
  const s = setup({ readFile: async () => null });
  assert.equal(await codeOf(s.d.dispatch('project.open', { file, confirm: true })), 'E_NOT_FOUND');
  assert.equal(s.isDirty(), true);
});

test('open of a corrupt project keeps the unsaved work dirty', async () => {
  const s = setup({ openPicked: async () => { throw new Error('Not a .mixo file or the file is corrupt'); } });
  assert.equal(await codeOf(s.d.dispatch('project.open', { file, confirm: true })), 'E_INTERNAL');
  assert.equal(s.isDirty(), true);
});

test('a failed project.new keeps the unsaved work dirty', async () => {
  const s = setup({ newProject: async () => { throw new Error('import in flight'); } });
  assert.notEqual(await codeOf(s.d.dispatch('project.new', { confirm: true })), 'ok');
  assert.equal(s.isDirty(), true);
});

test('a successful open replaces the work and reads clean', async () => {
  const s = setup();
  assert.equal(await codeOf(s.d.dispatch('project.open', { file, confirm: true })), 'ok');
  assert.equal(s.isDirty(), false);
});
