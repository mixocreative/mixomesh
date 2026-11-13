// Copy transform ("Link Transforms") refuses a MULTI-PART target instead of tearing it apart.
//   node --import ./tests/register-hooks.mjs --test tests/properties-copy-transform.test.mjs
//
// Found 2026-11-13 by asking whether the Properties panel's transform paths reach every part of a
// logical object the way the rest of the app does. `_commitSizeInput` expands via
// `_logicalTargetIds`; `_copyTransformFromActive` iterated `Selection.getSelectedIds()`, which at
// root scope are LEADS. Running the real handler with a source at x=10 and a two-part target (lead
// at x=0, arm at x=1) left the lead at 10 and the arm at 1 -- nine units from its body, in one
// undoable step.
//
// Refusing was decided with Fable rather than by me, because the obvious repair is worse than it
// looks: applying the delta `M_src · M_lead⁻¹` to each part introduces SHEAR when the scale ratio
// is non-uniform and a part is rotated relative to its lead, and a position/rotation/scale triple
// cannot hold shear -- Babylon's `decompose` drops it silently, which is the deformation nobody
// sees until a print fails. The lead's pivot is also an import accident, so "make the lead match
// the source" is a rule we would be inventing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;

const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { Toast } = await import('../src/ui/Toast.js');
const History = await import('../src/core/HistoryManager.js');
const Panel = await import('../src/ui/PropertiesPanel.js');

SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
SceneManager.attachToSelection = () => {};
SceneManager.getScene = () => ({ transformNodes: [], meshes: [] });
Selection.refresh = () => {};

const B = globalThis.window.BABYLON;
const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

function mesh(id, x) {
  return {
    name: id, metadata: { meshId: id }, parent: null, geometry: {},
    position: new B.Vector3(x, 0, 0), rotationQuaternion: null,
    rotation: new B.Vector3(0, 0, 0), scaling: new B.Vector3(1, 1, 1),
    computeWorldMatrix() {}, getWorldMatrix: () => B.Matrix.Identity(),
    getAbsolutePosition() { return this.position; },
    setAbsolutePosition(p) { this.position = p; },
    refreshBoundingInfo() {}, bakeTransformIntoVertices() {}, setParent() {}, dispose() {},
  };
}

const obj = (id, extra = {}) => ({
  id, name: id, assetId: 'a1', collectionId: null, parentId: null, shaderId: null,
  visible: true, locked: false, isGhost: false, isUnlinked: false, isPrintPart: true,
  sourceGroupId: null, logicalObjectId: null, isInternalPart: false, ratio: 1, ...extra,
});

/** `src` at x=10, a two-part `tgt` (lead x=0, arm x=1), and a single-mesh `solo` at x=5. */
function scene() {
  meshes.clear();
  for (const [id, x] of [['src', 10], ['tgt', 0], ['tgt.arm', 1], ['solo', 5]]) meshes.set(id, mesh(id, x));
  StateManager.replaceState(StateManager.freshState());
  StateManager.setState((st) => ({
    ...st,
    selection: { ...st.selection, selectedIds: [], activeId: null },
    scene: {
      ...st.scene,
      objects: {
        src: obj('src'),
        tgt: obj('tgt', { logicalObjectId: 'tgt' }),
        'tgt.arm': obj('tgt.arm', { logicalObjectId: 'tgt', isInternalPart: true }),
        solo: obj('solo'),
      },
      groups: {},
    },
  }), { silent: true });
  History.clear();
}

/** Run the real handler with Toast captured. */
function copyWithToasts() {
  const real = Toast.show;
  const said = [];
  Toast.show = (message) => { said.push(message); };
  try { Panel.__test.copyTransformFromActive(); } finally { Toast.show = real; }
  return said;
}

const at = (id) => meshes.get(id).position.x;

await test('a multi-part target is refused, not torn apart', () => {
  scene();
  Selection.set(['tgt', 'src'], 'src');
  const undoBefore = History.getPosition?.().undo ?? History.getUndoLabel();
  const said = copyWithToasts();

  assert.equal(at('tgt'), 0, 'the lead did not move');
  assert.equal(at('tgt.arm'), 1, 'and neither did its arm -- the object is intact');
  assert.equal(said.length, 1, `it says why: ${JSON.stringify(said)}`);
  assert.match(said[0], /tgt/, 'and names the object it skipped');
  // No command when everything was refused: an empty undo step is its own small lie.
  const undoAfter = History.getPosition?.().undo ?? History.getUndoLabel();
  assert.deepEqual(undoAfter, undoBefore, 'nothing was pushed onto the undo stack');
});

await test('a single-mesh target in the same selection still gets the transform', () => {
  // The other half: a test that only proved "nothing moved" would pass just as well if the whole
  // feature had been broken.
  scene();
  Selection.set(['solo', 'tgt', 'src'], 'src');
  const said = copyWithToasts();

  assert.equal(at('solo'), 10, 'the single-mesh object took the active transform');
  assert.equal(at('tgt'), 0, 'while the multi-part one was left alone');
  assert.equal(at('tgt.arm'), 1);
  assert.equal(said.length, 1, 'with one refusal reported');
});

await test('a multi-part SOURCE is fine -- it reads its lead and deforms nothing', () => {
  // Only the TARGET is ambiguous. Reading a lead's transform harms nobody.
  scene();
  Selection.set(['solo', 'tgt'], 'tgt');
  const said = copyWithToasts();

  assert.equal(at('solo'), 0, 'solo moved to the multi-part source lead position');
  assert.equal(at('tgt'), 0, 'the source is untouched');
  assert.equal(at('tgt.arm'), 1);
  assert.deepEqual(said, [], 'and nothing is refused');
});
