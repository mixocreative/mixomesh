import { EVENTS } from './events.js';
import { subscribe, getState, setState } from './StateManager.js';

if (!window.BABYLON) {
  throw new Error('Babylon.js failed to load — check that the CDN <script> tag is present in index.html');
}

const BABYLON = window.BABYLON;
const GridMaterial = BABYLON.GridMaterial ?? null;

const ACCENT_COLOR    = BABYLON.Color3.FromHexString('#06b6d4');
const ACCENT_DIM      = BABYLON.Color3.FromHexString('#06b6d4').scale(0.55);
const GRID_CELL_SIZE  = 0.01;  // 10 mm minor
const GRID_MAJOR_FREQ = 10;    // major every 10 cells (= 100 mm)
const AXES_SIZE       = 0.05;  // 50 mm
const CAM_RADIUS_MIN  = 0.02;  // 20 mm — close zoom for fine print parts
const CAM_RADIUS_MAX  = 5;     // 5 m  — far zoom limit
// 3D cursor diameter in BU. Tiny by default — only shown when pivotMode='cursor'.
const CURSOR_DIAMETER = 0.003;     // 3 mm

let _engine    = null;
let _scene     = null;
let _camera    = null;
let _canvas    = null;
let _gizmos    = null;
let _axes      = null;   // { x, y, z } line meshes
let _cursor    = null;
let _ground    = null;
let _shadowGen = null;

// Custom selection outline (replaces HighlightLayer because HL's stencil mask
// leaks on PBR materials that report any alpha mode).
let _selMaskRTT          = null;   // RenderTargetTexture
let _selMaskMatActive    = null;   // override for active mesh — full intensity
let _selMaskMatSelected  = null;   // override for selected non-active — dim
let _outlinePass         = null;
const _maskMeshes  = new Set();
const OUTLINE_RADIUS_PX = 3.0; // ring width in screen pixels
const OUTLINE_INTENSITY = 1.8; // multiplier for the cyan tint
// Mask emissive brightness — the ring's per-pixel value comes from this, so
// "active" reaches full intensity and "selected" stays muted.
const MASK_BRIGHTNESS_ACTIVE   = 1.0;
const MASK_BRIGHTNESS_SELECTED = 0.5;

// Pivot-based selection (see core/Selection.js + BLUEPRINT §7).
let _pivotNode          = null;
let _parentingSnapshots = [];   // [{ mesh, prevParent }]
let _selectedMeshes     = [];
let _activeMesh         = null;
let _currentPivotMode   = 'median';
let _dragSnapshot       = null;
let _onTransformCommit  = null; // injected by main.js to avoid circular imports

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
  _scene.clearColor   = new BABYLON.Color4(0x0a / 255, 0x0a / 255, 0x0b / 255, 1);
  _scene.ambientColor = new BABYLON.Color3(1, 1, 1);

  _setupCamera();
  _setupLighting();
  _setupGrid();
  _setupAxes();
  _setupHighlight();
  _setupGizmos();
  _setupCursor();

  // Apply initial gizmo mode from state.
  const gz = getState().gizmo;
  setGizmoMode(gz.mode);
  setGizmoSpace(gz.space);

  _engine.runRenderLoop(() => _scene.render());
  window.addEventListener('resize', () => _engine.resize());

  subscribe(EVENTS.PROJECT_LOADED, () => {
    restoreCameraState(getState().scene.camera);
  });
}

/**
 * Register the callback the SceneManager invokes after a gizmo drag completes,
 * with `{ prev, next }` keyed by meshId. Wired in main.js to push a
 * TransformCommand without creating a circular import here.
 */
export function setTransformCommitHandler(fn) {
  _onTransformCommit = fn;
}

// ── Camera ───────────────────────────────────────────────

