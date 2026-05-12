import { EVENTS } from './events.js';
import { subscribe, getState } from './StateManager.js';

if (!window.BABYLON) {
  throw new Error('Babylon.js failed to load — check that the CDN <script> tag is present in index.html');
}

const BABYLON = window.BABYLON;
const GridMaterial = BABYLON.GridMaterial ?? null;

const ACCENT_COLOR   = BABYLON.Color3.FromHexString('#06b6d4');
const GRID_CELL_SIZE = 0.01;  // 10mm
const GRID_MAJOR_FREQ = 10;   // major every 100mm
const GRID_EXTENT = 20;       // 20m × 20m

let _engine    = null;
let _scene     = null;
let _camera    = null;
let _canvas    = null;
let _hl        = null;
let _gizmos    = null;
let _axes      = null;
let _cursor    = null;
let _ground    = null;
let _shadowGen = null;

// ── Init ─────────────────────────────────────────────────

/**
 * Initialise Babylon engine, scene, camera, lights, and all overlays.
 * @param {HTMLCanvasElement} canvas
 */
export function init(canvas) {
  _canvas = canvas;

  _engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  _engine.adaptToDeviceRatio = true;

  _scene = new BABYLON.Scene(_engine);
  _scene.clearColor  = new BABYLON.Color4(0x0a / 255, 0x0a / 255, 0x0b / 255, 1);
  _scene.ambientColor = new BABYLON.Color3(1, 1, 1);

  _setupCamera();
  _setupLighting();
  _setupGrid();
  _setupAxes();
  _setupHighlight();
  _setupGizmos();
  _setupCursor();

  _engine.runRenderLoop(() => _scene.render());
  window.addEventListener('resize', () => _engine.resize());

  subscribe(EVENTS.PROJECT_LOADED, () => {
    restoreCameraState(getState().scene.camera);
  });
}

// ── Camera ───────────────────────────────────────────────

function _setupCamera() {
  const { camera: c } = getState().scene;
  _camera = new BABYLON.ArcRotateCamera('cam', c.alpha, c.beta, c.radius, BABYLON.Vector3.Zero(), _scene);
  _camera.lowerRadiusLimit = 0.1;
  _camera.upperRadiusLimit = 500;
  _camera.wheelPrecision   = 50;
  _camera.minZ = 0.01;
  _camera.maxZ = 1000;
  _camera.attachControl(_canvas, true);

  const ptrs = _camera.inputs.attached.pointers;
  if (ptrs) {
    ptrs.buttons           = [1];  // MMB → orbit
    ptrs.panningSensibility = 500;
  }
}

function _syncOrtho() {
  const aspect = (_canvas.clientWidth / _canvas.clientHeight) || 1;
  const h = _camera.radius;
  _camera.orthoTop    =  h;
  _camera.orthoBottom = -h;
  _camera.orthoLeft   = -h * aspect;
  _camera.orthoRight  =  h * aspect;
}

/**
 * Switch the camera to a named preset.
 * @param {'perspective'|'top'|'bottom'|'front'|'back'|'left'|'right'} preset
 */
export function setCameraPreset(preset) {
  const ORTHO = {
    top:    { alpha: -Math.PI / 2, beta: 0           },
    bottom: { alpha: -Math.PI / 2, beta: Math.PI     },
    front:  { alpha: -Math.PI / 2, beta: Math.PI / 2 },
    back:   { alpha:  Math.PI / 2, beta: Math.PI / 2 },
    left:   { alpha:  Math.PI,     beta: Math.PI / 2 },
    right:  { alpha:  0,           beta: Math.PI / 2 },
  };

  if (preset === 'perspective') {
    _camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
  } else if (ORTHO[preset]) {
    _camera.alpha = ORTHO[preset].alpha;
    _camera.beta  = ORTHO[preset].beta;
    _camera.mode  = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
    _syncOrtho();
  }
}

/**
 * Animate camera to frame a set of meshes.
 * @param {BABYLON.AbstractMesh[]} meshes
 */
