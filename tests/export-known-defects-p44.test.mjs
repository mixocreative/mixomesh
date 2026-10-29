// P4.4: export defects the independent-consumer check (tests/consumers.mjs)
// found. An open single-sided sheet is never folded into a 0 mm^3 "solid" by
// repair; a genuinely holed solid still closes. VRML DEF names stay ASCII and
// unique, and the original name is kept in WorldInfo and a comment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const R = await import('../src/core/repair/MeshRepair.js');
const { vrmlName, encodeVRML } = await import('../src/core/print/WrlWriter.js');

function fakeMesh(name, positions, indices) {
  const data = { position: Float32Array.from(positions), uv: null };
  let idx = Array.from(indices);
  return {
    name, sideOrientation: 1, material: null,
    getVerticesData: (k) => data[k], getIndices: () => idx,
    setVerticesData: (k, v) => { data[k] = Float32Array.from(v); },
    setIndices: (v) => { idx = Array.from(v); },
    createNormals() {}, refreshBoundingInfo() {},
    getTotalVertices: () => data.position.length / 3,
  };
}

// Edges used once = boundary, the honest topology an engine reports.
function honestDiagnose(_V, T) {
  const use = new Map();
  for (const [a, b, c] of T) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    const k = x < y ? `${x}-${y}` : `${y}-${x}`;
    use.set(k, (use.get(k) ?? 0) + 1);
  }
  const boundary = [...use.values()].filter(n => n === 1).length;
  return { boundary, nonManifold: 0, components: 1, isWatertight: boundary === 0 };
}

const QUAD_POS = [0, 0, 0, 50, 0, 0, 50, 50, 0, 0, 50, 0];
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

test('isFoldedSheet: a sheet doubled by its reverse is a fake solid; open sheets and real solids are not', () => {
  const V = [[0, 0, 0], [50, 0, 0], [50, 50, 0], [0, 50, 0]];
  const sheet = [[0, 1, 2], [0, 2, 3]];
  assert.equal(R.isFoldedSheet(V, sheet), false, 'still open: not a fake solid');
  assert.equal(R.isFoldedSheet(V, [...sheet, [0, 2, 1], [0, 3, 2]]), true, 'closed, 0 mm^3');
  const tetraV = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [0, 0, 30]];
  assert.equal(R.isFoldedSheet(tetraV, [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]), false, 'a 1000 mm^3 tetra');
  // A thin but real plate: 50 x 50 x 0.01 mm box.
  const plate = [];
  for (const z of [0, 0.01]) for (const [x, y] of [[0, 0], [50, 0], [50, 50], [0, 50]]) plate.push([x, y, z]);
  const box = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  assert.equal(R.isFoldedSheet(plate, box), false, 'a 0.01 mm plate is still a solid');
});

test('repairMesh keeps an open sheet as it is when the only closure is a folded shell', async () => {
  R.__test.setEngine({
    diagnose: honestDiagnose,
    // What the closing does to a sheet: its reverse laid on top of it.
    repairObject: async (V, T) => ({ V, T: [...T, ...T.map(([a, b, c]) => [a, c, b])], report: { holesFilled: 1 } }),
  });
  try {
    const m = fakeMesh('quad', QUAD_POS, QUAD_IDX);
    const r = await R.repairMesh(m);
    assert.equal(r.changed, false, 'the folded result is discarded');
    assert.equal(r.isWatertight, false, 'reported open, so the export warns (and strictExport refuses)');
    assert.deepEqual(m.getIndices(), QUAD_IDX, 'the sheet is written as it was: 2 facets');
  } finally {
    R.__test.setEngine(null);
  }
});

