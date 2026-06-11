// Printer-bed floor, grid styling, FRONT tag, and bed-preview volume (split
// from SceneManager.js — review L29). The floor footprint equals the printer
// bed XY (state.print.bedDimensions); state.scene.grid styles the lines only.

import { getState, setState } from '../StateManager.js';
import {
  DEFAULT_GRID_CELL_MM,
  DEFAULT_GRID_SUBDIV,
  MM_PER_BU,
} from './SceneConstants.js';

const BABYLON = window.BABYLON;
const GridMaterial = BABYLON.GridMaterial ?? null;

let _scene     = null;
let _ground    = null;
let _bedLabels = [];   // single flat FRONT tag laid on the bed

/** Build the initial floor. Call once from SceneManager.init. */
export function initBedGrid(scene) {
  _scene = scene;
  rebuildGround();
}

/**
 * Rebuild the floor. Its footprint equals the printer bed XY
 * (state.print.bedDimensions, mm → BU); the grid lines drawn on it are styled
 * from state.scene.grid (minor cell size + subdivisions). Takes no arguments —
 * always reads current state so bed-size and grid edits both flow through here.
 */
export function rebuildGround() {
  const bed  = getState().print.bedDimensions;
  const grid = getState().scene.grid ?? {};
  const cellMM = grid.cellMM > 0 ? grid.cellMM : DEFAULT_GRID_CELL_MM;
  const subdiv = grid.subdivisions > 0 ? grid.subdivisions : DEFAULT_GRID_SUBDIV;

  const wBU    = bed.x / MM_PER_BU;          // bed X → ground width
  const dBU    = bed.y / MM_PER_BU;          // bed Y → ground depth (Babylon Z)
  const cellBU = cellMM / MM_PER_BU;

  if (_ground) { _ground.dispose(); _ground = null; }

  if (GridMaterial) {
    _ground = BABYLON.MeshBuilder.CreateGround('grid', { width: wBU, height: dBU }, _scene);
    _ground.isPickable     = false;
    _ground.receiveShadows = true;
    const mat = new GridMaterial('gridMat', _scene);
    mat.gridRatio           = cellBU;
    mat.majorUnitFrequency  = subdiv;
    mat.minorUnitVisibility = 0.45;
    mat.mainColor           = new BABYLON.Color3(0.08, 0.08, 0.10);
    mat.lineColor           = new BABYLON.Color3(0.38, 0.38, 0.46);
    mat.opacity             = 0.98;
    mat.backFaceCulling     = false;
    _ground.material = mat;
  } else {
    const longest = Math.max(wBU, dBU);
    _ground = BABYLON.MeshBuilder.CreateGround('grid', {
      width: wBU, height: dBU,
      subdivisions: Math.max(10, Math.floor(longest / cellBU)),
    }, _scene);
    _ground.isPickable     = false;
    _ground.receiveShadows = true;
    const mat = new BABYLON.StandardMaterial('gridFallback', _scene);
    mat.wireframe       = true;
    mat.diffuseColor    = new BABYLON.Color3(0.32, 0.32, 0.40);
    mat.backFaceCulling = false;
    _ground.material = mat;
  }

  _rebuildBedLabels(wBU, dBU);
}

/**
 * Rebuild the single FRONT bed-edge tag. It lies flat on the ground plane as
 * part of the bed (not a billboard) and is drawn in the muted grid-line colour
 * so it reads as a quiet bed marking rather than a UI accent. Only FRONT is
 * shown — once the user knows the front edge the rest is implied, and four
 * upright tags were visual noise.
 */
function _rebuildBedLabels(widthBU, depthBU) {
  for (const lbl of _bedLabels) lbl.dispose();
  _bedLabels = [];
  const frontZ = depthBU / 2;                          // +Z edge = bed front
  const labelW = Math.max(0.05, Math.min(widthBU, depthBU) * 0.16);
  const labelH = labelW * 0.30;
  const inset  = labelH * 0.55;                         // hug the front bed edge
  const pos    = new BABYLON.Vector3(0, 0.004, frontZ - inset);  // 4 mm above bed
  _bedLabels.push(_createBedLabelMesh('FRONT', pos, labelW, labelH));
}

