import { EVENTS } from './events.js';
import { subscribe, getState } from './StateManager.js';
import {
  AXES_SIZE,
  CURSOR_DIAMETER,
  BG_GRADIENT_TOP,
  BG_GRADIENT_BOTTOM,
  BG_DARK_TOP,
  BG_DARK_BOTTOM,
  TONE_CONTRAST,
  TONE_EXPOSURE,
} from './scene/SceneConstants.js';
import {
  initEnvironmentRig, applyEnvironmentSettings, ensureShadowCasters,
  getShadowGenerator, invalidateShadows, setFloorShadowOnly,
} from './scene/EnvironmentRig.js';
import { initViewEffects, applyViewEffects, setSectionPlane, registerSectionMeshes } from './scene/ViewEffects.js';
import { initImportBounce } from './scene/ImportBounce.js';
import {
  initEdgeOverlay, isEdgeOverlayEnabled, setWireframeEdgesMode, setWireframeEdgeColor,
} from './scene/EdgeOverlay.js';
import { initAdaptiveResolution } from './scene/AdaptiveResolution.js';
import { initSelectionOutline, setActive, setSelected } from './scene/SelectionOutline.js';
import {
  initBedGrid, rebuildGround as _rebuildGround, setGrid as _bedSetGrid,
  setGroundVisible, updateBedPreview as _bedUpdatePreview, disposeBedPreview,
} from './scene/BedGrid.js';
import {
  initCameraRig, getCamera, applyCameraOptics,
  setCameraPreset, toggleOrthographic, frameAll, frameSelected,
  saveCameraState, restoreCameraState, setFollowMode,
} from './scene/CameraRig.js';
import {
  initPivotSession, setTransformCommitHandler,
  setGizmoMode, setGizmoSpace, setScaleLock, attachToSelection,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
} from './scene/PivotSession.js';

// Selection silhouette, bed/grid, camera rig, pivot session, environment
// (lights/shadows/floor/HDRI), view effects (SSAO/section), and import bounce
// live in scene/*.js (review L29 split + §0.5 budget + audit C1); re-exported
// so the SceneManager surface is unchanged.
export { setActive, setSelected };
export { getShadowGenerator, invalidateShadows, setFloorShadowOnly, setSectionPlane };
export { setWireframeEdgeColor };
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
let _bgTexture = null;   // gradient DynamicTexture — repainted on bg toggle
let _bgLayer   = null;   // background Layer — disabled for transparent renders
let _bgMode    = 'light';

// Print preview material tracking
const _printPreviewMaterialMap = new Map(); // materialId → { originalMetallic }

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
  // NOTE: device-pixel-ratio is handled by initAdaptiveResolution (capped +
  // dynamic), NOT the raw adaptToDeviceRatio — full DPR on a 2×/4K display is
  // 4× the fragments and tanks heavy 4096²/high-poly print scenes.

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
  initEnvironmentRig(_scene);
  initBedGrid(_scene);
  _setupAxes();
  initSelectionOutline(_scene, _engine, camera);
  initViewEffects(_scene, camera);
  initImportBounce(_scene);
  initEdgeOverlay(_scene);
  _setupCursor();
  initPivotSession(_scene, { getCursorPosition: getCursor });
  // Cap effective DPR + safety-valve dynamic downscale for heavy scenes.
  initAdaptiveResolution(_engine);

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
  // Same rule for the wireframe-edges overlay. Shadow casters too: the
  // ShadowGenerator's renderList starts empty, so every registered mesh must
  // be added (without this the bed/floor receiveShadows but nothing casts).
  subscribe(EVENTS.ASSET_INSTANTIATED, () => {
    if (getState().scene.overlays?.printPreview) _setPrintPreviewMode(true);
    if (isEdgeOverlayEnabled()) setWireframeEdgesMode(true);
    ensureShadowCasters();
    registerSectionMeshes();
  });
  subscribe(EVENTS.PROJECT_LOADED, () => { ensureShadowCasters(); registerSectionMeshes(); });

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
  _bgTexture = new BABYLON.DynamicTexture('mx-bg-gradient', { width: 4, height: 512 }, _scene, false);
  _bgTexture.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
  _bgTexture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
  _paintBackground('light');

  _bgLayer = new BABYLON.Layer('mx-bg', null, _scene, /* isBackground */ true);
  _bgLayer.texture = _bgTexture;
}

