// Export: filenames, typed print sizes and texture synthesis
//
// Cut out of tests/export.test.mjs on 2026-11-14; the harness is
// ./export-kit.mjs. `report()` below asserts this file's case count -- see that file
// for why, and change the number in the same commit as any case you add or remove.

import assert from 'node:assert/strict';
import {
  MeshValidator, PrintManager, StateManager, _clones, calls, mesh, obj, report, setScene, test,
  valOK, zipInstances,
} from './export-kit.mjs';

// ── Filename pattern (project + ratio suffix) ────────────
//
// Every export filename follows the same recipe (BLUEPRINT §12 PrintManager
// export filenames): combined → `${project}${suffix}.${ext}`, individually
// → outer zip `${project}${suffix}.zip` with inner entries
// `${project}_${mesh}${suffix}.${ext}`. Suffix is always present, even
// at 1:1, so a renamed file's scale is never ambiguous.

await test('filename: combined OBJ → `${project}${suffix}.zip` is the save default', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1_obj.zip',
    'save default = project + ratio suffix + format token even at 1:1');
});

await test('filename: combined OBJ at 1:144 → suffix `_r1to144`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144_obj.zip');
});

await test('filename: combined STL → `${project}${suffix}.stl` (single-blob path)', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 12, targetRatio: 35 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.equal(calls.downloads.length, 1, 'STL combined goes through packageAndDownload');
  // Export reference = active object's ratio (12 here) → target 35:
  // suffix _r{activeRatio}to{target}.
  assert.equal(calls.downloads.at(-1), 'Test_r12to35.stl');
});

await test('filename: combined 3MF solid-only → `${project}${suffix}.3mf`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.3mf');
});

await test('filename: combined 3MF default ratio → `${project}${suffix}.3mf`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 1 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.3mf');
});

await test('as-shown: empty exportTargets prints at the active object ratio (displayed size)', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [2, 2, 2] }) },
    workingRatio: 72, targetRatio: 72 });
  // Empty list ⇒ "as shown" ⇒ target = active object's ratio (72) ⇒ factor 1000.
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [] } }), { silent: true });
  const d = PrintManager.getExportedDimensions('m1');
  assert.ok(Math.abs(d.x - 2000) < 1e-6, `as-shown should be size×1000 (displayed mm), got ${d.x}`);
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r72to72_obj.zip', `as-shown suffix should be _r72to72, got ${calls.downloads.at(-1)}`);
});

await test('batch: exportTargets list emits one file per target ratio', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 72, targetRatio: 72 });
  // Two export targets; active object ratio is 72.
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 72 }, { kind: 'ratio', value: 144 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.ok(calls.downloads.includes('Test_r72to72_obj.zip'), `missing 1:72 file, got ${calls.downloads.join()}`);
  assert.ok(calls.downloads.includes('Test_r72to144_obj.zip'), `missing 1:144 file, got ${calls.downloads.join()}`);
  assert.equal(calls.downloads.filter(f => f.endsWith('.zip')).length, 2, 'exactly two zip outputs');
});

// ── Typed print sizes (task 1.17 / Decision 27) ─────────

await test('typed targets: ratio 144 / ×2 / 120 mm on a 60 mm-tall 1:72 reference → _r72to144, _x2, _h120mm', async () => {
  // Print-space Z (bed-up) = Babylon Y → a 0.06 BU-tall mesh is 60 mm tall as shown.
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [0.1, 0.06, 0.2] }) },
    workingRatio: 72, targetRatio: 72 });
  const targets = [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }, { kind: 'height', mm: 120 }];
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: targets } }), { silent: true });
  const factors = [0, 1, 2].map(i => PrintManager.previewExportContext({ targetIndex: i }).ratioFactor);
  assert.deepEqual(factors.map(f => +f.toFixed(9)), [0.5, 2, 2]);
  const h = PrintManager.previewExportContext({ targetIndex: 2 });
  assert.ok(Math.abs(h.referenceHeightMM - 60) < 1e-9, `reference height 60 mm, got ${h.referenceHeightMM}`);
  assert.ok(Math.abs(h.targetRatio - 36) < 1e-9, 'height target reports its effective ratio (72 / 2)');
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const zips = calls.downloads.filter(f => f.endsWith('.zip'));
  assert.deepEqual(zips, ['Test_r72to144_obj.zip', 'Test_x2_obj.zip', 'Test_h120mm_obj.zip']);
});

