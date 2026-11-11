/*
 * MX-04: the strict-export control's scope is the scope its label claims.
 *
 *   node --import ./tests/register-hooks.mjs --test tests/export-gate-supports-mx04.test.mjs
 *
 * The audit found the strict gate iterating model clones only while the exported file also
 * carries support clones, and offered two fixes: widen the check, or narrow the label.
 *
 * MEASURED before choosing (tests/fixtures/support-plain-cube.glb, real engine, headless Chrome,
 * 2026-11-12): the support export build is 25528 facets with 0 boundary edges, 5410 NON-MANIFOLD
 * edges and 226 zero-area facets — a CLOSED, interpenetrating union of pillars and raft with
 * positive signed volume. It slices correctly (tests/consumers.mjs asserts `supports.outward`,
 * never `supports.watertight`, and allows the slicer to drop the zero-area facets), and it will
 * never be watertight because nothing booleans the pillars into one manifold. A watertight gate
 * over supports would therefore refuse EVERY strict export that includes them. The label was what
 * was wrong, so the label is what changed.
 *
 * These two tests pin the two halves of that answer so neither rots in silence:
 *   1. the label promises MODEL parts, and a help line says what it leaves out;
 *   2. MeshValidator returns nothing at all for a support-layer mesh (D20) — which is WHY the
 *      validation half of the promise cannot be widened either, even though the pipeline now
 *      hands the whole file to it. If D20 ever changes, this fails and the label must be revisited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installEnv } from './env.mjs';

installEnv();

const locale = (lang) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
const LANGS = ['en', 'ja', 'zh-Hant'];

test('the strict-export label promises model parts, and a help line names what it leaves out', () => {
  for (const lang of LANGS) {
    const dict = locale(lang);
    assert.ok(dict['print.strictExport'], `${lang} is missing print.strictExport`);
    assert.ok(
      dict['print.strictExportSupports'],
      `${lang} is missing print.strictExportSupports — the control must say that supports are not covered`,
    );
  }
  const en = locale('en');
  assert.match(en['print.strictExport'], /model part/i,
    'the label must scope itself to model parts: supports in the same file are not watertight-checked');
  assert.match(en['print.strictExportSupports'], /support/i,
    'the help line must name supports, the parts the gate does not cover');
});

test('MeshValidator declines a support-layer mesh outright (D20) — the reason the label is narrow', async () => {
  const { MeshValidator } = await import('../src/core/MeshValidator.js');
  const { tagSupportLayer } = await import('../src/supports/layers/supportLayerTag.js');

  // A closed tetrahedron: real geometry, so an empty result can only come from the D20 branch and
  // never from "there was nothing to look at".
  const mesh = tagSupportLayer({
    name: 'Cube supports__export',
    getVerticesData: (kind = 'position') => (kind === 'position'
      ? new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01]) : undefined),
    getIndices: () => [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
    getWorldMatrix: () => ({}),
    getBoundingInfo: () => ({ boundingBox: {
      minimumWorld: { x: 0, y: 0, z: 0, subtract: (o) => ({ x: -o.x, y: -o.y, z: -o.z }) },
      maximumWorld: { x: 0.01, y: 0.01, z: 0.01, subtract: () => ({ x: 0.01, y: 0.01, z: 0.01 }) },
    } }),
    intersects: () => ({ hit: false }),
    getTotalVertices: () => 4,
  }, 'export', 'u1');

  assert.deepEqual(await MeshValidator.validateMesh(mesh), [],
    'D20: support-layer meshes are invisible to every content walk, MeshValidator included');
});
