// Export: watertight repair of the export clones
//
// Cut out of tests/export.test.mjs on 2026-11-14; the harness is
// ./export-kit.mjs. `report()` below asserts this file's case count -- see that file
// for why, and change the number in the same commit as any case you add or remove.

import assert from 'node:assert/strict';
import {
  MeshRepair, MeshValidator, PrintManager, StateManager, _clones, _registry, calls, mesh, obj,
  report, setScene, t, test, toasts, valOK,
} from './export-kit.mjs';

// ── Repair (export gate: watertight clones) ──────────────

// T6: fake engines return the FULL vendored diagnose contract
// ({boundary, nonManifold, components, isWatertight}) — a partial fake let
// the pipeline's C1 skip-check read `undefined === 0` and pass by accident.
const DIAG_OPEN   = { boundary: 3, nonManifold: 0, components: 1, isWatertight: false };
const DIAG_CLOSED = { boundary: 0, nonManifold: 0, components: 1, isWatertight: true };

/** Engine that reports an open mesh, then a closed one once repaired. */
function openThenFixedEngine({ onRepair } = {}) {
  let repaired = false;
  return {
    diagnose: () => (repaired ? { ...DIAG_CLOSED } : { ...DIAG_OPEN }),
    repairObject: async (V) => {
      repaired = true;
      onRepair?.();
      // A changed output forces write-back. It closes into a real tetra (an
      // apex over the fixture triangle): doubling the triangle instead would
      // be a 0 mm^3 folded sheet, which repair discards (P4.4).
      return {
        V: [...V, [0, 0, 1]], T: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
        report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 },
      };
    },
  };
}

/** Engine whose repair leaves the mesh open (confirmed not watertight). */
function stillOpenEngine({ onRepair } = {}) {
  return {
    diagnose: () => ({ ...DIAG_OPEN }),
    repairObject: async (V, T) => { onRepair?.(); return { V, T, report: { holesFilled: 0, nmFixed: 0, merged: 0 } }; },
  };
}

// C1: MeshFixLib stage 1 merges duplicate positions — which is what a UV seam
// is made of — so running it on a part that is ALREADY closed could only cost
// texture fidelity. The pipeline must diagnose first and leave it alone.
await test('C1 repair: a clone that already diagnoses closed is SKIPPED, never rewritten', async () => {
  let repairCalls = 0, diagnoseCalls = 0;
  MeshRepair.__test.setEngine({
    diagnose: () => { diagnoseCalls++; return { ...DIAG_CLOSED }; },
    repairObject: async (V, T) => { repairCalls++; return { V, T, report: {} }; },
  });
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.ok(diagnoseCalls >= 1, 'the clone WAS diagnosed');
    assert.equal(repairCalls, 0, 'a healthy clone is never handed to the repair engine');
    assert.equal(_clones[0].__repaired, undefined, 'clone geometry never rewritten — UVs cannot be touched');
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.equal(toasts.filter(toast => toast.type === 'warning').length, 0,
      'a skipped healthy clone is not a warning');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: runs on the export clone only — registry mesh untouched', async () => {
  MeshRepair.__test.setEngine(openThenFixedEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(_clones.length, 1);
    assert.match(_clones[0].name, /__export$/, 'repair ran on the export clone');
    assert.equal(_clones[0].__repaired, true, 'clone geometry rewritten by repair');
    assert.equal(_registry.m1.__repaired, undefined, 'live scene mesh untouched');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: options.repair === false skips the step (engine never invoked)', async () => {
  let calledCount = 0;
  MeshRepair.__test.setEngine(openThenFixedEngine({ onRepair: () => { calledCount++; } }));
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ({ repair: false });
    assert.equal(calledCount, 0, 'repair engine never invoked when repair:false');
    assert.ok(!toasts.some(t => /repair/i.test(t.msg)), 'no repair-related toast when explicitly disabled');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: engine unavailable → one warning toast, never throws, still exports', async () => {
  MeshRepair.__test.setEngine(null);
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.length, 1, 'export still produced');
  const repairToasts = toasts.filter(t => t.type === 'warning' && /repair/i.test(t.msg));
  assert.equal(repairToasts.length, 1, 'exactly one repair-unavailable warning for the whole batch');
});

