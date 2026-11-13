// Export: STL and 3MF
//
// Cut out of tests/export.test.mjs on 2026-11-14; the harness is
// ./export-kit.mjs. `report()` below asserts this file's case count -- see that file
// for why, and change the number in the same commit as any case you add or remove.

import assert from 'node:assert/strict';
import {
  MeshValidator, PrintManager, StateManager, Toast, _clones, calls, mesh, obj, rejects, report,
  setScene, stlInfo, test, toasts, valErrAlways, valOK, zipInstances,
} from './export-kit.mjs';

// ── STL ──────────────────────────────────────────────────

await test('STL: CSG2 unavailable → exports without re-bake, warns', async () => {
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();
    assert.equal(calls.downloads.length, 1, 'STL still produced');
    assert.equal(calls.csgFrom.length, 0, 'no CSG2 re-bake');
    assert.ok(toasts.some(t => t.type === 'warning' && /CSG2 unavailable/.test(t.msg)), 'warned');
  } finally {
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
});

await test('STL: CSG2 available → re-bakes every mesh then exports', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') }, registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.equal(calls.csgFrom.length, 2, 'CSG2 re-bake per mesh');
  assert.equal(calls.vdApply.length, 2, 'baked geometry applied back');
  assert.equal(calls.downloads.length, 1, 'one combined STL');
  assert.ok(_clones.every(c => c.__optimized && c.__normals), 'optimize + normals on clones');
});

await test('STL: non-watertight mesh (CSG2 rejects) → skips quietly, still exports + info toast', async () => {
  const B = globalThis.window.BABYLON;
  const savedFrom = B.CSG2.FromMesh;
  B.CSG2.FromMesh = () => { throw new Error('Error while creating the CSG: Not manifold'); };
  try {
    setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
      registry: { m1: mesh('m1'), m2: mesh('m2') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();                 // must NOT throw
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.ok(toasts.some(t => t.type === 'info' && /not watertight/.test(t.msg)),
      'one summarized info toast');
  } finally {
    B.CSG2.FromMesh = savedFrom;
  }
});

await test('STL: empty scene → throws', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportSTL(), /No printable meshes/);
});

await test('STL: error surviving auto-fix → blocks with list', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrAlways;
  await assert.rejects(PrintManager.exportSTL(), (err) => {
    assert.ok(err.validationErrors?.length === 1);
    return true;
  });
  assert.equal(calls.downloads.length, 0);
});

await test('STL: individually → one STL call per mesh + outer zip of N parts', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2'), m3: obj('m3') },
    registry: { m1: mesh('m1'), m2: mesh('m2'), m3: mesh('m3') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true });
  // Outer zip contains the three .stl entries named `${project}_${mesh}_r{w}to{t}.stl`,
  // each a real little-endian binary STL (StlWriter, not the Babylon serializer).
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to1.stl'], 'project+mesh+ratio in name');
  assert.ok(outer['Test_m2_r1to1.stl']);
  assert.ok(outer['Test_m3_r1to1.stl']);
  for (const key of ['Test_m1_r1to1.stl', 'Test_m2_r1to1.stl', 'Test_m3_r1to1.stl']) {
    const info = stlInfo(outer[key]);
    assert.equal(info.tris, 1, `${key}: one triangle, little-endian count`);
    assert.notEqual(info.trisBE, 1, `${key}: count is NOT big-endian (regression: Babylon CreateSTL isLittleEndian=false)`);
    assert.equal(info.bytes, 84 + 50, `${key}: 80-byte header + count + 50 bytes/facet`);
  }
  assert.equal(calls.downloads.at(-1), 'Test_r1to1_stl.zip',
    'outer zip uses project+ratio+format default filename (MX-05)');
});