await test('typed targets: as shown stays _r{ref}to{ref}; fractional tokens use p', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') }, workingRatio: 72, targetRatio: 72 });
  StateManager.setState(s => ({ ...s, print: { ...s.print,
    exportTargets: [{ kind: 'factor', value: 0.5 }, { kind: 'height', mm: 12.5 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.deepEqual(calls.downloads.filter(f => f.endsWith('.stl')), ['Test_x0p5.stl', 'Test_h12p5mm.stl']);
});

await test('typed targets: add / remove / replace are undoable commands', async () => {
  const { push, undo, redo, clear, AddExportTargetCommand, RemoveExportTargetCommand, ReplaceExportTargetCommand }
    = await import('../src/core/HistoryManager.js');
  clear();
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [] } }), { silent: true });
  const cur = () => StateManager.getState().print.exportTargets;
  push(new AddExportTargetCommand({ kind: 'ratio', value: 144 }));
  push(new AddExportTargetCommand({ kind: 'factor', value: 2 }));
  push(new AddExportTargetCommand({ kind: 'factor', value: 2 }));   // duplicate collapses
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }]);
  push(new ReplaceExportTargetCommand({ kind: 'factor', value: 2 }, { kind: 'height', mm: 120 }));
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'height', mm: 120 }]);
  push(new RemoveExportTargetCommand({ kind: 'ratio', value: 144 }));
  assert.deepEqual(cur(), [{ kind: 'height', mm: 120 }]);
  undo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'height', mm: 120 }]);
  undo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }]);
  undo(); undo(); undo();
  assert.deepEqual(cur(), [], 'back to as shown');
  redo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }]);
  clear();
});

await test('export ratio reference ignores active object when it is not exported', async () => {
  setScene({
    objects: {
      helper: obj('helper', { ratio: 72, isPrintPart: false }),
      m1: obj('m1', { ratio: 1 }),
    },
    registry: { helper: mesh('helper'), m1: mesh('m1') },
    targetRatio: 144,
  });
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: ['m1'], activeId: 'helper' },
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 144 }] },
  }), { silent: true });
  const dims = PrintManager.getExportedDimensions('m1');
  assert.ok(Math.abs(dims.x - (10 * (1000 / 144))) < 1e-6,
    `dimension preview should use printable reference ratio 1, got ${dims.x}`);
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144_obj.zip',
    'non-exported active helper must not choose the export scale');
});

await test('export target ratio scales around active printable object origin', async () => {
  setScene({
    objects: {
      active: obj('active', { ratio: 72 }),
      other: obj('other', { ratio: 1 }),
    },
    registry: {
      active: mesh('active', { origin: [10, 0, 0] }),
      other: mesh('other', { origin: [20, 0, 0] }),
    },
    selectedIds: ['active', 'other'],
    targetRatio: 144,
  });
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: ['active', 'other'], activeId: 'active' },
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 144 }] },
  }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();

  const activeClone = _clones.find(c => c.name === 'active__export');
  const otherClone = _clones.find(c => c.name === 'other__export');
  assert.ok(activeClone?.__bakedMatrix, 'active clone was baked');
  assert.ok(otherClone?.__bakedMatrix, 'other clone was baked');
  assert.equal(activeClone.__bakedMatrix.tx, 10000,
    'active origin stays at its as-shown millimetre coordinate');
  assert.equal(otherClone.__bakedMatrix.tx, 15000,
    'other origin scales proportionally around the active origin');
});

await test('filename: individually OBJ → outer zip + per-mesh entries carry project prefix', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to144.obj']);
  assert.ok(outer['Test_m1_r1to144.mtl']);
  assert.ok(outer['Test_m2_r1to144.obj']);
  assert.ok(outer['Test_m2_r1to144.mtl']);
  // mtllib reference inside the OBJ payload must match the matching .mtl file
  assert.match(outer['Test_m1_r1to144.obj'], /^mtllib Test_m1_r1to144\.mtl/m,
    'OBJ mtllib points at per-mesh MTL');
  assert.equal(calls.downloads.at(-1), 'Test_r1to144_obj.zip');
});

