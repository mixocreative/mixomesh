// Export: progress, dimensions, download, PLY/WRL, OBJ axis
//
// Cut out of tests/export.test.mjs on 2026-11-14; the harness is
// ./export-kit.mjs. `report()` below asserts this file's case count -- see that file
// for why, and change the number in the same commit as any case you add or remove.

import assert from 'node:assert/strict';
import {
  MeshValidator, PrintManager, StateManager, _clones, calls, mesh, obj, objTexts, rejects,
  report, resetCalls, setScene, test, toasts, valOK, zipInstances,
} from './export-kit.mjs';

// ── Pipeline: progress reporting ─────────────────────────

await test('progress callback runs monotonically and reaches 1.0', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  const seen = [];
  await PrintManager.exportOBJ({ onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 3, `expected several ticks, got ${seen.length}`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1] - 1e-9, `non-monotonic at ${i}: ${seen[i - 1]}→${seen[i]}`);
  }
  assert.equal(seen.at(-1), 1, 'ends at 100%');
});

await test('progress is NOT advanced past collect when there are no meshes', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  const seen = [];
  await rejects(PrintManager.exportOBJ({ onProgress: (f) => seen.push(f) }), /No printable meshes/);
  assert.ok(seen.every(f => f < 0.1), 'no prep/serialize progress before the guard');
});

// ── getExportedDimensions ────────────────────────────────

await test('getExportedDimensions: factor = workingRatio/targetRatio*1000', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [2, 3, 4] }) },
    workingRatio: 12, targetRatio: 35 });
  const d = PrintManager.getExportedDimensions('m1');
  const f = (12 / 35) * 1000;
  assert.ok(Math.abs(d.x - 2 * f) < 1e-6 && Math.abs(d.y - 3 * f) < 1e-6 && Math.abs(d.z - 4 * f) < 1e-6);
});

await test('getExportedDimensions: 1:1 → raw size × 1000', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [1, 1, 1] }) } });
  const d = PrintManager.getExportedDimensions('m1');
  assert.deepEqual([d.x, d.y, d.z], [1000, 1000, 1000]);
});

await test('getExportedDimensions: missing mesh → null', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: {} });
  assert.equal(PrintManager.getExportedDimensions('m1'), null);
  assert.equal(PrintManager.getExportedDimensions('nope'), null);
});

// ── Download.js FSA failure handling (task 0.2) ──────────

await test('triggerDownload: FSA write failure aborts the writable, toasts, falls back to anchor', async () => {
  const { triggerDownload } = await import('../src/core/print/Download.js');
  let aborted = 0;
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async () => { throw new DOMException('denied', 'SecurityError'); },
      close: async () => {}, abort: async () => { aborted++; },
    }),
  });
  resetCalls(); toasts.length = 0;
  try { assert.equal(await triggerDownload({ type: 'text/plain' }, 'a.txt'), true); }
  finally { window.showSaveFilePicker = undefined; }
  assert.equal(aborted, 1, 'writable aborted');
  assert.equal(calls.downloads.length, 1, 'anchor fallback ran');
  assert.ok(toasts.some(x => x.type === 'warning' && /denied/.test(x.msg)), 'user told about the failure');
});

await test('triggerDownload: picker AbortError (user cancel) stays silent, returns false, no fallback', async () => {
  const { triggerDownload } = await import('../src/core/print/Download.js');
  window.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
  resetCalls(); toasts.length = 0;
  try { assert.equal(await triggerDownload({ type: 'text/plain' }, 'a.txt'), false); }
  finally { window.showSaveFilePicker = undefined; }
  assert.equal(toasts.length, 0, 'no toast');
  assert.equal(calls.downloads.length, 0, 'no anchor download');
});

// ── PLY + WRL (task 1.6) ─────────────────────────────────

const { deflateSync } = await import('node:zlib');
const { setTextureSource } = await import('../src/core/assets/TextureSource.js');

// Minimal 8-bit RGBA PNG (filter 0 rows) — real bytes, decoded by PlyWriter.
function pngRGBA(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 2×2 texture, image order (top row first): red, green / blue, white.
const PLY_TEX_ID = 'ply-tex-asset';
setTextureSource(PLY_TEX_ID, new Blob([pngRGBA(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])]), 2, 2);