await test('STL: individually + selectedOnly → only selected mesh in outer zip', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, selectedIds: ['m2'] });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true, selectedOnly: true });
  assert.equal(Object.keys(zipInstances.at(-1).files).length, 1, 'only the selected mesh exported');
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m2_r1to1.stl']);
  assert.ok(!outer['Test_m1_r1to1.stl'], 'unselected mesh excluded');
});

// ── 3MF ──────────────────────────────────────────────────

await test('3MF: empty scene → throws', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportThreeMF(), /No printable meshes/);
});

await test('prep step throws → export ABORTS (no raw-BU file with a success toast)', async () => {
  const m = mesh('m1');
  const origClone = m.clone;
  m.clone = (...a) => {
    const c = origClone.apply(m, a);
    c.optimizeIndices = () => { throw new Error('buffer not updatable'); };
    return c;
  };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /Export prep "optimizeIndices" failed for "m1__export"/);
  assert.equal(calls.downloads.length, 0, 'nothing downloaded');
  assert.ok(!toasts.some(t => t.type === 'success'), 'no success toast');
  assert.equal(_clones[0].__disposed, true, 'clone disposed after abort');
});

await test('save picker cancelled → "cancelled" info toast, NO success toast, batch stops', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 1 }, { kind: 'ratio', value: 2 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  let pickerCalls = 0;
  window.showSaveFilePicker = async () => { pickerCalls++; throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  try {
    await PrintManager.exportOBJ();
  } finally {
    window.showSaveFilePicker = undefined;
  }
  assert.equal(pickerCalls, 1, 'second ratio target not re-prompted after a cancel');
  assert.equal(calls.downloads.length, 0, 'no anchor fallback on cancel');
  assert.ok(!toasts.some(t => t.type === 'success'), 'cancel must not read as "✓ Exported"');
  assert.ok(toasts.some(t => t.type === 'info' && /cancel/i.test(t.msg)), 'cancel is surfaced');
});

await test('zip entries whose paths collide (case-insensitive) are suffixed, never overwritten', async () => {
  setScene({ objects: { a: obj('a', { name: 'Cube' }), b: obj('b', { name: 'cube' }) },
    registry: { a: mesh('Cube'), b: mesh('cube') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const files = zipInstances.at(-1).files;
  assert.ok(files['Test_Cube_r1to1.obj'] && files['Test_Cube_r1to1.mtl'], 'first part kept');
  assert.ok(files['Test_cube_r1to1_2.obj'] && files['Test_cube_r1to1_2.mtl'], 'second part suffixed, not dropped');
  assert.equal(Object.keys(files).length, 4, 'both parts present');
});


await test('OBJ/MTL: material ids with spaces become single tokens in BOTH files; no Tr line; Kd clamped', async () => {
  const m = mesh('m1', { color: { r: 1.5, g: -0.2, b: 0.5 } });
  m.material = { id: 'Base Color 01', diffuseColor: { r: 1.5, g: -0.2, b: 0.5 } };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.match(files['Test_r1to1.obj'], /^usemtl Base_Color_01$/m, 'usemtl is one token');
  assert.match(files['Test_r1to1.mtl'], /^newmtl Base_Color_01$/m, 'newmtl matches usemtl');
  assert.match(files['Test_r1to1.mtl'], /^Kd 1\.0000 0\.0000 0\.5000$/m, 'Kd clamped to [0,1]');
  assert.match(files['Test_r1to1.mtl'], /^d 1\.0000$/m);
  assert.ok(!/^Tr /m.test(files['Test_r1to1.mtl']), 'no ambiguous Tr line');
});


await test('prep leaves a part with zero triangles → export ABORTS (M4), not a silent drop', async () => {
  const m = mesh('m1');
  const origClone = m.clone;
  m.clone = (...a) => { const c = origClone.apply(m, a); c.getIndices = () => []; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /Part "m1" has no triangles after preparation/);
  assert.equal(calls.downloads.length, 0);
});

await test('readiness: missing or stale validation cache → validation-pending warning (M3), fresh cache → none', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: {} } }), { silent: true });
  let r = PrintManager.getPrintReadiness();
  assert.ok(r.issues.some(i => i.code === 'validation-pending'), 'no cache = pending');
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: { m1: { results: [], stale: true, validatedAt: 1 } } } }), { silent: true });
  r = PrintManager.getPrintReadiness();
  assert.ok(r.issues.some(i => i.code === 'validation-pending'), 'stale cache = pending');
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: { m1: { results: [], stale: false, validatedAt: 1 } } } }), { silent: true });
  r = PrintManager.getPrintReadiness();
  assert.ok(!r.issues.some(i => i.code === 'validation-pending'), 'fresh cache = not pending');
  assert.equal(r.canExport, true, 'pending is a warning, not a block');
});