// ── OBJ solid-colour PNG synthesis ───────────────────────
//
// Mimaki UV-inkjet slicers are texture-first. When a shader is a flat diffuse
// colour with no map, OBJ export synthesises a 4×4 RGBA PNG per unique
// `${RRGGBBAA}` (alpha = material.alpha) and injects `map_Kd` into the MTL.
// Toggle: `state.print.objBakeSolidTextures` (default OFF), exposed as a
// checkbox on the Export tab.

await test('OBJ synthesis: default off → no PNG, no map_Kd', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
    'no synthesised PNG by default');
  assert.ok(!/map_Kd/.test(files['Test_r1to1.mtl']), 'no map_Kd injected by default');
});

await test('OBJ synthesis: explicit toggle on → PNG in zip + map_Kd in MTL', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FF0000FF.png'], 'synth PNG embedded');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FF0000FF\.png/);
});

await test('OBJ synthesis: toggle off override → no PNG, no map_Kd', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: false } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  try {
    await PrintManager.exportOBJ();
    const files = zipInstances.at(-1).files;
    assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
      'no synthesised PNG when toggle off');
    assert.ok(!/map_Kd/.test(files['Test_r1to1.mtl']), 'no map_Kd injected');
  } finally {
    StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: false } }), { silent: true });
  }
});

await test('OBJ synthesis: two meshes same colour → ONE PNG (dedup by RRGGBBAA)', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 1, g: 0, b: 0 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  const pngs = Object.keys(files).filter(k => k.startsWith('textures/solid_'));
  assert.equal(pngs.length, 1, 'one PNG for two identical-colour meshes');
  assert.equal(pngs[0], 'textures/solid_FF0000FF.png');
});

await test('OBJ synthesis: distinct colours → distinct PNGs', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FF0000FF.png']);
  assert.ok(files['textures/solid_0000FFFF.png']);
});

await test('OBJ synthesis: opacity flows into α byte of filename', async () => {
  const m = mesh('m1', { color: { r: 1, g: 1, b: 1 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 1, b: 1 }, alpha: 0.5 };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  // 0.5 × 255 = 127.5 → rounds to 128 (0x80)
  assert.ok(files['textures/solid_FFFFFF80.png'], 'alpha 0.5 baked into filename hex');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FFFFFF80\.png/);
});

await test('OBJ synthesis: NaN alpha falls back to opaque in BOTH the PNG byte and MTL d (#10)', async () => {
  const m = mesh('m1', { color: { r: 1, g: 1, b: 1 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 1, b: 1 }, alpha: NaN };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FFFFFFFF.png'], 'NaN alpha → opaque FF byte, never "NaN"');
  assert.match(files['Test_r1to1.mtl'], /\nd 1\.0000\n/, 'NaN alpha → d 1.0000, never "NaN"');
  assert.doesNotMatch(files['Test_r1to1.mtl'], /NaN/, 'no literal NaN leaks into the MTL');
});

await test('OBJ synthesis: textured shader is NOT synthesised (real PNG path owns it)', async () => {
  const tex = { name: 'paint', getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) };
  const m = mesh('m1', { color: { r: 1, g: 0, b: 0 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 0, b: 0 }, diffuseTexture: tex };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
    'textured shader has no synth PNG');
  assert.ok(!/map_Kd textures\/solid_/.test(files['Test_r1to1.mtl']),
    'no synth map_Kd line for textured material');
});