function _setupCamera() {
  const { camera: c } = getState().scene;
  _camera = new BABYLON.ArcRotateCamera('cam', c.alpha, c.beta, c.radius, BABYLON.Vector3.Zero(), _scene);
  _camera.lowerRadiusLimit = CAM_RADIUS_MIN;
  _camera.upperRadiusLimit = CAM_RADIUS_MAX;
  // Wheel precision is "ticks per BU" — higher = slower zoom. At BU = 1 m the
  // default 50 means each wheel notch is ~20 mm. For a 300 mm build area we
  // want finer control: 500 → ~2 mm per notch.
  _camera.wheelPrecision   = 500;
  _camera.minZ = 0.001;        // 1 mm near plane
  _camera.maxZ = 100;
  _camera.attachControl(_canvas, true);

  const ptrs = _camera.inputs.attached.pointers;
  if (ptrs) {
    ptrs.buttons            = [1];  // MMB → orbit only
    // Panning at this scale needs lower sensibility (smaller = faster pan).
    ptrs.panningSensibility = 5000;
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
 * @param {any[]} meshes
 */
export function frameSelected(meshes) {
  if (!meshes.length) return;
  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
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
  _rebuildGroundMesh(getState().scene.gridSize);
}

function _rebuildGroundMesh(extent) {
  if (_ground) { _ground.dispose(); _ground = null; }
  _ground = BABYLON.MeshBuilder.CreateGround('grid', { width: extent, height: extent }, _scene);
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
      width: extent, height: extent, subdivisions: Math.max(10, Math.floor(extent / GRID_CELL_SIZE)),
    }, _scene);
    _ground.isPickable     = false;
    _ground.receiveShadows = true;
    const mat = new BABYLON.StandardMaterial('gridFallback', _scene);
    mat.wireframe       = true;
    mat.diffuseColor    = new BABYLON.Color3(0.32, 0.32, 0.40);
    mat.backFaceCulling = false;
    _ground.material = mat;
  }
}

/**
 * Resize the build-area grid. `extentBU` is the side length in Babylon Units
 * (1 BU = 1 m of print at the scene's working ratio).
 * @param {number} extentBU
 */
export function setGridSize(extentBU) {
  if (!Number.isFinite(extentBU) || extentBU <= 0) return;
  setState(s => ({ ...s, scene: { ...s.scene, gridSize: extentBU } }), { silent: true });
  _rebuildGroundMesh(extentBU);
}

// ── Axes overlay (1-pixel lines, no arrowheads) ─────────

function _setupAxes() {
  const len = AXES_SIZE;
  const cR = new BABYLON.Color4(1.00, 0.27, 0.27, 1);
  const cG = new BABYLON.Color4(0.13, 0.77, 0.37, 1);
  const cB = new BABYLON.Color4(0.23, 0.51, 0.96, 1);

  const x = BABYLON.MeshBuilder.CreateLines('axis-x', {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(len, 0, 0)],
    colors: [cR, cR],
  }, _scene);
  const y = BABYLON.MeshBuilder.CreateLines('axis-y', {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, len, 0)],
    colors: [cG, cG],
  }, _scene);
  const z = BABYLON.MeshBuilder.CreateLines('axis-z', {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 0, len)],
    colors: [cB, cB],
  }, _scene);
  [x, y, z].forEach(m => {
    m.isPickable        = false;
    m.alwaysSelectAsActiveMesh = true;
    m.renderingGroupId  = 1;       // draw on top of the grid
  });
  _axes = { x, y, z };
}

// ── Selection silhouette (custom mask + post-process) ───

