import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { renderRefinementSection } = await import('../src/ui/refinement/RefinementSection.js');
const { setLocale } = await import('../src/i18n/index.js');

const provenance = { origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2 };
const descriptor = { primitiveId: 'p', version: 1, creaseByVertex: [0,0,0], sharpEdges: [] };

test('ordinary GLB has no Mixo or refinement controls', () => {
  assert.equal(renderRefinementSection({ id: 'plain' }), '');
});

test('valid Mixo source shows authored levels and manual choices', () => {
  const html = renderRefinementSection({ id: 'lead', mixoProvenance: provenance, mixoRefinement: [descriptor] });
  assert.match(html, /Mixo 3D/);
  assert.match(html, /Viewport 1/);
  assert.match(html, /Render 2/);
  assert.match(html, /Off — original GLB/);
  assert.match(html, /Level 1/);
  assert.match(html, /Level 2/);
  assert.doesNotMatch(html, /data-action="refine-build"/);
});

test('v1 Mixo without payload asks for re-export and cannot build', () => {
  const html = renderRefinementSection({ id: 'lead', mixoProvenance: provenance });
  assert.match(html, /Re-export from Mixo3D Tools/);
  assert.doesNotMatch(html, /data-action="refine-build"/);
});

test('partial primitive metadata is unavailable before the user starts a build', () => {
  const html = renderRefinementSection(
    { id: 'lead', mixoProvenance: provenance, mixoRefinement: [descriptor],
      printRefinement: { requestedLevel: 1, preview: 'refined', status: 'failed' } }, null, 1,
    { available: false, reason: 'A source part lacks refinement metadata. Re-export from Mixo3D Tools.' },
  );
  assert.match(html, /source part lacks refinement metadata/);
  assert.doesNotMatch(html, /data-action="refine-level"/);
  assert.doesNotMatch(html, /data-action="refine-build"/);
});

test('ready state labels preview choices; failed state announces recovery', () => {
  const base = { id: 'lead', mixoProvenance: provenance, mixoRefinement: [descriptor] };
  const ready = renderRefinementSection({ ...base, printRefinement: { requestedLevel: 1, preview: 'original', status: 'ready', error: null } });
  assert.match(ready, /Preview: Original/);
  assert.match(ready, /Preview: Refined/);
  const failed = renderRefinementSection({ ...base, printRefinement: { requestedLevel: 1, preview: 'original', status: 'failed', error: { code: 'BUILD_FAILED', message: 'bad edge' } } });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Retry/);
  assert.match(failed, /Use original/);
});

test('building state has a labelled progress bar and cancel action', () => {
  const html = renderRefinementSection({
    id: 'lead', mixoProvenance: provenance, mixoRefinement: [descriptor],
    printRefinement: { requestedLevel: 2, preview: 'original', status: 'building', error: null },
  }, { phase: 'Refining', completed: 1, total: 2 });
  assert.match(html, /<progress[^>]*value="1"[^>]*max="2"/);
  assert.match(html, /aria-label="Print refinement progress"/);
  assert.match(html, /data-action="refine-cancel"/);
});

test('refinement controls follow the active UI locale', () => {
  const priorRoot = globalThis.document.documentElement;
  globalThis.document.documentElement = { setAttribute() {} };
  setLocale('zh-Hant');
  try {
    const html = renderRefinementSection({ id: 'lead', mixoProvenance: provenance, mixoRefinement: [descriptor] });
    assert.match(html, /列印細分/);
    assert.match(html, /原始/);
  } finally { setLocale('en'); globalThis.document.documentElement = priorRoot; }
});
