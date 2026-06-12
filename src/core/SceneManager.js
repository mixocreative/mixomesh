import { EVENTS } from './events.js';
import { subscribe, dispatch, getState, setState } from './StateManager.js';
import {
  AXES_SIZE,
  CAM_RADIUS_MIN,
  CAM_RADIUS_MAX,
  CURSOR_DIAMETER,
  BG_GRADIENT_TOP,
  BG_GRADIENT_BOTTOM,
  HEMI_INTENSITY,
  HEMI_GROUND_COLOR,
  KEY_INTENSITY,
  FILL_INTENSITY,
  SHADOW_DARKNESS,
  SHADOW_BLUR_KERNEL,
  TONE_CONTRAST,
  TONE_EXPOSURE,
  REVERT_DELTA_SQ,
  REVERT_ANGLE_DELTA,
} from './scene/SceneConstants.js';
import { initSelectionOutline, setActive, setSelected } from './scene/SelectionOutline.js';
import {
  initBedGrid, rebuildGround as _rebuildGround, setGrid as _bedSetGrid,
  setGroundVisible, updateBedPreview as _bedUpdatePreview, disposeBedPreview,
} from './scene/BedGrid.js';

// Selection silhouette + bed/grid live in scene/SelectionOutline.js and
// scene/BedGrid.js (review L29 split); re-exported so the SceneManager
// surface is unchanged.
export { setActive, setSelected };

if (!window.BABYLON) {
  throw new Error('Babylon.js failed to load — check the Vite boot module in index.html');
}

const BABYLON = window.BABYLON;

let _engine    = null;
let _scene     = null;
let _camera    = null;
let _canvas    = null;
let _gizmos    = null;
let _axes      = null;   // { x, y, z } line meshes
let _cursor    = null;
let _shadowGen = null;

// Camera-preset animation state. _lastApplied* captures camera pose after a
// preset animation finished — used by the auto-revert hook in ortho mode to
// detect when the user pans (target moves), orbits (alpha/beta moves), or
// otherwise diverges from the snapped face view.
let _lastAppliedTarget = null;
let _lastAppliedAlpha  = 0;
let _lastAppliedBeta   = 0;
let _animating         = false;
// First-asset auto-frame state. Set true once we frame the first import of a
// session, or when a saved project loads (saved view wins). PROJECT_NEW resets.
let _initiallyFramed   = false;
let _initialFrameTimer = null;

// Pivot-based selection (see core/Selection.js + BLUEPRINT §7).
let _pivotNode          = null;
let _parentingSnapshots = [];   // [{ mesh, prevParent }]
let _selectedMeshes     = [];
let _activeMesh         = null;
let _currentPivotMode   = 'median';
let _dragSnapshot       = null;
let _bodyDragOriginPivot = null; // pivot world position at body-drag start
let _onTransformCommit  = null; // injected by src/app/main.ts to avoid circular imports

// Per-frame caches — _applyFollowTarget runs in onBeforeRender and must not
// call getState() there (Blueprint §14.4, review B11). Updated via events +
// the setters below.
let _cachedPreset     = 'perspective';
let _cachedFollowMode = 'free';
let _cachedActiveId   = null;

// Print preview material tracking
const _printPreviewMaterialMap = new Map(); // materialId → { originalMetallic }

