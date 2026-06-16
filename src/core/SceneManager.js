import { EVENTS } from './events.js';
import { subscribe, getState } from './StateManager.js';
import {
  AXES_SIZE,
  BG_GRADIENT_TOP,
  BG_GRADIENT_BOTTOM,
  BG_DARK_TOP,
  BG_DARK_BOTTOM,
  TONE_CONTRAST,
  TONE_EXPOSURE,
  OUTLINE_ACTIVE_HEX,
  OUTLINE_SELECTED_HEX,
  OUTLINE_ACTIVE_LIGHT_HEX,
  OUTLINE_SELECTED_LIGHT_HEX,
  CURSOR_HEX,
  CURSOR_LIGHT_HEX,
} from './scene/SceneConstants.js';
import {
  initEnvironmentRig, applyEnvironmentSettings, ensureShadowCasters,
  getShadowGenerator, invalidateShadows, setFloorShadowOnly,
} from './scene/EnvironmentRig.js';
import { initViewEffects, applyViewEffects, setSectionPlane, registerSectionMeshes, setSectionVizVisible, isSectionVizVisible, getSectionExtentMM } from './scene/ViewEffects.js';
import { initImportBounce } from './scene/ImportBounce.js';
import { initBackfaceCheck, setBackfaceCheck, refreshBackfaceClones, isBackfaceCheckOn } from './scene/BackfaceCheck.js';
import {
  initEdgeOverlay, isEdgeOverlayEnabled, setWireframeEdgesMode, setWireframeEdgeColor,
} from './scene/EdgeOverlay.js';
import { initAdaptiveResolution } from './scene/AdaptiveResolution.js';
import { initSelectionOutline, setActive, setSelected, setOutlineColors, setOutlineLightMode } from './scene/SelectionOutline.js';
import { initCursor3D, getCursor, setCursor, setCursorVisible, isCursorVisible, setCursorFromState, setCursorColor } from './scene/Cursor3D.js';
import {
  initBedGrid, rebuildGround as _rebuildGround, setGrid as _bedSetGrid,
  setGroundVisible, updateBedPreview as _bedUpdatePreview, disposeBedPreview,
} from './scene/BedGrid.js';
import {
  initCameraRig, getCamera, applyCameraOptics,
  setCameraPreset, toggleOrthographic, frameAll, frameSelected,
  saveCameraState, restoreCameraState, setFollowMode, suspendFollow,
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
export { getShadowGenerator, invalidateShadows, setFloorShadowOnly, setSectionPlane, getSectionExtentMM };
export { setWireframeEdgeColor };
export {
  setCameraPreset, toggleOrthographic, frameAll, frameSelected,
  saveCameraState, restoreCameraState, setFollowMode, suspendFollow,
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
let _bgTexture = null;   // gradient DynamicTexture — repainted on bg toggle
let _bgLayer   = null;   // background Layer — disabled for transparent renders
let _bgMode    = 'light';

// Print preview material tracking
const _printPreviewMaterialMap = new Map(); // materialId → { originalMetallic }
const _baseColorMaterialMap = new Map();    // materialId → { unlit, disableLighting, emissive }
const _uvCheckerMaterialMap = new Map();    // materialId → { key, tex } (original base texture)
let _uvCheckerTex = null;                   // shared checker DynamicTexture

// ── Init ─────────────────────────────────────────────────

/**
 * Initialise Babylon engine, scene, camera, lights, and all overlays.
 * Async because the WebGPU engine boots asynchronously (`initAsync`).
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<void>}
 */
export async function init(canvas) {
  _engine = await _createEngine(canvas);
  // NOTE: device-pixel-ratio is handled by initAdaptiveResolution (capped +
  // dynamic), NOT the raw adaptToDeviceRatio — full DPR on a 2×/4K display is
  // 4× the fragments and tanks heavy 4096²/high-poly print scenes.

  _scene = new BABYLON.Scene(_engine);
  // Fallback solid = gradient base, so any frame before the backdrop layer
  // draws (and screenshot edges) matches instead of flashing black.
  _scene.clearColor   = BABYLON.Color4.FromHexString(BG_GRADIENT_BOTTOM + 'ff');
  _scene.ambientColor = new BABYLON.Color3(1, 1, 1);

  // SINGLE SOURCE for the shaderless / resin-grey look. `scene.defaultMaterial`
  // is what Babylon renders for material-less FACES, AND `AssetLoader` assigns
  // this exact instance to material-less OBJECTS (STL / missing) — so both cases
  // share one material. Tune the grey HERE and both follow. Matte medium grey
  // (0.5, not lighter — the bright 3-light studio + ACES + exposure washes a
  // 0.72 grey to near-white; 0.5 reads as clear grey once lit).
  const _dm = _scene.defaultMaterial;
  if (_dm?.diffuseColor)  _dm.diffuseColor  = new BABYLON.Color3(0.4, 0.4, 0.4);
  // Subtle satin sheen — a small, broad specular reads like cured resin (not
  // fully matte, not glossy plastic).
  if (_dm?.specularColor) _dm.specularColor = new BABYLON.Color3(0.10, 0.10, 0.10);
  if ('specularPower' in (_dm ?? {})) _dm.specularPower = 48;

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
  initBackfaceCheck(_scene);
  initEdgeOverlay(_scene);
  initCursor3D(_scene);
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
    if (getState().scene.overlays?.baseColorView) _setBaseColorMode(true);
    if (getState().scene.overlays?.uvCheckerView) _setUvCheckerMode(true);
    if (isEdgeOverlayEnabled()) setWireframeEdgesMode(true);
    if (isBackfaceCheckOn()) refreshBackfaceClones();
    ensureShadowCasters();
    registerSectionMeshes();
  });
  subscribe(EVENTS.PROJECT_LOADED, () => {
    ensureShadowCasters();
    registerSectionMeshes();
    if (isBackfaceCheckOn()) refreshBackfaceClones();
  });

  // Workspace/panel layout changes resize the grid cell the canvas lives in —
  // resize the engine on the next frame so the framebuffer matches (13b).
  const _resizeNextFrame = () => requestAnimationFrame(() => _engine?.resize());
  subscribe(EVENTS.WORKSPACE_CHANGED, _resizeNextFrame);
  subscribe(EVENTS.PANEL_COLLAPSED_CHANGED, _resizeNextFrame);
}