function texturedMesh(name, uv = [0.25, 0.75, 0.75, 0.25, 0.5, 0.5]) {
  const m = mesh(name);
  m.material = { id: `mat-${name}`, diffuseColor: { r: 1, g: 1, b: 1 },
    diffuseTexture: { name: 'chk', metadata: { mixoAssetId: PLY_TEX_ID } } };
  m.getVerticesData = (k) => k === 'uv' ? new Float32Array(uv) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const oc = m.clone;
  m.clone = (n) => { const c = oc.call(m, n); c.material = m.material; c.getVerticesData = m.getVerticesData; return c; };
  return m;
}

function parsePly(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = new TextDecoder('latin1').decode(u8);
  const end = text.indexOf('end_header\n') + 'end_header\n'.length;
  const header = text.slice(0, end);
  const nV = Number(/element vertex (\d+)/.exec(header)[1]);
  const nF = Number(/element face (\d+)/.exec(header)[1]);
  const textured = /property float s\n/.test(header);
  const stride = 28 + (textured ? 8 : 0);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const verts = [];
  for (let i = 0; i < nV; i++) {
    const o = end + i * stride;
    verts.push({
      pos: [0, 1, 2].map(k => view.getFloat32(o + k * 4, true)),
      rgba: [u8[o + 24], u8[o + 25], u8[o + 26], u8[o + 27]],
      st: textured ? [view.getFloat32(o + 28, true), view.getFloat32(o + 32, true)] : null,
    });
  }
  const faces = [];
  let o = end + nV * stride;
  for (let i = 0; i < nF; i++) {
    const n = u8[o];
    faces.push(Array.from({ length: n }, (_, k) => view.getInt32(o + 1 + k * 4, true)));
    o += 1 + n * 4;
  }
  return { header, nV, nF, verts, faces, trailing: u8.length - o };
}

await test('PLY: combined export → `${project}${suffix}.ply`, no CSG re-bake', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.ply');
  assert.equal(calls.csgFrom.length, 0, 'PLY keeps colour/UVs — never CSG re-baked');
  assert.equal(_clones[0].__worldBaked, true, 'world + mm baked like every other writer');
});

await test('PLY: binary LE header, vertex count, PrintSpace position, solid sRGB colour', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_m1_r1to1.ply']);
  assert.match(ply.header, /^ply\nformat binary_little_endian 1\.0\n/);
  assert.match(ply.header, /property float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n/);
  assert.match(ply.header, /property list uchar int vertex_indices\nend_header\n$/);
  assert.doesNotMatch(ply.header, /property float s/, 'solid-only file carries no s/t');
  assert.equal(ply.nV, 3);
  assert.equal(ply.nF, 1);
  assert.equal(ply.trailing, 0, 'byte length matches the header exactly');
  // Babylon (1,0,0) → print (-1,0,0); Babylon (0,1,0) → print (0,0,1) (Y-up → Z-up).
  assert.deepEqual(ply.verts[1].pos, [-1, 0, 0]);
  assert.deepEqual(ply.verts[2].pos, [0, 0, 1]);
  for (const v of ply.verts) assert.deepEqual(v.rgba, [255, 0, 0, 255]);
  assert.deepEqual(ply.faces[0], [0, 1, 2], 'CounterClockWise mesh written as-is (PrintSpace.printIndices)');
});

await test('PLY: ClockWise-flagged (glTF) mesh → face reversed, same as STL/3MF', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { side: 0 }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_m1_r1to1.ply']);
  assert.deepEqual(ply.faces[0], [0, 2, 1]);
});