// Wireframe edge rendering tracking
const _wireframeEdgeState = { enabled: false, color: new BABYLON.Color4(1, 0.8, 0, 1) };

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
  // Fallback solid = gradient base, so any frame before the backdrop layer
  // draws (and screenshot edges) matches instead of flashing black.
  _scene.clearColor   = BABYLON.Color4.FromHexString(BG_GRADIENT_BOTTOM + 'ff');
  _scene.ambientColor = new BABYLON.Color3(1, 1, 1);

  // Gentle ACES tone mapping — Fusion's clean, slightly punchy look. Applied
  // at material shading, so it bakes into the scene the selection-silhouette
  // post-process samples (no post-chain conflict).
  const ip = _scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType    = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.contrast           = TONE_CONTRAST;
  ip.exposure           = TONE_EXPOSURE;

  _setupBackground();
  _setupCamera();
  _setupLighting();
  initBedGrid(_scene);
  _setupAxes();
  initSelectionOutline(_scene, _engine, _camera);
  _setupGizmos();
  _setupCursor();

  // Apply initial gizmo mode from state.
  const gz = getState().gizmo;
  setGizmoMode(gz.mode);
  setGizmoSpace(gz.space);

  _lastAppliedTarget = _camera.target.clone();
  _scene.onBeforeRenderObservable.add(_applyFollowTarget);
  _engine.runRenderLoop(() => _scene.render());
  window.addEventListener('resize', () => _engine.resize());

  subscribe(EVENTS.PROJECT_LOADED, () => {
    restoreCameraState(getState().scene.camera);
    _initiallyFramed = true;   // saved view honours user's last camera
    const st = getState();
    _cachedPreset     = st.scene.camera?.preset ?? 'perspective';
    _cachedFollowMode = st.scene.camera?.followMode ?? 'free';
    _cachedActiveId   = st.selection?.activeId ?? null;
  });
  subscribe(EVENTS.SELECTION_CHANGED, ({ activeId } = {}) => { _cachedActiveId = activeId ?? null; });
  subscribe(EVENTS.ACTIVE_OBJECT_CHANGED, ({ activeId } = {}) => { _cachedActiveId = activeId ?? null; });

  // Print-preview matte mode must also cover materials that arrive AFTER the
  // toggle — imports while preview is ON kept their metallic (review M15).
  subscribe(EVENTS.ASSET_INSTANTIATED, () => {
    if (getState().scene.overlays?.printPreview) _setPrintPreviewMode(true);
  });

  // Auto-frame on the very first scene content of a session/project. Subsequent
  // drops do not retrigger — the user is past initial orientation by then.
  // 50 ms debounce batches multi-mesh imports (a single GLB usually fires
  // ASSET_INSTANTIATED N times in quick succession) so we frame the union.
  subscribe(EVENTS.ASSET_INSTANTIATED, () => {
    if (_initiallyFramed) return;
    if (_initialFrameTimer) clearTimeout(_initialFrameTimer);
    _initialFrameTimer = setTimeout(() => {
      frameAll();
      _initiallyFramed = true;
      _initialFrameTimer = null;
    }, 50);
  });
  subscribe(EVENTS.PROJECT_NEW, () => {
    _initiallyFramed = false;
    _cachedPreset = 'perspective';
    _cachedFollowMode = 'free';
    _cachedActiveId = null;
  });

  // Workspace/panel layout changes resize the grid cell the canvas lives in —
  // resize the engine on the next frame so the framebuffer matches (13b).
  const _resizeNextFrame = () => requestAnimationFrame(() => _engine?.resize());
  subscribe(EVENTS.WORKSPACE_CHANGED, _resizeNextFrame);
  subscribe(EVENTS.PANEL_COLLAPSED_CHANGED, _resizeNextFrame);
}

