import { EVENTS } from './events.js';
import { subscribe, getState } from './StateManager.js';
import {
  AXES_SIZE,
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
} from './scene/SceneConstants.js';
import { initSelectionOutline, setActive, setSelected } from './scene/SelectionOutline.js';
import {
  initBedGrid, rebuildGround as _rebuildGround, setGrid as _bedSetGrid,
  setGroundVisible, updateBedPreview as _bedUpdatePreview, disposeBedPreview,
} from './scene/BedGrid.js';
import {
  initCameraRig, getCamera,
  setCameraPreset, toggleOrthographic, frameAll, frameSelected,
  saveCameraState, restoreCameraState, setFollowMode,
} from './scene/CameraRig.js';
import {
  initPivotSession, setTransformCommitHandler,
  setGizmoMode, setGizmoSpace, setScaleLock, attachToSelection,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
} from './scene/PivotSession.js';

// Selection silhouette, bed/grid, camera rig, and pivot session live in
// scene/SelectionOutline.js, scene/BedGrid.js, scene/CameraRig.js, and
// scene/PivotSession.js (review L29 split + §0.5 budget); re-exported so the
// SceneManager surface is unchanged.
export { setActive, setSelected };
export {
  setCameraPreset, toggleOrthographic, frameAll, frameSelected,
  saveCameraState, restoreCameraState, setFollowMode,
};
export {
  setTransformCommitHandler,
  setGizmoMode, setGizmoSpace, setScaleLock, attachToSelection,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
};

if (!window.BABYLON) {
  throw new Error('Babylon.js failed to load — check the Vite boot module in index.html');
}

const BABYLON = window.BABYLON;

let _engine    = null;
let _scene     = null;
let _axes      = null;   // { x, y, z } line meshes
let _cursor    = null;
let _shadowGen = null;

// Print preview material tracking
const _printPreviewMaterialMap = new Map(); // materialId → { originalMetallic }

// Wireframe-edges overlay: per-mesh clone sharing the source geometry, drawn
// with a wireframe emissive material over the textured base (field report:
// edgesRenderer at epsilon 0.9 only showed sharp creases — users expect the
// full triangle wireframe WITH the texture still visible underneath).
const _wireframeEdgeState = { enabled: false, color: new BABYLON.Color3(1, 0.8, 0) };
const _edgeOverlays = new Map();   // meshId → overlay mesh
let _edgeMat = null;

// ── Init ─────────────────────────────────────────────────

/**
 * Initialise Babylon engine, scene, camera, lights, and all overlays.
 * @param {HTMLCanvasElement} canvas
 */
export function init(canvas) {
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
  const camera = initCameraRig(_scene, canvas);
  _setupLighting();
  initBedGrid(_scene);
  _setupAxes();
  initSelectionOutline(_scene, _engine, camera);
  _setupCursor();
  initPivotSession(_scene, { getCursorPosition: getCursor });

  _engine.runRenderLoop(() => _scene.render());
  window.addEventListener('resize', () => _engine.resize());
  // Panel splitter drags resize the canvas's grid cell WITHOUT any window
  // or workspace event — without this the canvas CSS-stretches and the
  // render distorts (elongated). ResizeObserver is the catch-all.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => _engine?.resize()).observe(canvas);
  }

  // Print-preview matte mode must also cover materials that arrive AFTER the
  // toggle — imports while preview is ON kept their metallic (review M15).
  // Same rule for the wireframe-edges overlay.
  subscribe(EVENTS.ASSET_INSTANTIATED, () => {
    if (getState().scene.overlays?.printPreview) _setPrintPreviewMode(true);
    if (_wireframeEdgeState.enabled) _setWireframeEdgesMode(true);
  });

  // Workspace/panel layout changes resize the grid cell the canvas lives in —
  // resize the engine on the next frame so the framebuffer matches (13b).
  const _resizeNextFrame = () => requestAnimationFrame(() => _engine?.resize());
  subscribe(EVENTS.WORKSPACE_CHANGED, _resizeNextFrame);
  subscribe(EVENTS.PANEL_COLLAPSED_CHANGED, _resizeNextFrame);
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
    _wireframeEdgeState.color = BABYLON.Color3.FromHexString(hexColor);
  } catch {
    return;
  }
  if (_edgeMat) _edgeMat.emissiveColor = _wireframeEdgeState.color;
}

