import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { exportRepresentationsHtml, exportRepresentationSummary } = await import('../src/ui/print/ExportTab.js');

test('Export tab lists selected representation and recovery actions for a blocked refinement', () => {
  const state = { scene: { objects: {
    lead: { id: 'lead', name: 'Body', isPrintPart: true, printRefinement: {
      requestedLevel: 1, preview: 'refined', status: 'failed',
    } },
  } } };
  const html = exportRepresentationsHtml(state);
  assert.match(html, /Body/);
  assert.match(html, /Refined.*Level 1/);
  assert.match(html, /data-refinement-action="retry"/);
  assert.match(html, /data-refinement-action="original"/);
});

test('export action summary names original or refined geometry', () => {
  const original = { scene: { objects: {
    lead: { id: 'lead', isPrintPart: true, printRefinement: { preview: 'original' } },
  } } };
  assert.match(exportRepresentationSummary(original), /Original/);
  original.scene.objects.lead.printRefinement.preview = 'refined';
  original.scene.objects.lead.printRefinement.requestedLevel = 2;
  assert.match(exportRepresentationSummary(original), /Refined.*2/);
});