await test('texture export names are unique case-insensitively; MTL + 3MF reference the final entries', async () => {
  const mkTex = (id) => ({ name: id, metadata: { mixoAssetId: id }, getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) });
  const mkTexMesh = (id, tex) => {
    const m = mesh(id);
    m.material = { id: `mat-${id}`, diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex };
    m.getVerticesData = (k) => k === 'uv' ? new Float32Array([0,0, 1,0, 0,1]) : new Float32Array([0,0,0, 1,0,0, 0,1,0]);
    const oc = m.clone;
    m.clone = (n) => { const c = oc.call(m, n); c.material = m.material; c.getVerticesData = m.getVerticesData; return c; };
    return m;
  };
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mkTexMesh('m1', mkTex('tA')), m2: mkTexMesh('m2', mkTex('ta')) },
  });
  StateManager.setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: {
      tA: { kind: 'texture', filename: 'A.png' },
      ta: { kind: 'texture', filename: 'a.png' },
    } },
  }), { silent: true });
  MeshValidator.validateMesh = valOK;

  const { textureExportFilename } = await import('../src/core/print/ExportTextures.js');
  const used = new Set();
  const n1 = textureExportFilename({}, 'tA', used, StateManager.getState());
  const n2 = textureExportFilename({}, 'ta', used, StateManager.getState());
  assert.equal(n1, 'A.png', 'first keeps its casing');
  assert.notEqual(n1.toLowerCase(), n2.toLowerCase());

  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  const texEntries = Object.keys(files).filter(k => k.startsWith('textures/'));
  assert.equal(texEntries.length, 2, 'two texture entries');
  assert.equal(new Set(texEntries.map(k => k.toLowerCase())).size, 2, 'distinct case-insensitively');
  const mtl = files['Test_r1to1.mtl'];
  const refs = [...mtl.matchAll(/map_Kd (\S+)/g)].map(m => m[1]);
  assert.deepEqual([...refs].sort(), [...texEntries].sort(), 'MTL references exactly the packaged entries');

  await PrintManager.exportThreeMF();
  const tmf = zipInstances.at(-1).files;
  const tPaths = Object.keys(tmf).filter(k => k.startsWith('3D/Textures/'));
  assert.equal(tPaths.length, 2);
  assert.equal(new Set(tPaths.map(k => k.toLowerCase())).size, 2);
  const rels = tmf['3D/_rels/3dmodel.model.rels'] + tmf['3D/3dmodel.model'];
  for (const p of tPaths) assert.ok(rels.includes(p) || rels.includes('/' + p), `3MF references ${p}`);
});

// ── Task 4.8 / Decision 17: deterministic `<object>_<slot>.png` names ────

function _texFixture() {
  const mkTex = (id) => ({ name: id, metadata: { mixoAssetId: id }, getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) });
  const mkTexMesh = (id, tex, matId = `mat-${id}`, matName = undefined) => {
    const m = mesh(id);
    m.material = { id: matId, name: matName, diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex };
    m.getVerticesData = (k) => k === 'uv' ? new Float32Array([0,0, 1,0, 0,1]) : new Float32Array([0,0,0, 1,0,0, 0,1,0]);
    const oc = m.clone;
    m.clone = (n) => { const c = oc.call(m, n); c.material = m.material; c.getVerticesData = m.getVerticesData; return c; };
    return m;
  };
  return { mkTex, mkTexMesh };
}

function _setTexLibrary(ids) {
  StateManager.setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: Object.fromEntries(ids.map(id => [id, { kind: 'texture', filename: 'Image_0.png' }])) },
  }), { silent: true });
}