// Why custom: Babylon's HighlightLayer composites via stencil, but the stencil
// is only reliably written for materials with `transparencyMode === OPAQUE`.
// Many glTF PBR materials report some alpha mode even when visually opaque,
// which leaves the stencil unset → the halo's gaussian blur is added on top
// of the mesh face. We instead render selected meshes into our own mask
// render-target (forcing an opaque emissive override), then a fullscreen pass
// dilates the mask and subtracts the original silhouette so by construction
// the ring exists ONLY outside the mesh.
function _setupHighlight() {
  _selMaskMatActive = new BABYLON.StandardMaterial('mx-sel-mask-active', _scene);
  _selMaskMatActive.emissiveColor   = new BABYLON.Color3(MASK_BRIGHTNESS_ACTIVE, MASK_BRIGHTNESS_ACTIVE, MASK_BRIGHTNESS_ACTIVE);
  _selMaskMatActive.diffuseColor    = new BABYLON.Color3(0, 0, 0);
  _selMaskMatActive.disableLighting = true;
  _selMaskMatActive.backFaceCulling = false;

  _selMaskMatSelected = new BABYLON.StandardMaterial('mx-sel-mask-selected', _scene);
  _selMaskMatSelected.emissiveColor   = new BABYLON.Color3(MASK_BRIGHTNESS_SELECTED, MASK_BRIGHTNESS_SELECTED, MASK_BRIGHTNESS_SELECTED);
  _selMaskMatSelected.diffuseColor    = new BABYLON.Color3(0, 0, 0);
  _selMaskMatSelected.disableLighting = true;
  _selMaskMatSelected.backFaceCulling = false;

  _selMaskRTT = new BABYLON.RenderTargetTexture(
    'mx-sel-mask-rt', { ratio: 0.5 }, _scene, false
  );
  _selMaskRTT.clearColor   = new BABYLON.Color4(0, 0, 0, 0);
  _selMaskRTT.renderList   = [];
  _selMaskRTT.activeCamera = _camera;
  _selMaskRTT.refreshRate  = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
  _scene.customRenderTargets.push(_selMaskRTT);

  if (!BABYLON.Effect.ShadersStore['mxOutlineFragmentShader']) {
    BABYLON.Effect.ShadersStore['mxOutlineFragmentShader'] = `
      precision highp float;
      varying vec2 vUV;
      uniform sampler2D textureSampler;
      uniform sampler2D maskSampler;
      uniform vec3 outlineColor;
      uniform vec2 texelSize;
      uniform float outlineRadiusPx;
      uniform float outlineIntensity;

      void main() {
        vec4 scene  = texture2D(textureSampler, vUV);
        // Mask carries intensity in .r (1.0 = active, 0.5 = selected non-active,
        // 0 = empty). The ring inherits this brightness so the active mesh
        // glows stronger than the rest.
        float center = texture2D(maskSampler, vUV).r;

        // Sample at multiple radii with inner-weighted falloff for a soft edge.
        // 16 angles × 4 radii = 64 taps.
        float ring = 0.0;
        const float TAU = 6.2831853;
        for (int i = 0; i < 16; i++) {
          float a = TAU * (float(i) + 0.5) / 16.0;
          vec2 dir = vec2(cos(a), sin(a));
          for (int j = 1; j <= 4; j++) {
            float t = float(j) / 4.0;
            float w = 1.0 - t * 0.45;
            vec2 off = dir * outlineRadiusPx * t * texelSize;
            ring = max(ring, texture2D(maskSampler, vUV + off).r * w);
          }
        }

        // Subtract the silhouette so the ring exists only OUTSIDE the mesh.
        ring = max(0.0, ring - center);
        gl_FragColor = vec4(scene.rgb + outlineColor * ring * outlineIntensity, scene.a);
      }
    `;
  }

  _outlinePass = new BABYLON.PostProcess(
    'mxOutline', 'mxOutline',
    ['outlineColor', 'texelSize', 'outlineRadiusPx', 'outlineIntensity'],
    ['maskSampler'],
    1.0, _camera, BABYLON.Texture.BILINEAR_SAMPLINGMODE
  );
  _outlinePass.onApply = (eff) => {
    eff.setColor3('outlineColor', ACCENT_COLOR);
    eff.setFloat2('texelSize',
      1 / _engine.getRenderWidth(),
      1 / _engine.getRenderHeight());
    eff.setFloat('outlineRadiusPx',  OUTLINE_RADIUS_PX);
    eff.setFloat('outlineIntensity', OUTLINE_INTENSITY);
    eff.setTexture('maskSampler', _selMaskRTT);
  };
}

function _setMaskMeshes(entries) {
  // Remove old material overrides + clear renderList.
  for (const m of _maskMeshes) {
    try { _selMaskRTT.setMaterialForRendering(m, null); } catch { /* ignore */ }
  }
  _maskMeshes.clear();
  _selMaskRTT.renderList.length = 0;

  // Apply per-mesh override based on kind ('active' vs 'selected').
  for (const { mesh, kind } of entries) {
    if (!(mesh instanceof BABYLON.Mesh)) continue;
    const mat = kind === 'active' ? _selMaskMatActive : _selMaskMatSelected;
    _selMaskRTT.renderList.push(mesh);
    try { _selMaskRTT.setMaterialForRendering(mesh, mat); } catch { /* ignore */ }
    _maskMeshes.add(mesh);
  }
}

// Module-local tracking — setActive + setSelected are called separately by
// Selection.js, so we accumulate and refresh once.
let _activeForOutline   = null;
let _selectedForOutline = [];

/**
 * Outline the active (primary-selected) mesh. Clears all prior outlines.
 * @param {any|null} mesh
 */
