// The vendored mixo geometry engine (port step A1, docs/support-generation-port.md):
// it loads, reports the host's engine version, and the version gate refuses a
// mismatch. `vendor-geometry.mjs --check` keeps the committed bytes honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  HOST_GEOMETRY_VERSION, GeometryVersionMismatch, assertGeometryVersion,
} from '../vendor/mixo-geocore/host/geometryVersion.js';
import { loadGeometryEngine, GEOMETRY_VENDOR_DIR, GEOMETRY_GLUE, GEOMETRY_WASM } from '../src/support-engine/loadGeometry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'public', GEOMETRY_VENDOR_DIR);

test('vendored engine loads and matches HOST_GEOMETRY_VERSION', async () => {
  const engine = await loadGeometryEngine(pathToFileURL(join(DIR, GEOMETRY_GLUE)).href, readFileSync(join(DIR, GEOMETRY_WASM)));
  assert.equal(engine.engine_version(), HOST_GEOMETRY_VERSION);
  assert.equal(readFileSync(join(DIR, 'VERSION'), 'utf8').trim(), String(HOST_GEOMETRY_VERSION));
  // A session round-trips a mesh handle: the ABI is live, not only the version call.
  const session = new engine.GeometrySession(1 << 24);
  try {
    const handle = session.load_mesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
    assert.equal(typeof handle, 'number');
    session.release_mesh(handle);
  } finally {
    session.free();
  }
});

test('version gate refuses any other engine_version', () => {
  assert.doesNotThrow(() => assertGeometryVersion(HOST_GEOMETRY_VERSION));
  for (const other of [HOST_GEOMETRY_VERSION - 1, HOST_GEOMETRY_VERSION + 1]) {
    assert.throws(() => assertGeometryVersion(other), err => err instanceof GeometryVersionMismatch
      && err.code === 'geometry-version-mismatch' && err.actual === other);
  }
});

test('committed engine files match SOURCE.json', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'vendor-geometry.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