/**
 * Enable/disable the gradient backdrop. Used by transparent PNG capture:
 * off → layer skipped AND clearColor alpha 0, so the RTT screenshot keeps
 * real alpha. Always restore to true afterwards.
 * @param {boolean} on
 */
export function setBackgroundEnabled(on) {
  if (!_scene) return;
  if (_bgLayer) _bgLayer.isEnabled = !!on;
  if (on) {
    const bottom = _bgMode === 'dark' ? BG_DARK_BOTTOM : BG_GRADIENT_BOTTOM;
    _scene.clearColor = BABYLON.Color4.FromHexString(bottom + 'ff');
  } else {
    _scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
  }
}

/** Repaint the gradient backdrop. @param {'light'|'dark'} mode */
function _paintBackground(mode) {
  if (!_bgTexture) return;
  _bgMode = mode;
  const top    = mode === 'dark' ? BG_DARK_TOP    : BG_GRADIENT_TOP;
  const bottom = mode === 'dark' ? BG_DARK_BOTTOM : BG_GRADIENT_BOTTOM;
  const ctx = _bgTexture.getContext();
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  _bgTexture.update();
  // Fallback solid (pre-layer frames + screenshot edges) tracks the bottom.
  _scene.clearColor = BABYLON.Color4.FromHexString(bottom + 'ff');
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
      setWireframeEdgesMode(on);
      break;
    case 'bedPreview':
      if (on) _bedUpdatePreview(getState().print.bedDimensions);
      else disposeBedPreview();
      break;
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
 *           shadowsEnabled?: boolean, shadowDarkness?: number,
 *           background?: 'light'|'dark',
 *           keyIntensity?: number, fillIntensity?: number, hemiIntensity?: number,
 *           fovDeg?: number, clipNearMM?: number,
 *           toneMapping?: 'aces'|'standard'|'neutral'|'off',
 *           saturation?: number, vignette?: boolean, vignetteWeight?: number }} [render]
 */
export function applyRenderSettings(render = {}) {
  if (!_scene) return;
  const ip = _scene.imageProcessingConfiguration;
  if (Number.isFinite(render.exposure)) ip.exposure = render.exposure;
  if (Number.isFinite(render.contrast)) ip.contrast = render.contrast;
  if (typeof render.toneMapping === 'string') {
    const IPC = BABYLON.ImageProcessingConfiguration;
    const TYPES = {
      aces:     IPC.TONEMAPPING_ACES,
      standard: IPC.TONEMAPPING_STANDARD,
      neutral:  IPC.TONEMAPPING_KHR_PBR_NEUTRAL ?? IPC.TONEMAPPING_ACES,
    };
    if (render.toneMapping === 'off') {
      ip.toneMappingEnabled = false;
    } else if (render.toneMapping in TYPES) {
      ip.toneMappingEnabled = true;
      ip.toneMappingType    = TYPES[render.toneMapping];
    }
  }
  if (Number.isFinite(render.saturation)) {
    // colorCurves only sampled when both flags are on; keep them off at
    // neutral so untouched projects skip the extra shader work.
    const sat = Math.max(-100, Math.min(100, render.saturation));
    ip.colorCurvesEnabled = sat !== 0;
    if (!ip.colorCurves) ip.colorCurves = new BABYLON.ColorCurves();
    ip.colorCurves.globalSaturation = sat;
  }
  if (typeof render.vignette === 'boolean') ip.vignetteEnabled = render.vignette;
  if (Number.isFinite(render.vignetteWeight)) ip.vignetteWeight = render.vignetteWeight;
  if ((render.background === 'light' || render.background === 'dark') &&
      render.background !== _bgMode) {
    _paintBackground(render.background);
  }
  // Lights / shadows / floor / HDRI — scene/EnvironmentRig.js (audit C1).
  applyEnvironmentSettings(render);
  // SSAO + section plane — scene/ViewEffects.js.
  applyViewEffects(render);
  applyCameraOptics(render);
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
  setBackgroundEnabled, setFloorShadowOnly, setSectionPlane, invalidateShadows,
  getCursor, setCursor, setCursorVisible,
  pickMeshIdAt,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
};
