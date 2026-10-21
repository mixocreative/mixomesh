// Re-review minors 1-3: export independent of the view toggle; derived meshes faceted; per-user toggle wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installEnv } from './env.mjs';

installEnv();
const FS = await import('../src/core/scene/FlatShading.js');

test('export decides by the mesh, never by the Smooth shading view setting', () => {
  const mesh = { metadata: { flatShading: true } };
  FS.setSmooth(true);
  assert.equal(FS.isFaceted(mesh), true, 'faceted mesh stays faceted for export with Smooth on');
  assert.equal(FS.wantsFlat(mesh), false, 'but renders smooth');
  FS.setSmooth(false);
  const obj = readFileSync(new URL('../src/core/print/ObjWriter.js', import.meta.url), 'utf8');
  assert.match(obj, /isFaceted\(mesh\) \? null/);
  assert.doesNotMatch(obj, /wantsFlat|isSmooth/);
});

test('Boolean results (new and restored) get the faceted flag', () => {
  const bool = readFileSync(new URL('../src/core/commands/BooleanCommands.js', import.meta.url), 'utf8');
  assert.match(bool, /markFlat\(result\);\s*\n\s*const \{ assetId, meshId \} = await AssetLoader\.registerBakedResult/);
  const restore = readFileSync(new URL('../src/core/assets/AssetRestore.js', import.meta.url), 'utf8');
  assert.match(restore, /markFlat\(mesh\);\s+\/\/ restored Boolean result/);
});

test('Smooth shading is per-user: never saved in a project, never taken from one', async () => {
  const { _projectOverlays } = await import('../src/core/persist/ProjectSerializer.js');
  assert.deepEqual(_projectOverlays({ grid: true, smoothShading: true }), { grid: true });
  const loader = readFileSync(new URL('../src/core/persist/ProjectLoader.js', import.meta.url), 'utf8');
  assert.match(loader, /smoothShading: !!s\.scene\.overlays\?\.smoothShading/);
});

test('a cancelled export is not logged as a failure', () => {
  const pipe = readFileSync(new URL('../src/core/print/PrintPipeline.js', import.meta.url), 'utf8');
  assert.match(pipe, /err\?\.name !== 'AbortError'\) console\.error\(`\$\{fmt\.label\} export failed:`/);
});