test('repairMesh still closes a holed solid (open tetra → 1000 mm^3)', async () => {
  R.__test.setEngine({
    diagnose: honestDiagnose,
    repairObject: async (V, T) => ({ V, T: [...T, [1, 2, 3]], report: { holesFilled: 1 } }),
  });
  try {
    const m = fakeMesh('tetra', [0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30], [0, 2, 1, 0, 1, 3, 0, 3, 2]);
    const r = await R.repairMesh(m);
    assert.equal(r.changed, true);
    assert.equal(r.isWatertight, true);
    assert.equal(m.getIndices().length, 12, 'four facets');
  } finally {
    R.__test.setEngine(null);
  }
});

test('vrmlName: ASCII identifiers, non-ASCII escaped by code point, distinct names stay distinct', () => {
  assert.equal(vrmlName('Body part'), 'Body_part');
  assert.equal(vrmlName('猫　モデル'), '_u732B_u3000_u30E2_u30C7_u30EB');
  assert.notEqual(vrmlName('猫'), vrmlName('犬'));
  assert.equal(vrmlName('3d'), '_3d');
  assert.equal(vrmlName(''), 'part');
  assert.match(vrmlName('😀'), /^_u1F600$/);
});

test('encodeVRML keeps each original name in WorldInfo and a comment beside its ASCII DEF', () => {
  const mesh = (name) => ({
    name, material: null,
    getVerticesData: (k) => (k === 'position' ? Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
    getIndices: () => [0, 1, 2],
  });
  const wrl = encodeVRML([{ mesh: mesh('猫　モデル') }, { mesh: mesh('猫　モデル') }, { mesh: mesh('plain') }]);
  assert.match(wrl, /^#VRML V2\.0 utf8\n/);
  assert.match(wrl, /WorldInfo \{ info \[ "_u732B_u3000_u30E2_u30C7_u30EB = 猫　モデル", "_u732B_u3000_u30E2_u30C7_u30EB_2 = 猫　モデル" \] \}/);
  assert.match(wrl, /# 猫　モデル\n {2}DEF _u732B_u3000_u30E2_u30C7_u30EB Shape/);
  assert.match(wrl, /DEF _u732B_u3000_u30E2_u30C7_u30EB_2 Shape/);
  assert.match(wrl, /DEF plain Shape/);
  assert.ok(!/= plain"/.test(wrl), 'a name the DEF already holds is not repeated');
  assert.ok(/DEF [\x21-\x7E]+ Shape/.test(wrl) && !/DEF [^\n]*[^\x00-\x7F][^\n]* Shape/.test(wrl), 'every DEF is ASCII');
});

test('encodeVRML shares a seam position between faces and keeps each corner its own UV', () => {
  // Two triangles meeting at a seam: vertices 2/3 and 1/4 share positions, not UVs.
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 2, 1, 0];
  const uv = [0, 0, 0.5, 0, 0.5, 1, 0.6, 1, 0.6, 0, 1, 1];
  const mesh = {
    name: 'seam', material: { diffuseTexture: {} },
    getVerticesData: (k) => (k === 'position' ? Float32Array.from(pos) : k === 'uv' ? Float32Array.from(uv) : null),
    getIndices: () => [0, 1, 2, 4, 5, 3],
  };
  const wrl = encodeVRML([{ mesh }], new Map([[mesh, 'textures/seam.png']]));
  const points = /coord Coordinate \{ point \[([^\]]*)\]/.exec(wrl)[1].trim().split(/,\s*/);
  assert.equal(points.length, 4, 'six vertices, four distinct positions');
  const tc = /texCoord TextureCoordinate \{ point \[([^\]]*)\]/.exec(wrl)[1].trim().split(/,\s*/);
  assert.equal(tc.length, 6, 'every UV kept');
  const texIdx = /texCoordIndex \[([^\]]*)\]/.exec(wrl)[1].replace(/\s+/g, ' ').trim();
  const coordIdx = /coordIndex \[([^\]]*)\]/.exec(wrl)[1].replace(/\s+/g, ' ').trim();
  assert.notEqual(texIdx, coordIdx, 'UV corners index the UV list, not the shared points');
});
