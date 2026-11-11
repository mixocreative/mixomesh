/*
 * THE EXPORTED BYTES, READ BY SOMETHING THAT IS NOT THE WRITER.
 *
 * Ported from mixodental's `src/supports/exportBytes.test.ts` (three-repo plan §5.3, audit MX-06).
 * The product's one deliverable is the file a slicer opens, and `npm test` — the only gate CI runs —
 * proves that file against itself: `tests/print-space.test.mjs` reads the STL back with the app's own
 * `signedVolume`, and every 3MF node test asserts on `tests/jszip-stub.mjs`'s in-memory name→content
 * map, which never produces a zip. Both show the two halves agree with each other. A reflection in
 * the write, or an archive no unzipper can open, passes them.
 *
 * So this file imports the SUBJECTS — `encodeBinarySTL`, `buildColorGroupEntries` — and nothing of
 * ours that parses or measures geometry. The reader below is written from the binary-STL format
 * alone; the properties are restated from geometry (the divergence theorem for volume,
 * directed-edge counting for winding); and the 3MF goes through the REAL jszip, reached by file URL
 * because `tests/hooks.mjs` swaps the bare `jszip` specifier for the stub process-wide.
 *
 * `npm run test:consumers` remains the stronger, occasional instrument: PrusaSlicer and python
 * trimesh / pymeshlab over all five formats. This is the one that runs on every change.
 *
 * DEBT, recorded in the plan's §6: the STL reader now exists in both apps, and is retired when the
 * export test moves into mixo-geocore (plan item C1). Until then, two copies beat a CI proof that
 * waits on a 51-version re-vendor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const { encodeBinarySTL } = await import('../src/core/print/StlWriter.js');
const { buildColorGroupEntries } = await import('../src/core/print/ThreeMFWriter.js');
// The REAL jszip. `tests/hooks.mjs` short-circuits the bare specifier to a stub for the whole run;
// a file URL is not that specifier, so this is the library a user's unzipper behaves like.
const { default: JSZip } = await import(new URL('../node_modules/jszip/lib/index.js', import.meta.url).href);

// ── a reader written from the format, not from the writer ──

/** Binary STL parsed from the spec: 80-byte header, u32 LE count, then 50 bytes per facet. */
function readBinaryStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const facets = [];
  let offset = 84;
  while (offset + 50 <= bytes.byteLength) {
    const at = byte => view.getFloat32(offset + byte, true);
    facets.push({
      normal: [at(0), at(4), at(8)],
      vertices: [[at(12), at(16), at(20)], [at(24), at(28), at(32)], [at(36), at(40), at(44)]],
      attributes: view.getUint16(offset + 48, true),
    });
    offset += 50;
  }
  return { declared: view.getUint32(80, true), facets, bytesLeftOver: bytes.byteLength - offset };
}

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Signed volume by the divergence theorem: the sum of a · (b × c) / 6 over the facets. Positive when
 * the normals point outward, NEGATIVE when the solid was written inside out — the one failure a
 * round trip through our own reader cannot see, because both halves would mirror together.
 */
const signedVolume = facets =>
  facets.reduce((sum, { vertices: [a, b, c] }) => sum + dot(a, cross(b, c)) / 6, 0);

/** The facet's own outward normal, from its three vertices. */
function geometricNormal(v) {
  const n = cross(minus(v[1], v[0]), minus(v[2], v[0]));
  const length = Math.hypot(...n) || 1;
  return n.map(c => c / length);
}

/**
 * Edges not traversed exactly once in each direction. A closed, consistently wound surface has none:
 * every edge is shared by two facets that walk it in opposite directions.
 */
function windingProblems(facets) {
  const key = v => v.map(n => Math.round(n * 1e4)).join(',');
  const directed = new Map();
  for (const { vertices } of facets) {
    for (let i = 0; i < 3; i++) {
      const edge = `${key(vertices[i])}|${key(vertices[(i + 1) % 3])}`;
      directed.set(edge, (directed.get(edge) ?? 0) + 1);
    }
  }
  const problems = [];
  for (const [edge, count] of directed) {
    const [from, to] = edge.split('|');
    const back = directed.get(`${to}|${from}`) ?? 0;
    if (count !== 1 || back !== 1) problems.push(`${edge} forward ${count}, back ${back}`);
  }
  return problems;
}