await test('batch export uses ONE state snapshot (M8): a rename between pickers does not change file 2', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 1 }, { kind: 'ratio', value: 2 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  let n = 0;
  window.showSaveFilePicker = async () => {
    n++;
    if (n === 1) StateManager.setState(s => ({ ...s, project: { ...s.project, name: 'Renamed' } }), { silent: true });
    return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
  };
  const names = [];
  const origShow = Toast.show;
  Toast.show = (msg, type) => { toasts.push({ msg, type }); if (type === 'success') names.push(msg); };
  try { await PrintManager.exportOBJ(); } finally { window.showSaveFilePicker = undefined; Toast.show = origShow; }
  assert.equal(names.length, 2, 'two files written');
  assert.ok(names.every(m => /Test_/.test(m) && !/Renamed/.test(m)), `both files keep the snapshot name: ${names.join(' | ')}`);
});

await test('3MF: valid mesh → OPC package with model XML + colour, downloads', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();

  assert.equal(calls.downloads.length, 1, 'download triggered');
  assert.equal(calls.csgFrom.length, 1, 'solid-colour 3MF re-baked watertight');
  assert.equal(_clones[0].__worldBaked, true, 'full world matrix baked into vertices');
  assert.equal(_clones[0].__unique, true, 'geometry made unique');

  const files = zipInstances.at(-1).files;
  assert.ok(files['[Content_Types].xml'], 'has [Content_Types].xml');
  assert.ok(files['_rels/.rels'], 'has _rels/.rels');
  const model = files['3D/3dmodel.model'];
  assert.ok(model, 'has 3D/3dmodel.model');
  assert.match(model, /unit="millimeter"/);
  assert.match(model, /x="-0\.5"/, 'build centred on origin');
  assert.match(model, /<m:colorgroup id="1">/);
  assert.match(model, /<m:color color="#FF0000FF"\/>/);
  assert.match(model, /<object id="2" type="model" pid="1" pindex="0" name="m1">/);
  assert.match(model, /<vertex /);
  // CounterClockWise-flagged (default) mesh: PrintSpace keeps the buffer
  // order — the reflection in toPrintSpace already makes it outward for the
  // right-handed 3MF reader. (A ClockWise-flagged glTF mesh is reversed; see
  // the dedicated test below and tests/print-space.test.mjs.)
  assert.match(model, /<triangle v1="0" v2="1" v3="2"\/>/, 'CounterClockWise mesh written as-is');
  assert.match(model, /<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/><\/build>/,
    'build item carries explicit identity — placement is fully baked');
});