await test('PLY: textured mesh → s/t props + BILINEAR texture colour at each vertex UV', async () => {
  setScene({ objects: { t1: obj('t1') }, registry: { t1: texturedMesh('t1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_t1_r1to1.ply']);
  assert.match(ply.header, /property uchar alpha\nproperty float s\nproperty float t\n/);
  assert.equal(ply.trailing, 0);
  assert.deepEqual(ply.verts[0].rgba, [255, 0, 0, 255], 'uv (0.25,0.75) = top-left texel centre (bottom-left UV origin)');
  assert.deepEqual(ply.verts[1].rgba, [255, 255, 255, 255], 'uv (0.75,0.25) = bottom-right texel centre');
  assert.deepEqual(ply.verts[2].rgba, [128, 128, 128, 255], 'uv (0.5,0.5) = bilinear blend of all four texels');
  assert.deepEqual(ply.verts[0].st, [0.25, 0.75]);
});

await test('PLY: multi-object combined export merges into ONE file with offset indices', async () => {
  setScene({ objects: { a: obj('a'), b: obj('b') },
    registry: { a: mesh('a', { color: { r: 0, g: 0, b: 1 } }), b: texturedMesh('b') } });
  MeshValidator.validateMesh = valOK;
  let captured = null;
  window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { captured = d; }, close: async () => {} }) });
  try { await PrintManager.exportPLY(); } finally { window.showSaveFilePicker = undefined; }
  assert.ok(captured, 'PLY blob written');
  const ply = parsePly(new Uint8Array(await captured.arrayBuffer()));
  assert.equal(ply.nV, 6);
  assert.equal(ply.nF, 2);
  assert.deepEqual(ply.faces[1], [3, 4, 5], 'second mesh indices offset by the first mesh vertex count');
  assert.deepEqual(ply.verts[0].rgba, [0, 0, 255, 255], 'solid part keeps its material colour');
  assert.deepEqual(ply.verts[0].st, [0, 0], 'untextured vertex in a textured file gets s/t = 0');
  assert.deepEqual(ply.verts[3].rgba, [255, 0, 0, 255], 'textured part sampled');
});

