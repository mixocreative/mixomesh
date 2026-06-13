// 3D cursor (Blender-style) — split out of SceneManager (review L29 pattern).
//
// Visual = the original yellow translucent ball (a fixed world anchor) PLUS a
// Blender-like crosshair + dashed ring that billboard to the camera and hold a
// roughly constant on-screen size (scaled per-frame by camera radius). The ball
// stays so the cursor reads as a real point in space even head-on; the ring +
// crosshair give the familiar Blender target.
//
// Owns the cursor<->state bridge: setCursor writes state.scene.cursor3d
// (silent — placing the cursor shouldn't flag the project dirty, same rule as
// selection) and fires CURSOR_CHANGED so the N-panel inputs track it.

import { CURSOR_DIAMETER, CURSOR_HEX } from './SceneConstants.js';
import { setState } from '../StateManager.js';
import { dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';

const BABYLON = window.BABYLON;
const SILENT = { silent: true };

// On-screen size: ring/crosshair world radius ≈ camera.radius * SCREEN_K, so
// the target looks the same size whether you're zoomed into a 10 mm part or out
// to the whole bed. Tuned by eye against the default 300 mm working area.
const SCREEN_K = 0.045;
const RING_SEGMENTS = 48;   // dashed: every other span drawn
const CROSS_GAP = 0.35;     // inner gap (Blender leaves the centre open)
const CROSS_LEN = 1.0;

let _scene  = null;
let _root   = null;   // TransformNode — position + per-frame uniform scale
let _ball   = null;
let _ring   = null;
let _cross  = null;
let _beforeRender = null;

/** Build the cursor meshes. Hidden until pivotMode === 'cursor'. */
export function initCursor3D(scene) {
  _scene = scene;
  _root = new BABYLON.TransformNode('cursor3dRoot', scene);

  // Yellow translucent ball (original look, kept).
  _ball = BABYLON.MeshBuilder.CreateSphere('cursor3d', { diameter: CURSOR_DIAMETER, segments: 8 }, scene);
  const ballMat = new BABYLON.StandardMaterial('cursorMat', scene);
  ballMat.diffuseColor  = new BABYLON.Color3(1, 1, 0.2);
  ballMat.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.05);
  ballMat.disableLighting = true;
  ballMat.alpha = 0.55;
  _ball.material   = ballMat;
  _ball.isPickable = false;
  _ball.parent     = _root;

  const accent = BABYLON.Color3.FromHexString(CURSOR_HEX);

  // Dashed ring (radius 1, XY plane) — billboarded so it always faces camera.
  _ring = _buildDashedRing(scene, accent);
  _ring.parent = _root;

  // Crosshair: four short spokes with an open centre (Blender target).
  _cross = _buildCrosshair(scene, accent);
  _cross.parent = _root;

  _root.setEnabled(false);   // shown via setCursorVisible

  // Per-frame: position from the ball anchor is on _root; scale to keep a
  // constant-ish screen size. Cheap — three node writes, only while visible.
  _beforeRender = () => {
    if (!_root.isEnabled()) return;
    const cam = scene.activeCamera;
    const r = cam?.radius ?? 5;
    const s = Math.max(1e-4, r * SCREEN_K);
    _ring.scaling.set(s, s, s);
    _cross.scaling.set(s, s, s);
  };
  scene.onBeforeRenderObservable.add(_beforeRender);
}

function _buildDashedRing(scene, color) {
  const lines = [];
  for (let i = 0; i < RING_SEGMENTS; i += 2) {  // skip every other span = dashes
    const a0 = (i / RING_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
    lines.push([
      new BABYLON.Vector3(Math.cos(a0), Math.sin(a0), 0),
      new BABYLON.Vector3(Math.cos(a1), Math.sin(a1), 0),
    ]);
  }
  const ring = BABYLON.MeshBuilder.CreateLineSystem('cursor3dRing', { lines }, scene);
  ring.color = color;
  ring.isPickable = false;
  ring.billboardMode = BABYLON.TransformNode.BILLBOARDMODE_ALL;
  ring.renderingGroupId = 1;   // draw over geometry so the target is never hidden
  return ring;
}

function _buildCrosshair(scene, color) {
  const g = CROSS_GAP, l = CROSS_LEN;
  const lines = [
    [new BABYLON.Vector3( g, 0, 0), new BABYLON.Vector3( l, 0, 0)],
    [new BABYLON.Vector3(-g, 0, 0), new BABYLON.Vector3(-l, 0, 0)],
    [new BABYLON.Vector3(0,  g, 0), new BABYLON.Vector3(0,  l, 0)],
    [new BABYLON.Vector3(0, -g, 0), new BABYLON.Vector3(0, -l, 0)],
  ];
  const cross = BABYLON.MeshBuilder.CreateLineSystem('cursor3dCross', { lines }, scene);
  cross.color = color;
  cross.isPickable = false;
  cross.billboardMode = BABYLON.TransformNode.BILLBOARDMODE_ALL;
  cross.renderingGroupId = 1;
  return cross;
}

/** Toggle cursor visibility (driven by pivotMode === 'cursor'). */
export function setCursorVisible(on) {
  _root?.setEnabled(!!on);
}

/** @returns {boolean} */
export function isCursorVisible() {
  return !!_root?.isEnabled();
}

/** @returns {BABYLON.Vector3} current cursor world position (clone). */
export function getCursor() {
  return _root ? _root.position.clone() : BABYLON.Vector3.Zero();
}

/**
 * Move the cursor. Writes state.scene.cursor3d (silent — no dirty) and fires
 * CURSOR_CHANGED so UI tracks it. `silent` skips the event (used when applying
 * an incoming state value, to avoid a feedback loop).
 * @param {BABYLON.Vector3|{x:number,y:number,z:number}} v
 * @param {{ silentEvent?: boolean }} [opts]
 */
export function setCursor(v, opts = {}) {
  if (!_root) return;
  _root.position.set(v.x, v.y, v.z);
  setState(s => ({
    ...s,
    scene: { ...s.scene, cursor3d: { x: v.x, y: v.y, z: v.z } },
  }), SILENT);
  if (!opts.silentEvent) dispatch(EVENTS.CURSOR_CHANGED, { x: v.x, y: v.y, z: v.z });
}

/** Apply a cursor position coming from loaded/restored state (no event echo). */
export function setCursorFromState(c) {
  if (!_root || !c) return;
  _root.position.set(c.x ?? 0, c.y ?? 0, c.z ?? 0);
}