// ── Engine creation ──────────────────────────────────────

// Prefer WebGPU — lower draw-call overhead, compute, and a far higher ceiling
// on the heavy 4096²/high-poly print scenes this tool targets. Fall back to
// WebGL on ANY failure (unsupported browser, init throw, lost adapter) so the
// app never hard-stops. All capture is RTT-based (thumbnail / PNG / turntable),
// so `preserveDrawingBuffer` is unnecessary on either engine.
async function _createEngine(canvas) {
  try {
    // Race the WHOLE WebGPU attempt (support probe + device init) against a
    // timeout — both `requestAdapter` and `initAsync` can hang forever on a
    // present-but-stuck adapter (some headless / virtualised GPUs), which would
    // brick boot. Timeout or throw → fall through to WebGL.
    const engine = await _withTimeout(_tryWebGPU(canvas), 8000, 'WebGPU init');
    if (engine) return engine;
  } catch (err) {
    console.warn('WebGPU engine init failed — falling back to WebGL:', err);
  }
  return new BABYLON.Engine(canvas, true, { stencil: true });
}

async function _tryWebGPU(canvas) {
  // OPT-IN ONLY (`?engine=webgpu` or `localStorage.mxEngine='webgpu'`; the URL
  // param wins so `?engine=webgl` is a force-off escape hatch). WebGPU is fully
  // functional now — engine +
  // WGSL selection-outline twin + ALL capture (PNG / video / thumbnail) verified
  // correct on a real adapter (`WEBGPU_HEADFUL=1 npm run test:webgpu`); the old
  // capture blocker (empty readback) was the missing command-buffer flush, fixed
  // in RenderOutput. It stays opt-in only because it's been verified on a single
  // GPU/driver so far — flipping the default to prefer WebGPU is now a safe
  // one-liner once it's been exercised on more hardware. Note: the print export
  // itself is engine-independent (textures read source bytes, geometry reads mesh
  // data — neither touches the GPU), so WebGPU never threatens the Mimaki LOCK.
  if (_preferredEngine() !== 'webgpu') return null;
  if (!BABYLON.WebGPUEngine || !navigator.gpu) return null;
  if (!(await BABYLON.WebGPUEngine.IsSupportedAsync)) return null;
  const engine = new BABYLON.WebGPUEngine(canvas, { stencil: true, antialias: true });
  await engine.initAsync();
  return engine;
}