/**
 * Register the callback the SceneManager invokes after a gizmo drag completes,
 * with `{ prev, next }` keyed by meshId. Wired in src/app/main.ts to push a
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
  _camera.minZ = 0.001;        // 1 mm near plane
  _camera.maxZ = 100;
  _camera.attachControl(_canvas, true);

  const ptrs = _camera.inputs.attached.pointers;
  if (ptrs) {
    // Babylon classifies RMB(2) as its pan button, so RMB can only ever pan
    // (and pan is disabled here) — it will not orbit no matter what. So drive
    // all mouse orbit/pan ourselves in _onCameraPointer and let Babylon handle
    // only the wheel. buttons=[] disables Babylon's pointer orbit/pan.
    ptrs.buttons            = [];
    ptrs.panningSensibility = 0;
  }

  // Multiplicative wheel zoom feels right at any scale. wheelDeltaPercentage
  // > 0 switches Babylon from linear (wheel/precision) to percentage-based:
  // each notch scales radius by ~(1 ± wheelDeltaPercentage). Matches Blender
  // and Fusion-360's smooth zoom. wheelPrecision becomes irrelevant in this
  // mode, but we leave a sane fallback.
  const wheel = _camera.inputs.attached.mousewheel;
  if (wheel) {
    wheel.wheelDeltaPercentage = 0.08;  // 8% per notch
    wheel.wheelPrecisionY      = 60;
  }
  _camera.wheelPrecision = 50;

  // Zero panning + orbit inertia kills "ice-skating" coast-after-release — both
  // become 1:1 with cursor, which CAD tools expect.
  _camera.panningInertia = 0;
  _camera.inertia        = 0;

  // MMB: the browser's middle-click autoscroll would otherwise hijack the
  // drag, so suppress it on mousedown and run our own handler.
  _canvas.addEventListener('mousedown', _preventMmbDefault);
  _canvas.addEventListener('auxclick',  _preventMmbDefault);
  _scene.onPointerObservable.add(_onCameraPointer);
}

function _preventMmbDefault(e) {
  if (e.button === 1) e.preventDefault();
}

// Pixel→radian factor for orbit (RMB drag / Shift+MMB drag).
const ORBIT_SENS = 0.006;
let _camDrag = null;  // { x, y, btn } active camera drag, or null when idle

function _orbit(dx, dy) {
  _camera.alpha -= dx * ORBIT_SENS;
  _camera.beta  -= dy * ORBIT_SENS;
  const eps = 0.01;
  _camera.beta = Math.min(Math.PI - eps, Math.max(eps, _camera.beta));
}

function _pan(dx, dy) {
  // Grab-pan: content follows the cursor. Speed scales with distance so it
  // feels constant at any zoom (Babylon does the same for its own pan).
  const scale = Math.max(_camera.radius, 0.05) / 700;
  const right = _camera.getDirection(BABYLON.Axis.X);
  const up    = _camera.getDirection(BABYLON.Axis.Y);
  _camera.target.addInPlace(right.scale(-dx * scale));
  _camera.target.addInPlace(up.scale(dy * scale));
}

/**
 * Custom mouse navigation (CAD convention, all modes) — Babylon's pointer
 * orbit/pan is disabled because it forces RMB to be the pan button:
 *   RMB drag         → orbit
 *   MMB drag         → pan (grab-pan the target in its view plane)
 *   Shift + MMB drag → orbit
 * LMB(0) is ignored here so selection / gizmo / body-drag keep it. In follow
 * modes _applyFollowTarget re-locks the target each frame, so a pan only
 * persists in free mode (intended) while orbit circles the locked point.
 */
