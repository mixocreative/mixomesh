// Camera rig (split from SceneManager.js — Blueprint §0.5 file-size budget,
// same pattern as SelectionOutline/BedGrid): ArcRotateCamera creation, the
// custom CAD mouse navigation (RMB orbit / MMB pan / Shift+MMB orbit —
// Babylon's own pointer input is disabled because it hard-codes RMB as pan),
// named view presets with animated transitions, ortho toggle + auto-revert,
// framing, follow modes, and camera persistence. SceneManager re-exports the
// public functions so its surface is unchanged.

import { EVENTS } from '../events.js';
import { subscribe, dispatch, getState, setState } from '../StateManager.js';
import {
  CAM_RADIUS_MIN,
  CAM_RADIUS_MAX,
  REVERT_DELTA_SQ,
  REVERT_ANGLE_DELTA,
} from './SceneConstants.js';

const BABYLON = window.BABYLON;

let _scene  = null;
let _canvas = null;
let _camera = null;

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

// Per-frame caches — _applyFollowTarget runs in onBeforeRender and must not
// call getState() there (Blueprint §14.4, review B11). Updated via the event
// subscriptions in initCameraRig.
let _cachedPreset     = 'perspective';
let _cachedFollowMode = 'free';
let _cachedActiveId   = null;

// ── Init ─────────────────────────────────────────────────

/**
 * Create the camera, wire custom pointer navigation, register the per-frame
 * follow/auto-revert hook, and subscribe to the camera-relevant app events.
 * @param {BABYLON.Scene} scene
 * @param {HTMLCanvasElement} canvas
 * @returns {BABYLON.ArcRotateCamera}
 */
export function initCameraRig(scene, canvas) {
  _scene  = scene;
  _canvas = canvas;
  _setupCamera();

  _lastAppliedTarget = _camera.target.clone();
  _scene.onBeforeRenderObservable.add(_applyFollowTarget);

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

  return _camera;
}

/** @returns {BABYLON.ArcRotateCamera|null} */
export function getCamera() { return _camera; }

// ── Camera setup + pointer navigation ────────────────────

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

// ── Presets / framing ────────────────────────────────────

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

// ── Persistence ──────────────────────────────────────────

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

// ── Follow modes + per-frame hook ────────────────────────

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
  const mesh = _scene?.meshes?.find(m => m.metadata?.meshId === activeId) ?? null;
  if (!mesh) return;
  let center;
  try {
    const hb = mesh.getHierarchyBoundingVectors(true);
    center = BABYLON.Vector3.Center(hb.min, hb.max);
  } catch {
    center = mesh.getAbsolutePosition?.().clone() ?? new BABYLON.Vector3(0, 0, 0);
  }
  _camera.target.copyFrom(center);
}
