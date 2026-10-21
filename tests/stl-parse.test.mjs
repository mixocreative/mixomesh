import test from 'node:test';
import assert from 'node:assert/strict';
import { weldPositions, creaseNormals } from '../src/core/import/weld.js';
import { parseStl, isBinaryStl } from '../src/core/import/stlParse.js';
import { binaryStlChunks, asciiStlChunks, pillowTriangles } from '../scripts/heavy-mesh/generate.mjs';

const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

test('weld: shared corners share one index; −0 equals +0; order of first use kept', () => {
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, /**/ 1, 0, 0, -0, 1, 0, 1, 1, 0]);
  const { positions, indices } = weldPositions(soup);
  assert.deepEqual([...indices], [0, 1, 2, 1, 2, 3]);
  assert.deepEqual([...positions], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
});

test('weld: survives table growth on many unique points', () => {
  const n = 50_000;
  const soup = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { soup[i * 3] = i; soup[i * 3 + 1] = i * 0.5; soup[i * 3 + 2] = -i; }
  const { positions, indices } = weldPositions(soup.slice());
  assert.equal(positions.length, n * 3);
  assert.equal(indices[n - 1], n - 1);
});

function cubeSoup() {
  const v = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[2,3,7],[2,7,6],[1,2,6],[1,6,5],[0,4,7],[0,7,3]];
  return new Float32Array(faces.flatMap(f => f.flatMap(i => v[i])));
}

test('crease normals: a cube splits to 24 vertices with axis-aligned normals', () => {
  const welded = weldPositions(cubeSoup());
  assert.equal(welded.positions.length / 3, 8);
  const { positions, normals, indices } = creaseNormals(welded.positions, welded.indices);
  assert.equal(positions.length / 3, 24);
  for (let i = 0; i < normals.length; i += 3) {
    const axes = [normals[i], normals[i + 1], normals[i + 2]].map(Math.abs).sort();
    assert.ok(axes[2] > 0.999 && axes[1] < 1e-6, `normal ${i / 3} not axis aligned`);
  }
  assert.equal(indices.length, 36);
});

function sphereSoup(seg = 40, rings = 20) {
  const p = (i, j) => {
    const th = (i / seg) * 2 * Math.PI, ph = (j / rings) * Math.PI;
    return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
  };
  const out = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
      if (j > 0) out.push(...a, ...c, ...b);
      if (j < rings - 1) out.push(...a, ...d, ...c);
    }
  }
  return new Float32Array(out);
}

test('crease normals: a smooth sphere stays welded and normals point outward', () => {
  const welded = weldPositions(sphereSoup());
  const before = welded.positions.length / 3;
  const { positions, normals } = creaseNormals(welded.positions, welded.indices);
  // Only the seam duplicates (i = 0 vs i = seg are equal after rounding) may differ; no crease splits.
  assert.equal(positions.length / 3, before);
  for (let v = 0; v < positions.length / 3; v++) {
    const d = positions[v * 3] * normals[v * 3] + positions[v * 3 + 1] * normals[v * 3 + 1] + positions[v * 3 + 2] * normals[v * 3 + 2];
    assert.ok(Math.abs(Math.abs(d) - 1) < 0.02, `vertex ${v} normal not radial (${d})`);
  }
});

test('parseStl binary: Babylon axis swap and corner order, normals point like the file normals', () => {
  const n = 6;
  const bytes = u8(Buffer.concat([...binaryStlChunks(n)]));
  assert.equal(isBinaryStl(bytes), true);
  const [mesh] = parseStl(bytes);
  assert.equal(mesh.name, 'stlmesh');
  assert.equal(mesh.indices.length, 4 * n * n * 3);
  const tris = [...pillowTriangles(n)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let t = 0; t < tris.length; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[t * 3 + k];
      const [x, y, z] = tris[t].slice(k * 3, k * 3 + 3).map(Math.fround);
      assert.deepEqual([mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]], [x, z, y]);
    }
    // File normal (nx, ny, nz) → Babylon (nx, nz, ny); the vertex normals agree in sign.
    const o = 84 + t * 50;
    const fnb = [view.getFloat32(o, true), view.getFloat32(o + 8, true), view.getFloat32(o + 4, true)];
    const vi = mesh.indices[t * 3];
    const dot = fnb[0] * mesh.normals[vi * 3] + fnb[1] * mesh.normals[vi * 3 + 1] + fnb[2] * mesh.normals[vi * 3 + 2];
    assert.ok(dot > 0, `triangle ${t} normal flipped`);
  }
});

test('parseStl ASCII: solid name, same geometry as binary, multiple solids', () => {
  const ascii = Buffer.from([...asciiStlChunks(5)].join(''));
  assert.equal(isBinaryStl(u8(ascii)), false);
  const [a] = parseStl(u8(ascii));
  const [b] = parseStl(u8(Buffer.concat([...binaryStlChunks(5)])));
  assert.equal(a.name, 'heavy');
  assert.equal(a.indices.length, b.indices.length);
  assert.equal(a.positions.length, b.positions.length);
  const two = Buffer.from('solid one\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid one\nsolid\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n');
  assert.deepEqual(parseStl(u8(two)).map(m => m.name), ['one', 'stlmesh']);
});

test('parseStl reports staged progress up to 1', () => {
  const stages = [];
  parseStl(u8(Buffer.concat([...binaryStlChunks(8)])), { onProgress: e => stages.push(e) });
  assert.deepEqual([...new Set(stages.map(s => s.stage))], ['parse', 'weld', 'normals']);
  assert.equal(stages.at(-1).fraction, 1);
  assert.ok(stages.every((s, i) => i === 0 || s.fraction >= stages[i - 1].fraction));
});

test('crease split: a zero-area face first at a vertex does not switch the split off', () => {
  // Vertex 0 shared by a degenerate face, an XY face and an XZ face (90° apart).
  const P = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const first = creaseNormals(P, new Uint32Array([0, 1, 1, 0, 1, 2, 0, 3, 1]));
  const last = creaseNormals(P, new Uint32Array([0, 1, 2, 0, 3, 1, 0, 1, 1]));
  assert.equal(first.positions.length / 3, last.positions.length / 3, 'order of faces must not matter');
  assert.equal(last.positions.length / 3, 6, 'vertices 0 and 1 split across the 90° edge');
});