await test('Decision 17: textures are named `<object>_<slot>.png`; MTL + 3MF reference exactly those entries', async () => {
  const { mkTex, mkTexMesh } = _texFixture();
  setScene({
    objects: { m1: obj('m1', { name: 'Chair' }), m2: obj('m2', { name: 'chair' }), m3: obj('m3', { name: 'Lamp Shade' }) },
    registry: {
      m1: mkTexMesh('m1', mkTex('t1')),
      m2: mkTexMesh('m2', mkTex('t2')),
      // Whitespace in the material id: the MTL key must use the same token as `usemtl`.
      m3: mkTexMesh('m3', mkTex('t3'), 'Base Color'),
    },
  });
  _setTexLibrary(['t1', 't2', 't3']);
  MeshValidator.validateMesh = valOK;

  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  const texEntries = Object.keys(files).filter(k => k.startsWith('textures/')).sort();
  assert.deepEqual(texEntries, [
    'textures/Chair_baseColor.png',
    'textures/Lamp_Shade_baseColor.png',
    'textures/chair_baseColor_1.png',
  ], 'object-named, case-insensitively unique (Chair vs chair)');
  const mtl = files['Test_r1to1.mtl'];
  const refs = [...mtl.matchAll(/map_Kd (\S+)/g)].map(m => m[1]).sort();
  assert.deepEqual(refs, texEntries, 'every map_Kd names a packaged entry (incl. the `Base Color` material)');
  assert.match(mtl, /newmtl Base_Color\n[\s\S]*?map_Kd textures\/Lamp_Shade_baseColor\.png/);

  await PrintManager.exportThreeMF();
  const tmf = zipInstances.at(-1).files;
  const tPaths = Object.keys(tmf).filter(k => k.startsWith('3D/Textures/')).sort();
  assert.deepEqual(tPaths, [
    '3D/Textures/Chair_baseColor.png',
    '3D/Textures/Lamp_Shade_baseColor.png',
    '3D/Textures/chair_baseColor_1.png',
  ], 'same names as OBJ');
  const model = tmf['3D/3dmodel.model'];
  const xmlRefs = [...model.matchAll(/<m:texture2d [^>]*path="\/([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(xmlRefs, tPaths, '3MF <m:texture2d path> = packaged parts');
  const rels = tmf['3D/_rels/3dmodel.model.rels'];
  for (const p of tPaths) assert.ok(rels.includes('/' + p), `rels reference ${p}`);
});

await test('Decision 17: a texture shared by several objects is named after its material', async () => {
  const { mkTex, mkTexMesh } = _texFixture();
  const shared = mkTex('tS');
  const left = mkTexMesh('m1', shared, 'mat-wood', 'Wood');
  const right = mkTexMesh('m2', shared, 'mat-wood', 'Wood');
  right.material = left.material;   // one shader = one Babylon material (ShaderLibrary)
  setScene({
    objects: { m1: obj('m1', { name: 'Left' }), m2: obj('m2', { name: 'Right' }) },
    registry: { m1: left, m2: right },
  });
  _setTexLibrary(['tS']);
  MeshValidator.validateMesh = valOK;

  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.deepEqual(Object.keys(files).filter(k => k.startsWith('textures/')), ['textures/Wood.png']);
  assert.deepEqual([...files['Test_r1to1.mtl'].matchAll(/map_Kd (\S+)/g)].map(m => m[1]), ['textures/Wood.png']);

  await PrintManager.exportThreeMF();
  const tmf = zipInstances.at(-1).files;
  assert.deepEqual(Object.keys(tmf).filter(k => k.startsWith('3D/Textures/')), ['3D/Textures/Wood.png']);
});

await test('Decision 17: names are deterministic across repeated exports', async () => {
  const { mkTex, mkTexMesh } = _texFixture();
  setScene({
    objects: { m1: obj('m1', { name: 'Body' }), m2: obj('m2', { name: 'BODY' }) },
    registry: { m1: mkTexMesh('m1', mkTex('t1')), m2: mkTexMesh('m2', mkTex('t2')) },
  });
  _setTexLibrary(['t1', 't2']);
  MeshValidator.validateMesh = valOK;
  const names = [];
  for (let i = 0; i < 2; i++) {
    await PrintManager.exportOBJ();
    names.push(Object.keys(zipInstances.at(-1).files).filter(k => k.startsWith('textures/')).sort());
  }
  assert.deepEqual(names[0], names[1]);
  assert.deepEqual(names[0], ['textures/BODY_baseColor_1.png', 'textures/Body_baseColor.png']);
});

await test('OBJ synthesis: individually → each per-mesh MTL gets its own map_Kd', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 1, b: 0 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const files = zipInstances.at(-1).files;
  assert.match(files['Test_m1_r1to1.mtl'], /map_Kd textures\/solid_FF0000FF\.png/);
  assert.match(files['Test_m2_r1to1.mtl'], /map_Kd textures\/solid_00FF00FF\.png/);
  assert.ok(files['textures/solid_FF0000FF.png']);
  assert.ok(files['textures/solid_00FF00FF.png']);
});

report(26, 'export: filenames, typed print sizes and texture synthesis');