function _onCameraPointer(info) {
  const ev = info?.event;
  if (!ev) return;
  const T = BABYLON.PointerEventTypes;

  if (info.type === T.POINTERDOWN && (ev.button === 1 || ev.button === 2)) {
    _camDrag = { x: ev.clientX, y: ev.clientY, btn: ev.button };
    if (ev.button === 1) ev.preventDefault?.();
    return;
  }
  if (info.type === T.POINTERUP && _camDrag && ev.button === _camDrag.btn) {
    _camDrag = null;
    return;
  }
  if (info.type !== T.POINTERMOVE || !_camDrag) return;
  // buttons bitmask: 2 = RMB held, 4 = MMB held. Released off-canvas → stop.
  const mask = _camDrag.btn === 2 ? 2 : 4;
  if ((ev.buttons & mask) === 0) { _camDrag = null; return; }

  const dx = ev.clientX - _camDrag.x;
  const dy = ev.clientY - _camDrag.y;
  _camDrag.x = ev.clientX;
  _camDrag.y = ev.clientY;

  if (_camDrag.btn === 2 || ev.shiftKey) _orbit(dx, dy);
  else _pan(dx, dy);
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
  // Babylon LH, Y-up. Camera position = target + R·(sinβ cosα, cosβ, sinβ sinα).
  // "Front" semantically means the camera sits on +Z looking back toward the
  // origin, so user sees the +Z face of geometry — α = π/2, β = π/2.
  const ORTHO = {
    top:    { alpha:  Math.PI / 2, beta: 0           },   // camera +Y
    bottom: { alpha:  Math.PI / 2, beta: Math.PI     },   // camera -Y
    front:  { alpha:  Math.PI / 2, beta: Math.PI / 2 },   // camera +Z
    back:   { alpha: -Math.PI / 2, beta: Math.PI / 2 },   // camera -Z
    // Front-relative convention: from FRONT (Babylon LH) world +X is the
    // viewer's LEFT. So the LEFT face is seen with the camera on +X (α=0)
    // and the RIGHT face with the camera on -X (α=π). Matches NavCube yaw.
    left:   { alpha:  0,           beta: Math.PI / 2 },   // camera +X
    right:  { alpha:  Math.PI,     beta: Math.PI / 2 },   // camera -X
  };

  let alpha, beta;
  let isOrtho = false;
  if (preset === 'perspective') {
    // Front-right-elevated home pose — same shape as initial-load default so
    // Home button returns the user to the same neutral view they started in.
    alpha = Math.PI / 3;
    beta  = Math.PI / 4;
    isOrtho = false;
  } else if (ORTHO[preset]) {
    alpha = ORTHO[preset].alpha;
    beta  = ORTHO[preset].beta;
    isOrtho = true;
  } else {
    return;
  }

  // Frame all registered meshes so the requested view always shows content.
  const bbox = _sceneBoundingBox();
  const target = bbox ? BABYLON.Vector3.Center(bbox.min, bbox.max) : new BABYLON.Vector3(0, 0, 0);
  const radius = bbox
    ? Math.max(bbox.max.subtract(bbox.min).length() * 1.2, 0.05)
    : _camera.radius;

  // Drop out of ortho up front so the interim animation frames render in
  // perspective — orthographic interpolation looks broken mid-transition.
  if (_camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA && !isOrtho) {
    _camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
  }

  _animating = true;
  _animateMulti({ alpha, beta, target, radius }, 320, () => {
    _animating = false;
    _lastAppliedTarget.copyFrom(_camera.target);
    _lastAppliedAlpha = _camera.alpha;
    _lastAppliedBeta  = _camera.beta;
    if (isOrtho) {
      _camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
      _syncOrtho();
    } else {
      _camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
    }
  });

  _cachedPreset = preset;
  setState(s => ({ ...s, scene: { ...s.scene, camera: { ...s.scene.camera, preset } } }), { silent: true });
  dispatch(EVENTS.CAMERA_PRESET_CHANGED, { preset });
}

/**
 * Toggle perspective ↔ orthographic IN PLACE, preserving the current view
 * direction (review L25 — the old Numpad5 jumped to the front preset).
 * The preset stays 'perspective', so ortho persists until toggled back —
 * the pan/orbit auto-revert only fires for named face presets.
 */
export function toggleOrthographic() {
  if (!_camera) return;
  if (_camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA) {
    _camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
  } else {
    _camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
    _syncOrtho();
  }
}

/** Frame every registered scene mesh — used by Home button. */
export function frameAll() {
  const meshes = _scene.meshes.filter(m => m.metadata?.meshId);
  if (!meshes.length) {
    _animateCameraTo(new BABYLON.Vector3(0, 0, 0), 0.4, 280);
    return;
  }
  frameSelected(meshes);
}

function _sceneBoundingBox() {
  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  let any = false;
  for (const m of _scene.meshes) {
    if (!m.metadata?.meshId) continue;
    try {
      const r = m.getHierarchyBoundingVectors(true);
      min = BABYLON.Vector3.Minimize(min, r.min);
      max = BABYLON.Vector3.Maximize(max, r.max);
      any = true;
    } catch { /* skip degenerate */ }
  }
  return any ? { min, max } : null;
}

function _animateMulti({ alpha, beta, target, radius }, durationMs, onDone) {
  const ease = new BABYLON.QuadraticEase();
  ease.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
  const frames = Math.max(1, Math.round(60 * (durationMs / 1000)));
  let remaining = 0;
  const oneEnd = () => { if (--remaining <= 0) onDone?.(); };

  for (const [name, to] of [['alpha', alpha], ['beta', beta], ['radius', radius]]) {
    if (to == null) continue;
    remaining++;
    BABYLON.Animation.CreateAndStartAnimation(
      `cam_${name}`, _camera, name,
      60, frames, _camera[name], to,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, ease, oneEnd
    );
  }
  if (target) {
    remaining++;
    BABYLON.Animation.CreateAndStartAnimation(
      'cam_target', _camera, 'target',
      60, frames, _camera.target.clone(), target.clone(),
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, ease, oneEnd
    );
  }
  if (remaining === 0) onDone?.();
}