export function setActive(mesh) {
  _activeForOutline   = mesh ?? null;
  _selectedForOutline = [];     // reset; setSelected adds the others after
  _refreshOutlineSet();
}

/**
 * Outline a set of selected (non-active) meshes alongside the active one.
 * Must be called after setActive().
 * @param {any[]} meshes
 */
export function setSelected(meshes) {
  _selectedForOutline = (meshes ?? []).filter(m => m !== _activeForOutline);
  _refreshOutlineSet();
}

function _refreshOutlineSet() {
  const entries = [];
  if (_activeForOutline) entries.push({ mesh: _activeForOutline, kind: 'active' });
  for (const m of _selectedForOutline) {
    if (m !== _activeForOutline) entries.push({ mesh: m, kind: 'selected' });
  }
  _setMaskMeshes(entries);
}

// ── Gizmo manager + pivot ────────────────────────────────

function _setupGizmos() {
  _gizmos = new BABYLON.GizmoManager(_scene);
  _gizmos.positionGizmoEnabled     = false;
  _gizmos.rotationGizmoEnabled     = false;
  _gizmos.scaleGizmoEnabled        = false;
  _gizmos.usePointerToAttachGizmos = false;

  _wireGizmoObservers();
}

function _wireGizmoObservers() {
  for (const name of ['positionGizmo', 'rotationGizmo', 'scaleGizmo']) {
    const sub = _gizmos.gizmos[name];
    if (!sub || sub._mixomeshWired) continue;
    sub.onDragStartObservable?.add(_onGizmoDragStart);
    sub.onDragEndObservable?.add(_onGizmoDragEnd);
    sub._mixomeshWired = true;
  }
}

function _enabledGizmoChanged() {
  // Babylon recreates the sub-gizmos when modes toggle. Re-attach observers.
  _wireGizmoObservers();
}

/**
 * @param {'translate'|'rotate'|'scale'|'none'} mode
 */
export function setGizmoMode(mode) {
  _gizmos.positionGizmoEnabled = mode === 'translate';
  _gizmos.rotationGizmoEnabled = mode === 'rotate';
  _gizmos.scaleGizmoEnabled    = mode === 'scale';
  _enabledGizmoChanged();
  if (getState().gizmo.mode !== mode) {
    setState(s => ({ ...s, gizmo: { ...s.gizmo, mode } }), { silent: true });
  }
}

/** @param {'world'|'local'} space */
export function setGizmoSpace(space) {
  ['positionGizmo', 'rotationGizmo', 'scaleGizmo'].forEach(name => {
    const g = _gizmos.gizmos[name];
    if (g) g.updateGizmoRotationToMatchAttachedMesh = (space === 'local');
  });
  if (getState().gizmo.space !== space) {
    setState(s => ({ ...s, gizmo: { ...s.gizmo, space } }), { silent: true });
  }
  // Recompute pivot orientation if currently attached.
  if (_selectedMeshes.length) {
    attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
  }
}

/**
 * Compute the world position the pivot TransformNode should occupy for a
 * given pivot mode. Falls back to the median for unsupported modes.
 */
function _computePivotPosition(meshes, mode, activeMesh) {
  if (mode === 'active' && activeMesh) {
    return activeMesh.getAbsolutePosition().clone();
  }
  if (mode === 'cursor') {
    return _cursor ? _cursor.position.clone() : BABYLON.Vector3.Zero();
  }
  // 'median' / 'individual' (treated as median for Phase 3)
  let sum = new BABYLON.Vector3(0, 0, 0);
  meshes.forEach(m => { sum.addInPlace(m.getAbsolutePosition()); });
  return sum.scaleInPlace(1 / meshes.length);
}

function _detachPivot() {
  if (_pivotNode) {
    for (const { mesh, prevParent } of _parentingSnapshots) {
      mesh.setParent(prevParent ?? null);
    }
    _parentingSnapshots = [];
    _pivotNode.dispose();
    _pivotNode = null;
  }
  _selectedMeshes = [];
  _activeMesh = null;
}

/**
 * Attach the gizmo to a temp TransformNode pivot that parents every selected
 * mesh (preserving world transform). Subsequent gizmo drags move the pivot →
 * children inherit. On selection change, the pivot is detached and rebuilt.
 *
 * @param {any[]} meshes        Selected babylon meshes (resolved).
 * @param {'median'|'active'|'individual'|'cursor'} pivotMode
 * @param {any|null} [activeMesh]  The active (primary-selected) mesh.
 */