// Engine preference: `?engine=` URL param wins (so `?engine=webgl` is an escape
// hatch that always forces WebGL), then a persisted `localStorage.mxEngine`
// (lets the user live on WebGPU without re-typing the param), else WebGL.
function _preferredEngine() {
  try {
    const q = new URLSearchParams(location.search).get('engine');
    if (q === 'webgpu' || q === 'webgl') return q;
    const ls = localStorage.getItem('mxEngine');
    if (ls === 'webgpu' || ls === 'webgl') return ls;
  } catch { /* no window/localStorage (tests) */ }
  return 'webgl';
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** @returns {boolean} true when the live engine is the WebGPU backend. */
export function isWebGPU() {
  return !!_engine?.isWebGPU;
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

// Lerp a hex toward black (k=0 → black, k=1 → hex). Used by the dark
// intensity slider so the user can push dark mode toward pitch black.
function _scaleHex(hex, k) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) * k;
  const g = parseInt(h.slice(2, 4), 16) * k;
  const b = parseInt(h.slice(4, 6), 16) * k;
  const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
// Lerp a hex toward white (k=0 → white, k=1 → hex). Light slider mirror.
function _liftHex(hex, k) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to2(r + (255 - r) * (1 - k))}${to2(g + (255 - g) * (1 - k))}${to2(b + (255 - b) * (1 - k))}`;
}

/** Repaint the gradient backdrop. @param {'light'|'dark'} mode */
function _paintBackground(mode) {
  if (!_bgTexture) return;
  _bgMode = mode;
  const render = getState().scene?.render ?? {};
  const darkK  = Number.isFinite(render.darkIntensity)  ? Math.max(0, Math.min(1, render.darkIntensity))  : 1;
  const lightK = Number.isFinite(render.lightIntensity) ? Math.max(0, Math.min(1, render.lightIntensity)) : 1;
  let top, bottom;
  if (mode === 'dark') {
    top    = _scaleHex(BG_DARK_TOP,    darkK);
    bottom = _scaleHex(BG_DARK_BOTTOM, darkK);
  } else {
    top    = _liftHex(BG_GRADIENT_TOP,    lightK);
    bottom = _liftHex(BG_GRADIENT_BOTTOM, lightK);
  }
  const ctx = _bgTexture.getContext();
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  _bgTexture.update();
  // Fallback solid (pre-layer frames + screenshot edges) tracks the bottom.
  _scene.clearColor = BABYLON.Color4.FromHexString(bottom + 'ff');
  // Selection outline + 3D cursor flip to darker tones on light bg so they
  // stay readable; the outline shader also flips from additive (glow) to
  // alpha-blend (solid replace) — additive of any color on near-white scene
  // saturates to white = invisible.
  if (mode === 'light') {
    setOutlineColors(OUTLINE_ACTIVE_LIGHT_HEX, OUTLINE_SELECTED_LIGHT_HEX);
    setOutlineLightMode(true);
    setCursorColor(CURSOR_LIGHT_HEX);
  } else {
    setOutlineColors(OUTLINE_ACTIVE_HEX, OUTLINE_SELECTED_HEX);
    setOutlineLightMode(false);
    setCursorColor(CURSOR_HEX);
  }
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
 * @param {'grid'|'axes'|'wireframe'|'wireframeEdges'|'printPreview'|'baseColorView'|'uvCheckerView'|'invertedFaces'|'bedPreview'} name
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
    case 'baseColorView':
      _setBaseColorMode(on);
      break;
    case 'invertedFaces':
      setBackfaceCheck(on);
      break;
    case 'uvCheckerView':
      _setUvCheckerMode(on);
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
      if (!_isInspectableMesh(mesh)) continue;

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

/**
 * Base-color (flat albedo) inspection mode — shows what Mimaki actually inks,
 * unlit. PBR → `unlit`; Standard → `disableLighting` with diffuse copied to
 * emissive so the colour still shows. Stores + restores per material, exactly
 * like print-preview's metallic swap (viewport-only; export reads source).
 */
function _setBaseColorMode(enabled) {
  if (enabled) {
    for (const mesh of _scene.meshes) {
      if (!_isInspectableMesh(mesh)) continue;
      const mat = mesh.material;
      const matId = mat.uniqueId.toString();
      if (!_baseColorMaterialMap.has(matId)) {
        _baseColorMaterialMap.set(matId, {
          unlit: mat.unlit,
          disableLighting: mat.disableLighting,
          emissive: mat.emissiveColor?.clone?.() ?? null,
        });
      }
      if ('unlit' in mat) {
        mat.unlit = true;                                   // PBR — flat albedo
      } else if ('disableLighting' in mat) {
        if (mat.diffuseColor && mat.emissiveColor) mat.emissiveColor = mat.diffuseColor.clone();
        mat.disableLighting = true;                         // StandardMaterial
      }
    }
  } else {
    for (const mesh of _scene.meshes) {
      const mat = mesh.material;
      if (!mat) continue;
      const stored = _baseColorMaterialMap.get(mat.uniqueId.toString());
      if (!stored) continue;
      if ('unlit' in mat) mat.unlit = stored.unlit ?? false;
      else if ('disableLighting' in mat) {
        mat.disableLighting = stored.disableLighting ?? false;
        if (stored.emissive && mat.emissiveColor) mat.emissiveColor = stored.emissive;
      }
    }
    _baseColorMaterialMap.clear();
  }
}

// Shared UV-checker texture — an 8×8 grey checker with amber grid lines, mapped
// by each mesh's own UVs so stretching / density / seams are visible. Wrap so
// UVs outside 0–1 tile.
function _ensureCheckerTexture() {
  if (_uvCheckerTex) return _uvCheckerTex;
  const N = 512, cells = 8, s = N / cells;
  const tex = new BABYLON.DynamicTexture('mx-uv-checker', N, _scene, false);
  const ctx = tex.getContext();
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#3a3a3a' : '#d0d0d0';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';   // accent grid lines
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, N);
    ctx.moveTo(0, i * s); ctx.lineTo(N, i * s); ctx.stroke();
  }
  tex.update();
  tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
  tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
  _uvCheckerTex = tex;
  return tex;
}

function _isContentMesh(mesh) {
  let node = mesh;
  while (node) { if (node.metadata?.meshId) return true; node = node.parent; }
  return false;
}

// A material an inspection mode may safely mutate: a real content mesh, never
// the cross-section cap / back-face viz clones or the grid/floor/bed/FRONT
// furniture (mutating those captures wrong "originals" + bleeds the look).
function _isInspectableMesh(mesh) {
  return !!mesh?.material
    && !mesh.metadata?.sectionPlaneViz
    && !mesh.metadata?.backfaceViz
    && _isContentMesh(mesh);
}

/**
 * UV-checker inspection mode — swaps each CONTENT material's base texture for a
 * checker (shows UV density / stretching / seams; a flat result = no UVs).
 * Stores + restores the original texture like the other modes (viewport-only;
 * export reads the frozen TextureSource, not the checker). Skips furniture +
 * the section/back-face viz clones.
 */
function _setUvCheckerMode(enabled) {
  if (enabled) {
    const checker = _ensureCheckerTexture();
    for (const mesh of _scene.meshes) {
      const mat = mesh.material;
      if (!mat || mesh.metadata?.sectionPlaneViz || mesh.metadata?.backfaceViz) continue;
      if (!_isContentMesh(mesh)) continue;
      const matId = mat.uniqueId.toString();
      const key = 'albedoTexture' in mat ? 'albedoTexture' : 'diffuseTexture' in mat ? 'diffuseTexture' : null;
      if (!key) continue;
      if (!_uvCheckerMaterialMap.has(matId)) _uvCheckerMaterialMap.set(matId, { key, tex: mat[key] });
      mat[key] = checker;
    }
  } else {
    for (const mesh of _scene.meshes) {
      const mat = mesh.material;
      if (!mat) continue;
      const stored = _uvCheckerMaterialMap.get(mat.uniqueId.toString());
      if (stored) mat[stored.key] = stored.tex;
    }
    _uvCheckerMaterialMap.clear();
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
  if (render.background === 'light' || render.background === 'dark') {
    // Repaint when mode changes OR when an intensity slider moved — the
    // gradient hex pair depends on both. _paintBackground reads the live
    // intensities from state.
    _paintBackground(render.background);
  }
  // Lights / shadows / floor / HDRI — scene/EnvironmentRig.js (audit C1).
  applyEnvironmentSettings(render);
  // SSAO + section plane — scene/ViewEffects.js.
  applyViewEffects(render);
  applyCameraOptics(render);
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
  init, isWebGPU, setTransformCommitHandler,
  getScene, getEngine, getShadowGenerator, getCamera,
  setCameraPreset, toggleOrthographic, frameSelected, frameAll, saveCameraState, restoreCameraState,
  setGizmoMode, setGizmoSpace, setScaleLock, setFollowMode, suspendFollow, attachToSelection,
  setActive, setSelected,
  setOverlay, setWireframeEdgeColor, setGrid, rebuildBed, updateBedPreview, applyRenderSettings,
  setBackgroundEnabled, setFloorShadowOnly, setSectionPlane, invalidateShadows,
  setSectionVizVisible, isSectionVizVisible, getSectionExtentMM,
  getCursor, setCursor, setCursorVisible, isCursorVisible, setCursorFromState,
  pickMeshIdAt,
  getBodyDragPlaneY, beginBodyDrag, setBodyDragOffset, endBodyDrag, cancelBodyDrag,
};