export function frameSelected(meshes) {
  if (!meshes.length) return;
  let min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  meshes.forEach(m => {
    const bi = m.getBoundingInfo();
    min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
    max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
  });
  _camera.target = BABYLON.Vector3.Center(min, max);
  _camera.radius = Math.max(max.subtract(min).length() * 1.5, 0.5);
}

/** @returns {{ alpha, beta, radius, target, isOrthographic }} */
export function saveCameraState() {
  return {
    alpha:  _camera.alpha,
    beta:   _camera.beta,
    radius: _camera.radius,
    target: { x: _camera.target.x, y: _camera.target.y, z: _camera.target.z },
    isOrthographic: _camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA,
  };
}

/** @param {{ alpha, beta, radius, target, isOrthographic }} state */
export function restoreCameraState(state) {
  if (!state) return;
  if (state.alpha  !== undefined) _camera.alpha  = state.alpha;
  if (state.beta   !== undefined) _camera.beta   = state.beta;
  if (state.radius !== undefined) _camera.radius = state.radius;
  if (state.target) _camera.target.set(state.target.x, state.target.y, state.target.z);
  _camera.mode = state.isOrthographic
    ? BABYLON.Camera.ORTHOGRAPHIC_CAMERA
    : BABYLON.Camera.PERSPECTIVE_CAMERA;
  if (state.isOrthographic) _syncOrtho();
}

// ── Lighting ─────────────────────────────────────────────

function _setupLighting() {
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), _scene);
  hemi.intensity = 0.4;

  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, -1), _scene);
  dir.intensity = 0.8;
  dir.position  = new BABYLON.Vector3(5, 10, 5);

  _shadowGen = new BABYLON.ShadowGenerator(1024, dir);
  _shadowGen.useBlurExponentialShadowMap = true;
}

// ── Grid ─────────────────────────────────────────────────

function _setupGrid() {
  _ground = BABYLON.MeshBuilder.CreateGround('grid', { width: GRID_EXTENT, height: GRID_EXTENT }, _scene);
  _ground.isPickable     = false;
  _ground.receiveShadows = true;

  if (GridMaterial) {
    const mat = new GridMaterial('gridMat', _scene);
    mat.gridRatio           = GRID_CELL_SIZE;
    mat.majorUnitFrequency  = GRID_MAJOR_FREQ;
    mat.minorUnitVisibility = 0.45;
    mat.mainColor           = new BABYLON.Color3(0.08, 0.08, 0.10);
    mat.lineColor           = new BABYLON.Color3(0.38, 0.38, 0.46);
    mat.opacity             = 0.98;
    mat.backFaceCulling     = false;
    _ground.material = mat;
  } else {
    _ground.dispose();
    _ground = BABYLON.MeshBuilder.CreateGround('grid', {
      width: GRID_EXTENT, height: GRID_EXTENT, subdivisions: 40,
    }, _scene);
    _ground.isPickable = false;
    _ground.receiveShadows = true;
    const mat = new BABYLON.StandardMaterial('gridFallback', _scene);
    mat.wireframe = true;
    mat.diffuseColor = new BABYLON.Color3(0.32, 0.32, 0.40);
    mat.backFaceCulling = false;
    _ground.material = mat;
  }
}

// ── Axes viewer ──────────────────────────────────────────

function _setupAxes() {
  _axes = new BABYLON.AxesViewer(_scene, 0.5);
}

// ── Highlight layer ──────────────────────────────────────

function _setupHighlight() {
  _hl = new BABYLON.HighlightLayer('hl', _scene);
  _hl.innerGlow = false;
}

/**
 * Outline the active (primary-selected) mesh.
 * @param {BABYLON.AbstractMesh|null} mesh
 */
export function setActive(mesh) {
  _hl.removeAllMeshes();
  if (mesh) _hl.addMesh(mesh, ACCENT_COLOR);
}

/**
 * Outline a set of selected (non-active) meshes at reduced intensity.
 * @param {BABYLON.AbstractMesh[]} meshes
 */