export function attachToSelection(meshes, pivotMode = 'median', activeMesh = null) {
  _detachPivot();
  if (!meshes || !meshes.length) {
    _gizmos.attachToMesh(null);
    return;
  }
  _currentPivotMode = pivotMode;
  _selectedMeshes   = meshes.slice();
  _activeMesh       = activeMesh ?? meshes[meshes.length - 1];

  _pivotNode = new BABYLON.TransformNode('selectionPivot', _scene);
  _pivotNode.position = _computePivotPosition(meshes, pivotMode, _activeMesh);

  const space = getState().gizmo.space;
  if (space === 'local' && _activeMesh) {
    _activeMesh.computeWorldMatrix(true);
    const aq = _activeMesh.absoluteRotationQuaternion;
    _pivotNode.rotationQuaternion = aq ? aq.clone() : BABYLON.Quaternion.Identity();
  } else {
    _pivotNode.rotationQuaternion = BABYLON.Quaternion.Identity();
  }

  for (const m of meshes) {
    if (m === _pivotNode) continue;
    _parentingSnapshots.push({ mesh: m, prevParent: m.parent ?? null });
    m.setParent(_pivotNode);
  }

  _gizmos.attachToMesh(_pivotNode);
}

// ── Gizmo drag → command ────────────────────────────────

function _snapshotAbsolute(meshes) {
  const out = {};
  for (const m of meshes) {
    const id = m.metadata?.meshId;
    if (!id) continue;
    m.computeWorldMatrix(true);
    const aq = m.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
    const ap = m.getAbsolutePosition();
    const as = m.absoluteScaling ?? m.scaling;
    out[id] = {
      position: { x: ap.x, y: ap.y, z: ap.z },
      rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
      scaling:  { x: as.x, y: as.y, z: as.z },
    };
  }
  return out;
}

function _onGizmoDragStart() {
  _dragSnapshot = _snapshotAbsolute(_selectedMeshes);
}

function _onGizmoDragEnd() {
  if (!_dragSnapshot) return;
  const prev = _dragSnapshot;
  const next = _snapshotAbsolute(_selectedMeshes);
  _dragSnapshot = null;
  if (_onTransformCommit) _onTransformCommit({ prev, next, alreadyApplied: true });
  // Rebuild pivot so it tracks the new median / active position for the next drag.
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
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
      if (_axes) {
        _axes.x.isVisible = on;
        _axes.y.isVisible = on;
        _axes.z.isVisible = on;
      }
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

// ── 3D cursor ────────────────────────────────────────────

function _setupCursor() {
  _cursor = BABYLON.MeshBuilder.CreateSphere('cursor3d', { diameter: CURSOR_DIAMETER, segments: 6 }, _scene);
  const mat = new BABYLON.StandardMaterial('cursorMat', _scene);
  mat.diffuseColor  = new BABYLON.Color3(1, 1, 0.2);
  mat.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.05);
  _cursor.material   = mat;
  _cursor.isPickable = false;
  _cursor.isVisible  = false;     // only shown when pivotMode === 'cursor'
}

/** Toggle 3D cursor visibility (used by pivotMode='cursor'). */
export function setCursorVisible(on) {
  if (_cursor) _cursor.isVisible = !!on;
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

/** @returns {string|null} meshId picked at canvas (x, y), or null. */
export function pickMeshIdAt(x, y) {
  if (!_scene) return null;
  const result = _scene.pick(x, y, m => {
    if (!m?.isPickable) return false;
    if (m === _ground || m.name === 'cursor3d' || m.name === 'bedPreview') return false;
    return true;
  });
  if (!result?.hit || !result.pickedMesh) return null;
  let node = result.pickedMesh;
  while (node) {
    const id = node.metadata?.meshId;
    if (id) return id;
    node = node.parent;
  }
  return null;
}

export const SceneManager = {
  init, setTransformCommitHandler,
  getScene, getEngine, getShadowGenerator,
  setCameraPreset, frameSelected, saveCameraState, restoreCameraState,
  setGizmoMode, setGizmoSpace, attachToSelection,
  setActive, setSelected,
  setOverlay, setGridSize, updateBedPreview,
  getCursor, setCursor, setCursorVisible,
  pickMeshIdAt,
};
