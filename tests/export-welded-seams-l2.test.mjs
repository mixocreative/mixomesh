// L2-03: textured 3MF/OBJ exports must be closed surfaces. A UV seam splits a
// vertex for its UVs only; the file must share the position and carry the UV
// per corner (3MF texture2dgroup p1-p3, OBJ v/vt), or a slicer counts every
// seam edge as open.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';
import { buildGeometry } from './fixtures/make-midtone-cube.mjs';

installEnv();
const { buildMaterialsExtEntries, buildColorGroupEntries } = await import('../src/core/print/ThreeMFWriter.js');
const { encodeOBJ } = await import('../src/core/print/ObjWriter.js');
const { positionsToPrintSpace } = await import('../src/core/print/PrintSpace.js');
const { setTextureSource } = await import('../src/core/assets/TextureSource.js');

const CUBE = buildGeometry();
setTextureSource('texA', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 48, 32);

function cubeMesh(name, { faces = [0, 1, 2, 3, 4, 5], textured = true, colour = { r: 0.5, g: 0.5, b: 0.5 } } = {}) {
  const indices = faces.flatMap(f => [...CUBE.idx.slice(f * 6, f * 6 + 6)]);
  const texture = { name: 'midtone', metadata: { mixoAssetId: 'texA' } };
  return {
    name,
    material: textured ? { id: `mat-${name}`, diffuseColor: colour, diffuseTexture: texture } : { id: `mat-${name}`, diffuseColor: colour },
    getVerticesData(kind) {
      if (kind === 'uv') return CUBE.uv;
      if (kind === 'position') return CUBE.pos;
      return null;
    },
    getIndices: () => indices,
  };
}

function expectedPositions() {
  const p = positionsToPrintSpace(CUBE.pos);
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    mnx = Math.min(mnx, p[i]); mxx = Math.max(mxx, p[i]);
    mny = Math.min(mny, p[i + 1]); mxy = Math.max(mxy, p[i + 1]);
    mnz = Math.min(mnz, p[i + 2]);
  }
  const out = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i] - (mnx + mxx) / 2, p[i + 1] - (mny + mxy) / 2, p[i + 2] - mnz]);
  return out;
}

function assertClosed(tris, label) {
  const undirected = new Map();
  const directed = new Set();
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
      assert.ok(!directed.has(`${u}>${v}`), `${label}: edge ${u}>${v} used twice in one direction`);
      directed.add(`${u}>${v}`);
    }
  }
  const open = [...undirected.values()].filter(n => n !== 2).length;
  assert.equal(open, 0, `${label}: ${open} edges not shared by exactly two triangles`);
}

const near = (a, b) => a.every((x, k) => Math.abs(x - b[k]) < 1e-4);

function parse3mf(entries) {
  const xml = entries.find(e => e.path === '3D/3dmodel.model').data;
  const objects = [...xml.matchAll(/<object id="(\d+)"[^>]*>(.*?)<\/object>/gs)]
    .filter(m => m[2].includes('<mesh>'))
    .map(m => ({
      vertices: [...m[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(v => [+v[1], +v[2], +v[3]]),
      triangles: [...m[2].matchAll(/<triangle ([^>]*)\/>/g)].map(t => Object.fromEntries([...t[1].matchAll(/(\w+)="([^"]+)"/g)].map(a => [a[1], +a[2] || a[2]]))),
    }));
  const coords = [...xml.matchAll(/<m:tex2coord u="([^"]+)" v="([^"]+)"\/>/g)].map(c => [+c[1], +c[2]]);
  return { xml, objects, coords };
}

test('textured 3MF: one vertex per position, UVs per corner, closed surface', async () => {
  const { objects, coords } = parse3mf(await buildMaterialsExtEntries([{ mesh: cubeMesh('cube') }]));
  assert.equal(objects.length, 1);
  const [{ vertices, triangles }] = objects;
  assert.equal(vertices.length, 8, 'seam duplicates share one vertex record');
  assert.equal(triangles.length, 12);
  assertClosed(triangles.map(t => [t.v1, t.v2, t.v3]), 'textured 3MF');
  const expected = expectedPositions();
  for (const t of triangles) {
    for (const [v, p] of [[t.v1, t.p1], [t.v2, t.p2], [t.v3, t.p3]]) {
      assert.ok(near(vertices[v], expected[p]), `corner uv ${p} kept its position`);
      assert.ok(near(coords[p], [CUBE.uv[p * 2], CUBE.uv[p * 2 + 1]]), `corner uv ${p} kept its coordinate`);
    }
  }
});

test('solid 3MF object of several material parts is welded across its parts', () => {
  const unit = { logicalId: 'o1', name: 'two-tone', meshes: [
    { mesh: cubeMesh('a', { faces: [0, 1, 2], textured: false, colour: { r: 1, g: 0, b: 0 } }) },
    { mesh: cubeMesh('b', { faces: [3, 4, 5], textured: false, colour: { r: 0, g: 0, b: 1 } }) },
  ] };
  const { objects } = parse3mf(buildColorGroupEntries([unit]));
  assert.equal(objects.length, 1);
  assert.equal(objects[0].vertices.length, 8);
  assertClosed(objects[0].triangles.map(t => [t.v1, t.v2, t.v3]), 'two-part colorgroup');
  assert.deepEqual(new Set(objects[0].triangles.map(t => t.p1)), new Set([0, 1]), 'each part keeps its colour');
});

test('Bambu flavour parts are welded too', async () => {
  const { objects } = parse3mf(await buildMaterialsExtEntries([{ mesh: cubeMesh('cube') }], { flavour: 'bambu' }));
  assert.equal(objects.length, 1);
  assert.equal(objects[0].vertices.length, 8);
  assertClosed(objects[0].triangles.map(t => [t.v1, t.v2, t.v3]), 'bambu part');
});

test('textured OBJ: shared v, per-corner vt, closed surface', () => {
  const text = encodeOBJ([{ mesh: cubeMesh('cube') }], { axis: 'z-up' });
  const v = [...text.matchAll(/^v (\S+) (\S+) (\S+)$/gm)].map(m => [+m[1], +m[2], +m[3]]);
  const vt = [...text.matchAll(/^vt (\S+) (\S+)$/gm)].map(m => [+m[1], +m[2]]);
  const faces = [...text.matchAll(/^f (.+)$/gm)].map(m => m[1].split(' ').map(c => c.split('/').map(Number)));
  assert.equal(v.length, 8, 'seam duplicates share one v');
  assert.equal(vt.length, 24, 'every corner keeps its own vt');
  assertClosed(faces.map(f => f.map(c => c[0])), 'textured OBJ');
  const raw = positionsToPrintSpace(CUBE.pos);
  for (const f of faces) {
    for (const [vi, ti] of f) {
      const p = ti - 1;
      assert.ok(near(v[vi - 1], [raw[p * 3], raw[p * 3 + 1], raw[p * 3 + 2]]), `vt ${ti} kept its position`);
    }
  }
});