await test('WRL: textured export → zip with .wrl + packaged PNG; ImageTexture url matches the entry', async () => {
  setScene({ objects: { t1: obj('t1') }, registry: { t1: texturedMesh('t1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportWRL();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1_wrl.zip');
  assert.equal(calls.csgFrom.length, 0, 'WRL keeps UVs — never CSG re-baked');
  const files = zipInstances.at(-1).files;
  const wrl = files['Test_r1to1.wrl'];
  assert.ok(wrl, 'combined .wrl entry');
  assert.match(wrl, /^#VRML V2\.0 utf8\n/);
  assert.match(wrl, /IndexedFaceSet \{/);
  assert.match(wrl, /coordIndex \[\s*0 1 2 -1\s*\]/);
  assert.match(wrl, /texCoordIndex \[\s*0 1 2 -1\s*\]/);
  assert.match(wrl, /TextureCoordinate \{ point \[\s*0\.25 0\.75,/);
  assert.match(wrl, /-1 0 0,\s*0 0 1\s*\]/, 'coords pass through PrintSpace (Z-up mm)');
  const url = /ImageTexture \{ url "([^"]+)" \}/.exec(wrl)?.[1];
  assert.equal(url, 'textures/t1_baseColor.png', 'Decision 17: <object>_<slot>.png');
  assert.ok(files[url], 'the referenced PNG is packaged at exactly that path');
});

await test('WRL: solid-only export → single .wrl with Material diffuseColor', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportWRL();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.wrl');
  await PrintManager.exportWRL({ individually: true });
  const wrl = zipInstances.at(-1).files['Test_m1_r1to1.wrl'];
  assert.match(wrl, /Material \{ diffuseColor 1 0 0 transparency 0 \}/);
  assert.doesNotMatch(wrl, /ImageTexture|texCoord/);
});

// ── OBJ axis (task 1.7: OBJ through PrintSpace + per-printer axis) ──────

const { encodeOBJ, resolveObjAxis } = await import('../src/core/print/ObjWriter.js');
const { signedVolume } = await import('../src/core/print/PrintSpace.js');

// Asymmetric tetra as the app holds it after a glTF import (see
// tests/print-space.test.mjs): Babylon xyz, ClockWise-flagged, outward.
// glTF source vertices (0,0,0) (10,0,0) (0,20,0) (0,0,30): +Y (20 mm) is up.
const TETRA_POS = [0, 0, 0, -10, 0, 0, 0, 20, 0, 0, 0, 30];
const TETRA_IDX = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
const tetraMesh = (side = 0) => ({
  name: 'tet', sideOrientation: side, material: { id: 'm' },
  getIndices: () => TETRA_IDX,
  getVerticesData: (k) => (k === 'position' ? TETRA_POS : k === 'uv' ? [0, 0, 1, 0, 0, 1, 1, 1] : null),
});
const parseObj = (text) => {
  const pos = [], idx = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') pos.push(+p[1], +p[2], +p[3]);
    if (p[0] === 'f') idx.push(...p.slice(1).map(c => parseInt(c, 10) - 1));
  }
  return { pos, idx };
};
// The map Babylon's OBJExport.OBJ applied before 1.7 (left-handed scene,
// node_modules/@babylonjs/serializers/OBJ/objSerializer.js): v = (-x, y, z);
// faces reversed when the effective side orientation is ClockWise.
const legacyBabylonObj = (pos, idx, side) => {
  const p = [];
  for (let i = 0; i < pos.length; i += 3) p.push(-pos[i], pos[i + 1], pos[i + 2]);
  const f = [];
  for (let i = 0; i < idx.length; i += 3) f.push(...(side === 0 ? [idx[i], idx[i + 2], idx[i + 1]] : [idx[i], idx[i + 1], idx[i + 2]]));
  return { pos: p, idx: f };
};

await test('OBJ axis: y-up output is geometrically identical to the pre-1.7 Babylon OBJExport output (positions + winding)', () => {
  for (const side of [0, 1]) {
    const got = parseObj(encodeOBJ([{ mesh: tetraMesh(side) }], { axis: 'y-up' }));
    const legacy = legacyBabylonObj(TETRA_POS, TETRA_IDX, side);
    assert.deepEqual(got.pos.map(v => v + 0), legacy.pos.map(v => v + 0), `positions side=${side}`);
    assert.deepEqual(got.idx, legacy.idx, `winding side=${side}`);
  }
});

await test('OBJ axis: known vertex — glTF apex (0,20,0) is +Y in y-up and +Z in z-up; x not mirrored', () => {
  const y = parseObj(encodeOBJ([{ mesh: tetraMesh() }], { axis: 'y-up' })).pos;
  const z = parseObj(encodeOBJ([{ mesh: tetraMesh() }], { axis: 'z-up' })).pos;
  assert.deepEqual(y.slice(6, 9).map(v => v + 0), [0, 20, 0], 'y-up apex');
  assert.deepEqual(z.slice(6, 9).map(v => v + 0), [0, 0, 20], 'z-up apex (matches STL/3MF/PLY)');
  assert.deepEqual(y.slice(3, 6).map(v => v + 0), [10, 0, 0], 'y-up x extent +10 (glTF source x)');
  assert.deepEqual(z.slice(3, 6).map(v => v + 0), [10, 0, 0], 'z-up x extent +10');
  assert.deepEqual(y.slice(9, 12).map(v => v + 0), [0, 0, 30], 'y-up: glTF +Z stays +Z');
  assert.deepEqual(z.slice(9, 12).map(v => v + 0), [0, -30, 0], 'z-up: glTF +Z → -Y (PrintSpace)');
});

await test('OBJ axis: both axis options are outward (signed volume +1000 mm³) for glTF- and native-flagged meshes', () => {
  for (const axis of ['y-up', 'z-up']) {
    const gltf = parseObj(encodeOBJ([{ mesh: tetraMesh(0) }], { axis }));
    const vol = signedVolume(gltf.pos, gltf.idx);
    assert.ok(Math.abs(vol - 1000) < 1e-6, `${axis} glTF: expected +1000, got ${vol}`);
    // Babylon-native outward fixture: negative raw volume, CounterClockWise flag.
    const nIdx = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    const native = { name: 'n', sideOrientation: 1, material: { id: 'm' }, getIndices: () => nIdx,
      getVerticesData: (k) => (k === 'position' ? TETRA_POS : null) };
    const { pos, idx } = parseObj(encodeOBJ([{ mesh: native }], { axis }));
    assert.ok(signedVolume(pos, idx) > 0, `${axis} native: outward`);
  }
});

await test('OBJ axis: face corners reference v/vt and normals are rotated with positions', () => {
  const m = tetraMesh();
  m.getVerticesData = (k) => (k === 'position' ? TETRA_POS : k === 'normal' ? [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
    : k === 'uv' ? [0, 0, 1, 0, 0, 1, 1, 1] : null);
  const y = encodeOBJ([{ mesh: m }], { axis: 'y-up', mtllib: 'T' });
  const z = encodeOBJ([{ mesh: m }], { axis: 'z-up', mtllib: 'T' });
  assert.match(y, /^mtllib T\.mtl$/m);
  assert.match(y, /^usemtl m$/m);
  assert.match(y, /^vn 0 1 0$/m, 'Babylon +Y normal stays +Y in y-up');
  assert.match(z, /^vn 0 0 1$/m, 'Babylon +Y normal is +Z in z-up');
  assert.match(y, /^vt 1 1$/m, 'UVs written raw');
  assert.match(y, /^f 1\/1\/1 3\/3\/3 2\/2\/2$/m, 'v/vt/vn corners, ClockWise mesh reversed');
});

await test('OBJ axis: resolveObjAxis — ctx.prefs.objAxis wins, then printer profile, then y-up', () => {
  assert.equal(resolveObjAxis({ prefs: { objAxis: 'z-up' }, state: { print: { targetPrinterId: 'mimaki-3duj-553' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'mimaki-3duj-553' } } }), 'y-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'bambu-x1c' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: { objAxis: 'sideways' }, state: { print: { targetPrinterId: 'bambu-x1c' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'no-such-printer' } } }), 'y-up', 'unknown printer → Mimaki default profile');
});

await test('OBJ axis: pipeline export for the default Mimaki target writes Y-up', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.match(objTexts()[0], /^# mixomesh export: millimetres, right-handed, Y-up$/m);
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
  zipInstances.length = 0;
  await PrintManager.exportOBJ();
  assert.match(objTexts()[0], /^# mixomesh export: millimetres, right-handed, Z-up$/m);
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
});

// ── MX-05: one call, five formats, five distinct files ───
//
// `exportBaseName` is format-blind by construction (project name + scale suffix), and five writers
// returned `${exportBaseName(ctx)}.zip`: ObjWriter, PlyWriter, StlWriter, WrlWriter (twice) and the
// per-part outer bundle in PrintPipeline. So ANY two bundling formats in one `export.run` call
// wrote the same name — the audit caught it with obj + wrl, but it was never about those two. The
// only refusal left was ApiServer's "duplicate export file name", which names the symptom.
await test('MX-05: collectExportFiles with all five formats returns five distinct filenames', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  const res = await PrintManager.collectExportFiles(['obj', 'stl', 'ply', 'wrl', '3mf'], { acknowledgeWarnings: true });
  assert.equal(res.blocked, false, `expected files, got ${JSON.stringify(res)}`);
  const names = res.files.map(f => f.name);
  assert.equal(names.length, 5, names.join());
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 5, `five formats must write five files, got ${names.join()}`);
  // Each bundle says which format it is; the single-file formats already did, by extension.
  // (WRL only bundles when it has textures to package — this scene is solid colour, so it is a
  // bare .wrl here, which is exactly why distinctness is the assertion that matters.)
  assert.ok(names.includes('Test_r1to1_obj.zip'), names.join());
  for (const n of names.filter(x => x.endsWith('.zip'))) {
    assert.match(n, /_(obj|stl|ply|wrl|3mf)\.zip$/, `a bundle must name its format: ${n}`);
  }
});

// The refusal that is left if a future writer forgets its format token: it must name the two
// formats and the file, which "duplicate export file name" downstream never could.
await test('MX-05: a name collision is refused by its cause — both formats and the file', async () => {
  const { nameCollision } = (await import('../src/core/print/PrintPipeline.js')).__test;
  assert.equal(nameCollision([['obj', 'A_obj.zip'], ['wrl', 'A_wrl.zip']]), null);
  const msg = nameCollision([['obj', 'A_r1to1.zip'], ['wrl', 'A_R1TO1.ZIP']]);
  assert.ok(msg, 'a case-insensitive collision must be caught — the file systems that matter are');
  assert.match(msg, /obj/, msg);
  assert.match(msg, /wrl/, msg);
  assert.match(msg, /A_R1TO1\.ZIP/, msg);
});

report(22, 'export: progress, dimensions, download, PLY/WRL, OBJ axis');