await test('repair: strictExport true + still-not-watertight after repair → rejects listing the part, nothing downloaded', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
    MeshValidator.validateMesh = valOK;
    await assert.rejects(PrintManager.exportOBJ(), /not watertight/i);
    assert.equal(calls.downloads.length, 0, 'nothing downloaded');
  } finally {
    MeshRepair.__test.setEngine(null);
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
});

await test('repair: strictExport false + still-not-watertight after repair → exports, warning toast names the part', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.ok(toasts.some(t => t.type === 'warning' && /m1/.test(t.msg)), 'warning toast mentions the part');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: non-strict export with a confirmed not-watertight clone → exactly ONE warning toast, matching toast.exportedWithWarnings', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    const warningToasts = toasts.filter(toast => toast.type === 'warning');
    assert.equal(warningToasts.length, 1, 'exactly one warning toast for the whole export (no duplicate from the panel — there is no panel here — and none doubled by the pipeline itself)');
    assert.equal(warningToasts[0].msg, t('toast.exportedWithWarnings', { names: 'm1__export' }),
      'message text matches toast.exportedWithWarnings');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: a repair write-back never re-tags the side flag; registry mesh untouched', async () => {
  // CSG2 disabled so only the repair step's own winding rule (repairMesh
  // _conformWinding: flag kept, INDICES reversed when the geometry disagrees)
  // is exercised — not CSG's _csgRebake re-tag. A ClockWise glTF clone must
  // come out of a repair still ClockWise (the old CounterClockWise re-tag
  // shipped repaired glTF parts inside-out — measured 2026-09-18).
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  MeshRepair.__test.setEngine(openThenFixedEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { side: 0 }) } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(_clones[0].sideOrientation, 0, 'repaired clone keeps its ClockWise flag');
    assert.equal(_registry.m1.sideOrientation, 0, 'live scene mesh keeps its original ClockWise flag');
    assert.ok(_clones[0].__repaired, 'repair wrote back to the clone');
    assert.ok(!_registry.m1.__repaired, 'repair never wrote to the live mesh');
  } finally {
    MeshRepair.__test.setEngine(null);
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
});

await test('F10 repair: after a CSG re-bake the verdict describes the SHIPPED geometry', async () => {
  // The repair step leaves this clone open, so the pre-CSG verdict is
  // "not watertight". CSG2 then re-bakes it (Manifold output is watertight by
  // construction) — the pipeline must RE-DIAGNOSE the re-baked clone, so
  // strict mode does not block and no not-watertight warning fires.
  const B = globalThis.window.BABYLON;
  const realFromMesh = B.CSG2.FromMesh;
  let csgDone = false;
  B.CSG2.FromMesh = (m) => { csgDone = true; return realFromMesh(m); };
  MeshRepair.__test.setEngine({
    diagnose: () => (csgDone ? { ...DIAG_CLOSED } : { ...DIAG_OPEN }),
    repairObject: async (V, T) => ({ V, T, report: { holesFilled: 0 } }),   // still open
  });
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();
    assert.equal(calls.csgFrom.length, 1, 'the CSG re-bake ran');
    assert.equal(calls.downloads.length, 1, 'strict mode did NOT block: the shipped geometry is watertight');
    assert.equal(toasts.filter(toast => toast.type === 'warning').length, 0,
      'no stale "not watertight" warning from the pre-CSG verdict');
  } finally {
    MeshRepair.__test.setEngine(null);
    B.CSG2.FromMesh = realFromMesh;
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
});

report(9, 'export: watertight repair of the export clones');