await test('3MF: ClockWise-flagged (glTF-imported) mesh → triangle reversed so the right-handed reader sees it outward', async () => {
  // CSG2 off: the CSG re-bake replaces geometry with Babylon-native winding
  // and resets the flag (covered by the next test); without it the clone
  // keeps the glTF loader's ClockWise flag and must be reversed on write.
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  try {
    setScene({ objects: { m1: obj('m1') },
      registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 }, side: 0 }) } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportThreeMF();
  } finally {
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
  assert.equal(_clones[0].sideOrientation, 0, 'clone carries the ClockWise flag');
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<triangle v1="0" v2="2" v3="1"\/>/, 'ClockWise mesh reversed (PrintSpace.printIndices)');
  // Axis map: Babylon (1,0,0) → 3MF (-1,0,0); Babylon (0,1,0) (up) → 3MF (0,0,1) (up).
  // Then centred in X/Y (cx = -0.5) and rested on the bed (min z → 0).
  assert.match(model, /<vertex x="0\.5" y="0" z="0"\/>/);
  assert.match(model, /<vertex x="-0\.5" y="0" z="0"\/>/, 'Babylon +X lands on 3MF -X (glTF reflection undone)');
  assert.match(model, /<vertex x="0\.5" y="0" z="1"\/>/, 'Babylon +Y lands on 3MF +Z (up stays up), build rests on z=0');
});

await test('3MF: CSG re-bake resets a ClockWise clone to CounterClockWise (Manifold output is native winding)', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 }, side: 0 }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.csgFrom.length, 1, 'CSG re-bake ran');
  assert.equal(_clones[0].sideOrientation, 1, 'flag reset after CSG output replaced the geometry');
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<triangle v1="0" v2="1" v3="2"\/>/, 'fresh CSG geometry written as-is');
});

await test('3MF: distinct colours → one colorgroup entry each', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /#FF0000FF/);
  assert.match(model, /#0000FFFF/);
  assert.match(model, /pindex="0"/);
  assert.match(model, /pindex="1"/);
  assert.match(model, /objectid="2"/);
  assert.match(model, /objectid="3"/);
});

await test('3MF: split logical object writes one build item with per-triangle colours', async () => {
  setScene({
    objects: {
      partA: obj('partA', { name: 'Mug', sourceGroupId: 'sg_mug', logicalObjectId: 'partA' }),
      partB: obj('partB', { name: 'Mug__part1', sourceGroupId: 'sg_mug', logicalObjectId: 'partA', isInternalPart: true }),
    },
    registry: {
      partA: mesh('Mug', { color: { r: 1, g: 0, b: 0 } }),
      partB: mesh('Mug__part1', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  MeshValidator.validateMesh = valOK;

  await PrintManager.exportThreeMF();

  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.equal((model.match(/<object id="/g) ?? []).length, 1, 'one 3MF object for the logical Blender object');
  assert.equal((model.match(/<item objectid="/g) ?? []).length, 1, 'one build item for the logical Blender object');
  assert.match(model, /<triangle[^>]+pid="1"[^>]+p1="0"[^>]+p2="0"[^>]+p3="0"/);
  assert.match(model, /<triangle[^>]+pid="1"[^>]+p1="1"[^>]+p2="1"[^>]+p3="1"/);
});

await test('3MF: no-material mesh → fallback colour, still valid package', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<m:color color="#[0-9A-F]{8}"\/>/);
  assert.equal(calls.downloads.length, 1);
});

await test('3MF: textured mesh skips CSG2 (preserves UVs), solid mesh re-bakes', async () => {
  const textured = mesh('tex', { color: { r: 0, g: 1, b: 0 } });
  // Readable texture stub: texture failures now ABORT the export (fail closed).
  textured.material = { id: 'm', diffuseColor: { r: 0, g: 1, b: 0 }, diffuseTexture: {
    name: 't', getBaseSize() { return { width: 1, height: 1 }; },
    readPixels() { return new Uint8Array([0, 255, 0, 255]); },
  } };
  const uvData = (kind) => (kind === 'uv' ? new Float32Array([0, 0, 1, 0, 0, 1]) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  textured.getVerticesData = uvData;
  const origClone = textured.clone;
  textured.clone = (n) => { const c = origClone.call(textured, n); c.material = textured.material; c.getVerticesData = uvData; return c; };
  setScene({
    objects: { t: obj('t'), s: obj('s') },
    registry: { t: textured, s: mesh('s', { color: { r: 0, g: 0, b: 1 } }) },
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.csgFrom.length, 1, 'only the solid-colour mesh re-baked');
});

await test('3MF: error surviving auto-fix → blocks with list, no download', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrAlways;
  await assert.rejects(PrintManager.exportThreeMF(), (e) => e.validationErrors?.length === 1);
  assert.equal(calls.downloads.length, 0);
});

await test('3MF colorgroup: individually → one inner 3MF zip per mesh in outer zip', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
                m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF({ individually: true });
  // 2 inner zips (one per mesh) + 1 outer zip
  assert.equal(zipInstances.length, 3, '2 inner + 1 outer JSZip instances');
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to1.3mf'], 'project+mesh+ratio in inner 3MF name');
  assert.ok(outer['Test_m2_r1to1.3mf']);
  // Each inner zip has the full OPC skeleton for ONE object
  for (const inner of zipInstances.slice(0, 2)) {
    assert.ok(inner.files['[Content_Types].xml']);
    assert.ok(inner.files['_rels/.rels']);
    const model = inner.files['3D/3dmodel.model'];
    assert.ok(model);
    // exactly one <object> per inner 3MF
    assert.equal((model.match(/<object /g) || []).length, 1, 'one object per inner 3MF');
  }
});

await test('3MF individually: every inner 3MF carries metadata + the one batch thumbnail (captured once)', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
                m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }) } });
  MeshValidator.validateMesh = valOK;
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7]);
  let captures = 0;
  await PrintManager.exportThreeMF({ individually: true, captureThumbnail: async () => { captures++; return png; } });
  assert.equal(captures, 1, 'one viewport capture per export batch');
  for (const inner of zipInstances.slice(0, 2)) {
    assert.equal(inner.files['Metadata/thumbnail.png'], png);
    assert.match(inner.files['_rels/.rels'], /relationships\/metadata\/thumbnail/);
    assert.match(inner.files['3D/3dmodel.model'], /<metadata name="Title">Test<\/metadata><metadata name="Application">MIXOMESH<\/metadata>/);
  }
});