/**
 * Animate camera to frame a set of meshes.
 * @param {any[]} meshes
 */
export function frameSelected(meshes) {
  if (!meshes.length) return;
  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    if (!m) continue;
    try {
      // Hierarchy bounds include any child meshes (glTF parents wrap several
      // submeshes under one node) — using getBoundingInfo alone would frame
      // only the picked parent's bbox, often shrunk to a point.
      const r = m.getHierarchyBoundingVectors(true);
      min = BABYLON.Vector3.Minimize(min, r.min);
      max = BABYLON.Vector3.Maximize(max, r.max);
    } catch {
      const bi = m.getBoundingInfo?.();
      if (!bi) continue;
      min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
      max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
    }
  }
  if (!Number.isFinite(min.x)) return;
  const center = BABYLON.Vector3.Center(min, max);
  const diag   = max.subtract(min).length();
  const radius = Math.max(diag * 1.2, 0.05);
  _animateCameraTo(center, radius, 280);
}

function _animateCameraTo(targetVec, radiusVal, durationMs) {
  const ease = new BABYLON.QuadraticEase();
  ease.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
  const frames = Math.max(1, Math.round(60 * (durationMs / 1000)));
  BABYLON.Animation.CreateAndStartAnimation(
    'frame_target', _camera, 'target',
    60, frames, _camera.target.clone(), targetVec.clone(),
    BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, ease
  );
  BABYLON.Animation.CreateAndStartAnimation(
    'frame_radius', _camera, 'radius',
    60, frames, _camera.radius, radiusVal,
    BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, ease
  );
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

// ── Background ───────────────────────────────────────────

// Fusion-style soft vertical gradient as a fullscreen background Layer (a
// built-in, screenshot-safe, no engine-alpha needed). A 4×512 dynamic
// texture is enough — it stretches across the viewport; clamp wrap stops
// edge bleed.
function _setupBackground() {
  const tex = new BABYLON.DynamicTexture('mx-bg-gradient', { width: 4, height: 512 }, _scene, false);
  tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
  const ctx = tex.getContext();
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, BG_GRADIENT_TOP);
  g.addColorStop(1, BG_GRADIENT_BOTTOM);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  tex.update();

  const layer = new BABYLON.Layer('mx-bg', null, _scene, /* isBackground */ true);
  layer.texture = tex;
}

// ── Lighting ─────────────────────────────────────────────

// Neutral 3-light studio: broad hemispheric fill (sky white, soft floor
// bounce so undersides never go black), one soft key for form + a single
// gentle contact shadow, and a low opposite fill with no specular so it
// adds no second highlight. Reads flat-and-even like Fusion's default env.
function _setupLighting() {
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), _scene);
  hemi.intensity   = HEMI_INTENSITY;
  hemi.diffuse     = new BABYLON.Color3(1, 1, 1);
  hemi.groundColor = BABYLON.Color3.FromHexString(HEMI_GROUND_COLOR);
  hemi.specular    = new BABYLON.Color3(0.15, 0.15, 0.15);

  const key = new BABYLON.DirectionalLight('key', new BABYLON.Vector3(-1, -2, -1), _scene);
  key.intensity = KEY_INTENSITY;
  key.position  = new BABYLON.Vector3(6, 12, 6);

  const fill = new BABYLON.DirectionalLight('fill', new BABYLON.Vector3(1, -1, 1), _scene);
  fill.intensity = FILL_INTENSITY;
  fill.specular  = new BABYLON.Color3(0, 0, 0);

  _shadowGen = new BABYLON.ShadowGenerator(2048, key);
  _shadowGen.useBlurExponentialShadowMap = true;
  _shadowGen.useKernelBlur = true;
  _shadowGen.blurKernel    = SHADOW_BLUR_KERNEL;
  _shadowGen.darkness      = SHADOW_DARKNESS;
}