function _edgeMaterial() {
  if (!_edgeMat) {
    _edgeMat = new BABYLON.StandardMaterial('mx-edge-overlay', _scene);
    _edgeMat.wireframe       = true;
    _edgeMat.disableLighting = true;
    _edgeMat.emissiveColor   = _wireframeEdgeState.color;
    _edgeMat.diffuseColor    = new BABYLON.Color3(0, 0, 0);
    _edgeMat.zOffset         = -1;   // pull lines toward the camera — no z-fighting
  }
  return _edgeMat;
}

function _ensureEdgeOverlay(mesh) {
  const id = mesh.metadata?.meshId;
  if (!id) return;
  const existing = _edgeOverlays.get(id);
  if (existing && !existing.isDisposed?.()) return;
  _edgeOverlays.delete(id);   // stale (parent container disposed) — rebuild
  // Clone shares the source geometry (no copy); parenting to the source and
  // zeroing the local transform keeps it coincident through every move.
  const overlay = mesh.clone(`edges_${id}`, mesh, /*doNotCloneChildren*/ true);
  if (!overlay) return;
  overlay.position.set(0, 0, 0);
  overlay.rotationQuaternion = BABYLON.Quaternion.Identity();
  overlay.rotation?.set?.(0, 0, 0);
  overlay.scaling.set(1, 1, 1);
  overlay.material   = _edgeMaterial();
  overlay.isPickable = false;
  overlay.metadata   = { edgeOverlay: true };   // never a registered meshId
  _edgeOverlays.set(id, overlay);
}

function _disposeEdgeOverlays() {
  for (const o of _edgeOverlays.values()) {
    try { o.dispose(); } catch { /* parent may already be gone */ }
  }
  _edgeOverlays.clear();
}

function _setWireframeEdgesMode(enabled) {
  _wireframeEdgeState.enabled = enabled;
  if (!enabled) { _disposeEdgeOverlays(); return; }
  for (const mesh of _scene.meshes) {
    if (!mesh.geometry || !mesh.metadata?.meshId) continue;
    _ensureEdgeOverlay(mesh);
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

/**
 * Apply viewport render settings (Scene panel / state.scene.render).
 * Partial-safe: only the fields present are touched.
 * @param {{ exposure?: number, contrast?: number,
 *           shadowsEnabled?: boolean, shadowDarkness?: number }} [render]
 */
export function applyRenderSettings(render = {}) {
  if (!_scene) return;
  const ip = _scene.imageProcessingConfiguration;
  if (Number.isFinite(render.exposure)) ip.exposure = render.exposure;
  if (Number.isFinite(render.contrast)) ip.contrast = render.contrast;
  if (_shadowGen) {
    if (Number.isFinite(render.shadowDarkness)) _shadowGen.darkness = render.shadowDarkness;
    const light = _shadowGen.getLight?.();
    if (light && typeof render.shadowsEnabled === 'boolean') {
      light.shadowEnabled = render.shadowsEnabled;
    }
  }
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
  // Predicate accepts ONLY meshes whose ancestor chain carries a registered
  // meshId — helper meshes (grid, labels, previews, edge overlays, anything
  // future) can never eat the pick by sitting in front of real content.
  const result = _scene.pick(x, y, m => {
    if (!m?.isPickable) return false;
    let node = m;
    while (node) {
      if (node.metadata?.meshId) return true;
      node = node.parent;
    }
    return false;
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
  getScene, getEngine, getShadowGenerator, getCamera,
  setCameraPreset, toggleOrthographic, frameSelected, frameAll, saveCameraState, restoreCameraState,
  setGizmoMode, setGizmoSpace, setScaleLock, setFollowMode, attachToSelection,
  setActive, setSelected,
  setOverlay, setWireframeEdgeColor, setGrid, rebuildBed, updateBedPreview, applyRenderSettings,
  getCursor, setCursor, setCursorVisible,
  pickMeshIdAt,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
};