await test('3MF: thumbnail capture is never attempted for non-3MF formats', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  let captures = 0;
  await PrintManager.exportSTL({ captureThumbnail: async () => { captures++; return null; } });
  assert.equal(captures, 0);
});

await test('3MF materials-ext: individually → per-mesh 3MF carries only its own texture', async () => {
  const tex = { name: 'paint', getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) };
  const mt1 = mesh('mt1');
  mt1.material = { id: 'mat1', diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex };
  mt1.getVerticesData = (k) => k === 'uv' ? new Float32Array([0,0, 1,0, 0,1]) : new Float32Array([0,0,0, 1,0,0, 0,1,0]);
  const c1 = mt1.clone; mt1.clone = (n) => { const c = c1.call(mt1, n); c.material = mt1.material; c.getVerticesData = mt1.getVerticesData; return c; };
  const ms2 = mesh('ms2', { color: { r: 0, g: 1, b: 0 } });
  setScene({ objects: { mt1: obj('mt1'), ms2: obj('ms2') }, registry: { mt1, ms2 } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF({ individually: true });
  // 2 inner + 1 outer
  assert.equal(zipInstances.length, 3);
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_mt1_r1to1.3mf']);
  assert.ok(outer['Test_ms2_r1to1.3mf']);
  // Inner zip for the textured mesh has a PNG + rels; solid mesh has neither.
  const innerTex = zipInstances[0].files;
  const innerSol = zipInstances[1].files;
  assert.ok(Object.keys(innerTex).some(k => k.startsWith('3D/Textures/')), 'textured part embeds its PNG');
  assert.ok(innerTex['3D/_rels/3dmodel.model.rels'], 'textured part has texture rels');
  assert.ok(!Object.keys(innerSol).some(k => k.startsWith('3D/Textures/')), 'solid part has no PNG');
});

report(27, 'export: STL and 3MF');