// ── Grid / bed ───────────────────────────────────────────
// Owned by scene/BedGrid.js; thin delegates keep the public surface.

/**
 * Re-skin the grid lines. The floor footprint is unchanged (it tracks the
 * printer bed); only the minor cell size and major-line spacing change.
 * @param {{ cellMM?: number, subdivisions?: number }} grid
 */
export function setGrid(grid) { _bedSetGrid(grid); }

/**
 * Rebuild the floor to match the current printer bed XY
 * (state.print.bedDimensions). Call after bed dimensions change.
 */
export function rebuildBed() { _rebuildGround(); }

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
  // Babylon recreates the scale sub-gizmos when scaleGizmoEnabled flips on.
  // Re-apply the user's scale-lock preference so the per-axis arrows match
  // the Properties panel state.
  if (mode === 'scale') setScaleLock(getState().ui?.scaleLocked !== false);
  if (getState().gizmo.mode !== mode) {
    setState(s => ({ ...s, gizmo: { ...s.gizmo, mode } }), { silent: true });
  }
}

/**
 * Set the camera follow mode. Affects where `_camera.target` lives every frame:
 *   - 'free'         → user-controlled (default). Pan + Focus work normally.
 *   - 'followActive' → target tracked to active object's hierarchy bbox centre.
 *   - 'worldOrigin'  → target locked to (0,0,0).
 *
 * In follow modes, manual pan is effectively overridden every frame. To regain
 * pan control, switch back to 'free'.
 *
 * @param {'free'|'followActive'|'worldOrigin'} mode
 */
export function setFollowMode(mode) {
  if (!['free', 'followActive', 'worldOrigin'].includes(mode)) return;
  _cachedFollowMode = mode;
  setState(s => ({
    ...s,
    scene: { ...s.scene, camera: { ...s.scene.camera, followMode: mode } },
  }), { silent: true });
}

function _applyFollowTarget() {
  if (!_camera) return;

  // Radius-scaled orbit sensitivity. Babylon's default angularSensibility is
  // a fixed value, which feels too sluggish when zoomed out (sweeping
  // rotations need many drags) and too twitchy when zoomed in. Mild inverse
  // scaling gives Blender/Fusion-style "more degrees per pixel the further
  // out the camera is", without becoming uncontrollable at small radii.
  const r = Math.max(0.15, _camera.radius);
  const orbitSens = Math.max(80, 220 / Math.sqrt(r));
  _camera.angularSensibilityX = orbitSens;
  _camera.angularSensibilityY = orbitSens;

  // Auto-revert: in ortho mode, ANY user-initiated camera change — pan
  // (target diverges), orbit (alpha/beta diverge), or zoom-then-orbit — flips
  // the preset back to 'perspective'. Captures both halves of the NavCube
  // face-click UX: "until user pans OR rotates".
  if (!_animating && _lastAppliedTarget && _camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA) {
    if (_cachedPreset && _cachedPreset !== 'perspective') {
      const dx = _camera.target.x - _lastAppliedTarget.x;
      const dy = _camera.target.y - _lastAppliedTarget.y;
      const dz = _camera.target.z - _lastAppliedTarget.z;
      const panDivergence   = dx*dx + dy*dy + dz*dz > REVERT_DELTA_SQ;
      const orbitDivergence =
        Math.abs(_camera.alpha - _lastAppliedAlpha) > REVERT_ANGLE_DELTA ||
        Math.abs(_camera.beta  - _lastAppliedBeta)  > REVERT_ANGLE_DELTA;
      if (panDivergence || orbitDivergence) {
        _camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
        _cachedPreset = 'perspective';
        setState(s => ({ ...s, scene: { ...s.scene, camera: { ...s.scene.camera, preset: 'perspective' } } }), { silent: true });
        dispatch(EVENTS.CAMERA_PRESET_CHANGED, { preset: 'perspective' });
      }
    }
  }

  // Keep ortho frustum in sync with radius — wheel zoom changes radius but
  // doesn't trigger _syncOrtho otherwise, so the view would feel "frozen".
  if (_camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA) _syncOrtho();

  if (_cachedFollowMode === 'free') return;
  if (_cachedFollowMode === 'worldOrigin') {
    _camera.target.set(0, 0, 0);
    return;
  }
  // followActive: track active object hierarchy bbox centre.
  const activeId = _cachedActiveId;
  if (!activeId) return;
  const mesh = _meshOf(activeId);
  if (!mesh) return;
  let center;
  try {
    const r = mesh.getHierarchyBoundingVectors(true);
    center = BABYLON.Vector3.Center(r.min, r.max);
  } catch {
    center = mesh.getAbsolutePosition?.().clone() ?? new BABYLON.Vector3(0, 0, 0);
  }
  _camera.target.copyFrom(center);
}

