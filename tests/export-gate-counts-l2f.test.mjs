// L2-06: the export warning dialog said "3 object(s)" for one object split in
// three parts, and "more textures than this printer allows" without the limit
// or the printer.
//   node --import ./tests/register-hooks.mjs --test tests/export-gate-counts-l2f.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { exportGateHtml } = await import('../src/ui/PrintPanel.js');
const { StateManager, setState } = await import('../src/core/StateManager.js');

StateManager.replaceState(StateManager.freshState());
setState(s => ({
  ...s,
  scene: {
    ...s.scene,
    objects: {
      lead: { id: 'lead', name: 'mitsumame' },
      p2: { id: 'p2', name: 'mitsumame 2', logicalObjectId: 'lead', isInternalPart: true },
      p3: { id: 'p3', name: 'mitsumame 3', logicalObjectId: 'lead', isInternalPart: true },
    },
  },
  print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' },
}), { silent: true });

const parts = ['lead', 'p2', 'p3'];
const items = html => [...html.matchAll(/<li>([^<]*)<\/li>/g)].map(m => m[1]);

test('one object in three parts counts as one object', () => {
  const [line] = items(exportGateHtml([{ code: 'geometry-warning', severity: 'warning', objectIds: parts }], false));
  assert.match(line, /^1 object/, line);
});

test('the texture-count warning names the limit and the printer', () => {
  const [line] = items(exportGateHtml([{
    code: 'texture-count', severity: 'warning', objectIds: parts,
    data: { maxTexturesPerObject: 1, counts: { lead: 3 } },
  }], false));
  assert.match(line, /^1 object/, line);
  assert.match(line, /Mimaki 3DUJ-553/, line);
  assert.match(line, /\b1 per object\b/, line);
});