function bounds(facets) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { vertices } of facets) {
    for (const v of vertices) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
  }
  return { lo, hi };
}

// ── the fixture, proved before it is trusted ──

/*
 * A 4 mm cube as the app holds it in BABYLON space: Y-up, left-handed, and wound the way a native
 * Babylon mesh is (default CounterClockWise side orientation). Its right-handed signed volume is
 * therefore NEGATIVE (-64) — Babylon's own convention, pinned in print-space.test.mjs — and the
 * Babylon→print map, which is a reflection, is what turns it positive in the file. So "+64 in the
 * file" is a real claim about the writer, not a tautology.
 */
const CUBE_POS = [0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4, 0, 4, 0, 4, 4, 0, 4, 4, 4, 0, 4, 4];
const CUBE_IDX = [
  0, 2, 1, 0, 3, 2,   // -y
  4, 5, 6, 4, 6, 7,   // +y
  0, 5, 4, 0, 1, 5,   // -z
  3, 6, 2, 3, 7, 6,   // +z
  0, 7, 3, 0, 4, 7,   // -x
  1, 6, 5, 1, 2, 6,   // +x
];

/** Duck-typed Babylon mesh: exactly what the writers read off a real one. */
const cube = (name = 'cube', offsetX = 0) => ({
  name,
  sideOrientation: 1,   // CounterClockWise — a native Babylon mesh, never a glTF import
  material: { diffuseColor: { r: 0.6, g: 0.4, b: 0.2 } },
  getVerticesData: kind => (kind === 'position'
    ? Float32Array.from(CUBE_POS.map((v, i) => (i % 3 === 0 ? v + offsetX : v)))
    : null),
  getIndices: () => CUBE_IDX,
});

const facetsOf = (pos, idx) => {
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    out.push({ vertices: [0, 1, 2].map(k => [0, 1, 2].map(a => pos[idx[t + k] * 3 + a])) });
  }
  return out;
};

test('the fixture is a closed cube the oracle agrees on, before it judges the writer', () => {
  const facets = facetsOf(CUBE_POS, CUBE_IDX);
  assert.equal(facets.length, 12);
  assert.equal(windingProblems(facets).length, 0);
  // Babylon-native-outward: NEGATIVE in the right-handed formula. The writer's reflection flips it.
  assert.ok(signedVolume(facets) < 0, `expected a negative Babylon volume, got ${signedVolume(facets)}`);
  assert.ok(Math.abs(Math.abs(signedVolume(facets)) - 64) < 1e-6);
});

test('STL: declares the facets it actually wrote, with no bytes left over', () => {
  const file = readBinaryStl(encodeBinarySTL([{ mesh: cube() }], 'cube'));
  assert.equal(file.declared, 12);
  assert.equal(file.facets.length, file.declared);
  // 84 + 50n exactly: a short count leaves a tail, a long one reads past the end.
  assert.equal(file.bytesLeftOver, 0);
  for (const f of file.facets) assert.equal(f.attributes, 0);
});

test('STL: the solid stands on z = 0 and rises in +z, which Babylon (y up) is not', () => {
  const { lo, hi } = bounds(readBinaryStl(encodeBinarySTL([{ mesh: cube() }], 'cube')).facets);
  // Ground truth for this map is tests/fixtures/prusa-tetra.3mf, read by trimesh in 2026-09-17:
  // Babylon (x, y, z) leaves as (-x, -z, y). Restated here, never imported.
  assert.ok(Math.abs(lo[2]) < 1e-6 && Math.abs(hi[2] - 4) < 1e-6, `z ${lo[2]}..${hi[2]}`);
  assert.deepEqual([lo[0] + 0, hi[0] + 0], [-4, 0]);
  assert.deepEqual([lo[1] + 0, hi[1] + 0], [-4, 0]);
});