function _meshOf(meshId) {
  // SceneManager owns no mesh registry — delegate to AssetLoader if available
  // via the scene's metadata-tagged meshes (set in AssetLoader registration).
  return _scene?.meshes?.find(m => m.metadata?.meshId === meshId) ?? null;
}

/**
 * Toggle proportional / per-axis scaling on the viewport scale gizmo.
 *
 * When `locked` is true, only the central uniform handle is shown — dragging
 * it scales every axis equally. When false, the per-axis arrows are restored
 * so the user can scale a single axis. Mirrors the Properties Panel lock UX.
 *
 * @param {boolean} locked
 */
export function setScaleLock(locked) {
  const sg = _gizmos?.gizmos?.scaleGizmo;
  if (!sg) return;
  const show = !locked;
  for (const key of ['xGizmo', 'yGizmo', 'zGizmo']) {
    const sub = sg[key];
    if (!sub) continue;
    sub.isEnabled = show;
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
  if (mode === 'world') {
    return BABYLON.Vector3.Zero();
  }
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

// ── Body drag (LMB on mesh body → ground-plane translate) ───────

/**
 * The Y coordinate the body-drag plane should be locked to — taken from the
 * active mesh's world position (or the first selected mesh as a fallback).
 * @returns {number} world Y in BU, or 0 when nothing is selected.
 */
export function getBodyDragPlaneY() {
  const m = _activeMesh ?? _selectedMeshes[0] ?? null;
  if (!m) return 0;
  return m.getAbsolutePosition().y;
}

/**
 * Begin a horizontal pivot drag. Returns false if there's no live pivot
 * (no selection) or another drag is already in progress.
 * @returns {boolean}
 */
export function beginBodyDrag() {
  if (!_pivotNode || !_selectedMeshes.length) return false;
  if (_dragSnapshot) return false;
  _dragSnapshot = _snapshotAbsolute(_selectedMeshes);
  _bodyDragOriginPivot = _pivotNode.position.clone();
  return true;
}

/**
 * Move the selection pivot by `delta` from its position at beginBodyDrag().
 * Caller is responsible for zero-ing the Y component if the drag should stay
 * on the horizontal plane.
 * @param {BABYLON.Vector3} delta
 */
export function setBodyDragOffset(delta) {
  if (!_pivotNode || !_bodyDragOriginPivot || !delta) return;
  _pivotNode.position.copyFrom(_bodyDragOriginPivot).addInPlace(delta);
}

/**
 * Finish a body drag — snapshot the new transforms, push the same
 * TransformCommand pipeline gizmo drags use, and re-anchor the pivot.
 */
export function endBodyDrag() {
  if (!_dragSnapshot) return;
  const prev = _dragSnapshot;
  const next = _snapshotAbsolute(_selectedMeshes);
  _dragSnapshot = null;
  _bodyDragOriginPivot = null;
  if (_onTransformCommit) _onTransformCommit({ prev, next, alreadyApplied: true });
  attachToSelection(_selectedMeshes, _currentPivotMode, _activeMesh);
}

/** Abort a body drag — revert the pivot to its origin and drop snapshots. */
export function cancelBodyDrag() {
  if (!_dragSnapshot) return;
  if (_pivotNode && _bodyDragOriginPivot) {
    _pivotNode.position.copyFrom(_bodyDragOriginPivot);
  }
  _dragSnapshot = null;
  _bodyDragOriginPivot = null;
}

// ── Overlays ─────────────────────────────────────────────

/**
 * Toggle a named scene overlay.
 * @param {'grid'|'axes'|'wireframe'|'wireframeEdges'|'printPreview'|'bedPreview'} name
 * @param {boolean} on
 */
export function setOverlay(name, on) {
  switch (name) {
    case 'grid':
      setGroundVisible(on);
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
    case 'printPreview':
      _setPrintPreviewMode(on);
      break;
    case 'wireframeEdges':
      _setWireframeEdgesMode(on);
      break;
    case 'bedPreview':
      if (on) _bedUpdatePreview(getState().print.bedDimensions);
      else disposeBedPreview();
      break;
  }
}

/**
 * Update the wireframe edge color and re-apply if edges are currently enabled.
 * @param {string} hexColor  e.g. '#ffcc00'
 */
export function setWireframeEdgeColor(hexColor) {
  try {
    const c = BABYLON.Color3.FromHexString(hexColor);
    _wireframeEdgeState.color = new BABYLON.Color4(c.r, c.g, c.b, 1);
  } catch {
    return;
  }
  if (!_wireframeEdgeState.enabled) return;
  for (const mesh of _scene.meshes) {
    if (mesh._edgesRenderer) mesh.edgesColor = _wireframeEdgeState.color;
  }
}

function _setWireframeEdgesMode(enabled) {
  _wireframeEdgeState.enabled = enabled;
  for (const mesh of _scene.meshes) {
    if (!mesh.geometry) continue;
    // Edge outlines apply to imported content only — skip grid / axes /
    // bedPreview / nav-cube helpers (no metadata.meshId stamp).
    if (!mesh.metadata?.meshId) continue;
    if (enabled) {
      mesh.enableEdgesRendering(0.9, true);
      mesh.edgesColor = _wireframeEdgeState.color;
      mesh.edgesWidth = 1.0;
    } else {
      mesh.disableEdgesRendering();
    }
  }
}

/**
 * Apply print preview mode: remove metallic from all materials for a matte appearance.
 * When disabled, restore original metallic values.
 */
function _setPrintPreviewMode(enabled) {
  const meshes = _scene.meshes;

  if (enabled) {
    // Store original metallic values and set all to 0
    for (const mesh of meshes) {
      if (!mesh.material) continue;

      const mat = mesh.material;
      const matId = mat.uniqueId.toString();

      if (!_printPreviewMaterialMap.has(matId)) {
        // Store original value
        const originalMetallic = mat.metallic ?? 0;
        _printPreviewMaterialMap.set(matId, { originalMetallic });
      }

      // Apply matte appearance (remove metallic)
      if (mat.metallic !== undefined) {
        mat.metallic = 0;
      }
    }
  } else {
    // Restore original metallic values
    for (const mesh of meshes) {
      if (!mesh.material) continue;

      const mat = mesh.material;
      const matId = mat.uniqueId.toString();
      const stored = _printPreviewMaterialMap.get(matId);

      if (stored && mat.metallic !== undefined) {
        mat.metallic = stored.originalMetallic;
      }
    }
    // Prune — stale entries would restore outdated values on the next
    // enable cycle and the map grew unbounded (review M15).
    _printPreviewMaterialMap.clear();
  }
}

/** Resize / recreate the bed preview box from mm dimensions. */
export function updateBedPreview(dims) { _bedUpdatePreview(dims); }

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
    if (m.name === 'grid' || m.name === 'cursor3d' || m.name === 'bedPreview') return false;
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
  setCameraPreset, toggleOrthographic, frameSelected, frameAll, saveCameraState, restoreCameraState,
  setGizmoMode, setGizmoSpace, setScaleLock, setFollowMode, attachToSelection,
  setActive, setSelected,
  setOverlay, setWireframeEdgeColor, setGrid, rebuildBed, updateBedPreview,
  getCursor, setCursor, setCursorVisible,
  pickMeshIdAt,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
};