function _createBedLabelMesh(text, position, width, height) {
  const tex = new BABYLON.DynamicTexture(`bedLabelTex_${text}`, { width: 256, height: 80 }, _scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, 256, 80);
  // Grid-line colour (Color3 ≈ 0.38,0.38,0.46) so it belongs to the bed, but
  // opaque enough to be seen at a shallow angle. Orientation handled by the
  // mesh (rotation.x = +π/2 → normal up, glyphs read toward the front edge).
  ctx.fillStyle = 'rgba(120, 120, 140, 0.9)';
  ctx.font = 'bold 48px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 42);
  tex.update();

  const mat = new BABYLON.StandardMaterial(`bedLabelMat_${text}`, _scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.disableLighting = true;
  mat.opacityTexture  = tex;       // alpha via texture
  mat.backFaceCulling = false;
  mat.zOffset         = -2;        // pull toward camera so the grid never hides it

  const plane = BABYLON.MeshBuilder.CreatePlane(`bedLabel_${text}`, { width, height }, _scene);
  plane.material = mat;
  plane.position = position;
  // Lay flat on the bed, textured face UP, text readable from the front-
  // elevated camera. Verified live: rotateX(+90°) puts the non-mirrored
  // face up but the glyphs run away from the viewer, so rotateY(180°)
  // spins them back. (rotateX(-90°) mirrors the text; +90° alone is
  // upside-down.) No billboard — it is part of the bed.
  plane.rotation.set(Math.PI / 2, Math.PI, 0);
  plane.isPickable = false;
  plane.renderingGroupId = 0;
  return plane;
}

/**
 * Re-skin the grid lines. The floor footprint is unchanged (it tracks the
 * printer bed); only the minor cell size and major-line spacing change.
 * @param {{ cellMM?: number, subdivisions?: number }} grid
 */
export function setGrid(grid) {
  const prev = getState().scene.grid ?? {};
  const cellMM = Number.isFinite(grid.cellMM) && grid.cellMM > 0
    ? grid.cellMM : prev.cellMM ?? DEFAULT_GRID_CELL_MM;
  const subdivisions = Number.isFinite(grid.subdivisions) && grid.subdivisions > 0
    ? Math.round(grid.subdivisions) : prev.subdivisions ?? DEFAULT_GRID_SUBDIV;
  setState(s => ({
    ...s, scene: { ...s.scene, grid: { cellMM, subdivisions } },
  }), { silent: true });
  rebuildGround();
}

/** Toggle floor + FRONT tag visibility (the 'grid' overlay). */
export function setGroundVisible(on) {
  if (_ground) _ground.isVisible = on;
  for (const lbl of _bedLabels) lbl.isVisible = on;
}

/** Resize / recreate the bed preview box from mm dimensions. */
export function updateBedPreview(dims) {
  const prev = _scene.getMeshByName('bedPreview');
  if (prev) prev.dispose();

  const mat = new BABYLON.StandardMaterial('bedPreviewMat', _scene);
  mat.diffuseColor    = new BABYLON.Color3(0.3, 0.7, 1.0);
  mat.alpha           = 0.07;
  mat.backFaceCulling = false;

  const box = BABYLON.MeshBuilder.CreateBox('bedPreview', {
    width: dims.x / 1000, height: dims.z / 1000, depth: dims.y / 1000,
  }, _scene);
  box.material   = mat;
  box.isPickable = false;
  box.position.y = dims.z / 2000;
}

/** Remove the bed-preview volume if present. */
export function disposeBedPreview() {
  const bed = _scene.getMeshByName('bedPreview');
  if (bed) bed.dispose();
}