test('STL: written outward, not inside out, with every edge shared once each way', () => {
  const file = readBinaryStl(encodeBinarySTL([{ mesh: cube() }], 'cube'));
  assert.deepEqual(windingProblems(file.facets), []);
  assert.ok(Math.abs(signedVolume(file.facets) - 64) < 1e-4, `volume ${signedVolume(file.facets)}`);
});

test('STL: each stored normal agrees with the three vertices beside it', () => {
  const file = readBinaryStl(encodeBinarySTL([{ mesh: cube() }], 'cube'));
  // NOTE this is weaker here than in mixodental: stlEncode.js computes the same (b-a)×(c-a) this
  // oracle does, so it cannot catch a wrong FORMULA — only a normal written against the wrong
  // vertices, i.e. an off-by-one in the 50-byte record. Volume above is the property that matters.
  for (const [i, facet] of file.facets.entries()) {
    const want = geometricNormal(facet.vertices);
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(facet.normal[a] - want[a]) < 1e-5,
        `facet ${i} axis ${a}: stored ${facet.normal} vs geometry ${want}`);
    }
  }
});

test('STL: two parts in one file keep both properties', () => {
  const file = readBinaryStl(encodeBinarySTL([{ mesh: cube('a') }, { mesh: cube('b', 20) }], 'pair'));
  assert.equal(file.declared, 24);
  assert.equal(file.bytesLeftOver, 0);
  // Two disjoint closed solids: volumes add, and no edge is shared between them.
  assert.ok(Math.abs(signedVolume(file.facets) - 128) < 1e-4, `volume ${signedVolume(file.facets)}`);
  assert.deepEqual(windingProblems(file.facets), []);
});

test('STL: this would catch a reflected export — otherwise it proves nothing', () => {
  // A guard nobody has watched fail is a guard nobody has. The fault this file exists for is a
  // REFLECTION in the write: the model arrives mirrored and hollow, and a round trip through our own
  // reader cannot see it because both halves mirror together.
  const file = readBinaryStl(encodeBinarySTL([{ mesh: cube() }], 'cube'));
  const mirrored = file.facets.map(({ normal, vertices }) => ({ normal, vertices: vertices.map(([x, y, z]) => [-x, y, z]) }));
  assert.ok(Math.abs(signedVolume(mirrored) + 64) < 1e-4, `mirrored volume ${signedVolume(mirrored)}`);
  // And this is why signed volume is the property that matters: edge counting is BLIND to a mirror,
  // because the vertices are still visited in the same order. Winding alone would pass it.
  assert.deepEqual(windingProblems(mirrored), []);
});

// ── 3MF: a real archive, opened by the real library ──

test('3MF: the real jszip produces an archive the real jszip can open (not the stub)', async () => {
  const entries = buildColorGroupEntries([{ meshId: 'cube', logicalId: 'u', name: 'cube', mesh: cube() }], {});
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.data);
  const bytes = await zip.generateAsync({ type: 'uint8array', mimeType: 'model/3mf' });

  // The stub returns `{ __fakeZip: true, names: [...] }` from generateAsync. If the resolver hook
  // ever reaches this import, these two lines are what says so.
  assert.ok(bytes instanceof Uint8Array, `expected real bytes, got ${Object.prototype.toString.call(bytes)}`);
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b], 'a zip starts "PK"');

  const opened = await JSZip.loadAsync(bytes);
  const paths = Object.keys(opened.files).sort();
  // OPC minimum: a 3MF with any of these missing is not openable by a slicer.
  for (const required of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) {
    assert.ok(paths.includes(required), `${required} missing from ${paths.join(', ')}`);
  }
  const model = await opened.file('3D/3dmodel.model').async('string');
  // Read with a regex, not our loader: counts restated from the fixture, not from the writer.
  assert.equal((model.match(/<vertex /g) ?? []).length, 8);
  assert.equal((model.match(/<triangle /g) ?? []).length, 12);
  assert.match(model, /unit="millimeter"/);
});