export function setSelected(meshes) {
  meshes.forEach(m => _hl.addMesh(m, ACCENT_COLOR.scale(0.4)));
}

// ── Gizmo manager ────────────────────────────────────────

function _setupGizmos() {
  _gizmos = new BABYLON.GizmoManager(_scene);
  _gizmos.positionGizmoEnabled     = false;
  _gizmos.rotationGizmoEnabled     = false;
  _gizmos.scaleGizmoEnabled        = false;
  _gizmos.usePointerToAttachGizmos = false;
}

/**
 * @param {'translate'|'rotate'|'scale'|'none'} mode
 */
export function setGizmoMode(mode) {
  _gizmos.positionGizmoEnabled = mode === 'translate';
  _gizmos.rotationGizmoEnabled = mode === 'rotate';
  _gizmos.scaleGizmoEnabled    = mode === 'scale';
}

/** @param {'world'|'local'} space */
export function setGizmoSpace(space) {
  const pg = _gizmos.gizmos.positionGizmo;
  if (pg) pg.updateGizmoRotationToMatchAttachedMesh = (space === 'local');
}

/**
 * @param {BABYLON.AbstractMesh[]} meshes
 * @param {BABYLON.Vector3} [pivot]
 */
export function attachToSelection(meshes, pivot) {
  _gizmos.attachToMesh(meshes.length ? meshes[0] : null);
}

// ── Overlays ─────────────────────────────────────────────

/**
 * Toggle a named scene overlay.
 * @param {'grid'|'axes'|'wireframe'|'bedPreview'} name
 * @param {boolean} on
 */
export function setOverlay(name, on) {
  switch (name) {
    case 'grid':
      if (_ground) _ground.isVisible = on;
      break;
    case 'axes':
      if (_axes) _axes.scaleLines = on ? 0.5 : 0;
      break;
    case 'wireframe':
      _scene.forceWireframe = on;
      break;
  }
}

/** Resize / recreate the bed preview box from mm dimensions. */
export function updateBedPreview(dims) {
  const prev = _scene.getMeshByName('bedPreview');
  if (prev) prev.dispose();

  const mat = new BABYLON.StandardMaterial('bedPreviewMat', _scene);
  mat.diffuseColor = new BABYLON.Color3(0.3, 0.7, 1.0);
  mat.alpha = 0.07;
  mat.backFaceCulling = false;

  const box = BABYLON.MeshBuilder.CreateBox('bedPreview', {
    width: dims.x / 1000, height: dims.z / 1000, depth: dims.y / 1000,
  }, _scene);
  box.material   = mat;
  box.isPickable = false;
  box.position.y = dims.z / 2000;
}

// ── 3D cursor ────────────────────────────────────────────

function _setupCursor() {
  _cursor = BABYLON.MeshBuilder.CreateSphere('cursor3d', { diameter: 0.04, segments: 6 }, _scene);
  const mat = new BABYLON.StandardMaterial('cursorMat', _scene);
  mat.diffuseColor  = new BABYLON.Color3(1, 1, 0.2);
  mat.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.05);
  _cursor.material   = mat;
  _cursor.isPickable = false;
}

/** @returns {BABYLON.Vector3} */
export function getCursor() {
  return _cursor ? _cursor.position.clone() : BABYLON.Vector3.Zero();
}

/** @param {BABYLON.Vector3} v3 */
export function setCursor(v3) {
  if (_cursor) _cursor.position.copyFrom(v3);
}

// ── Accessors ────────────────────────────────────────────

/** @returns {BABYLON.Scene} */
export function getScene() { return _scene; }

/** @returns {BABYLON.Engine} */
export function getEngine() { return _engine; }

/** @returns {BABYLON.ShadowGenerator} */
export function getShadowGenerator() { return _shadowGen; }

export const SceneManager = {
  init,
  getScene, getEngine, getShadowGenerator,
  setCameraPreset, frameSelected, saveCameraState, restoreCameraState,
  setGizmoMode, setGizmoSpace, attachToSelection,
  setActive, setSelected,
  setOverlay, updateBedPreview,
  getCursor, setCursor,
};
