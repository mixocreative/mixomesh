// Environment rig (split from SceneManager.js — audit C1, 2026-06-13): the
// 3-light studio + shadow generator, the shadow-catcher floor, and HDRI
// image-based lighting. SceneManager delegates the environment half of
// applyRenderSettings here; its public surface is unchanged.

import { EVENTS } from '../events.js';
import { getState, dispatch } from '../StateManager.js';
import {
  HEMI_INTENSITY, HEMI_GROUND_COLOR, KEY_INTENSITY, FILL_INTENSITY,
  SHADOW_DARKNESS, SHADOW_BLUR_KERNEL,
} from './SceneConstants.js';

const BABYLON = window.BABYLON;

let _scene     = null;
let _lights    = null;   // { hemi, key, fill }
let _shadowGen = null;

// Shadow casters registered by uniqueId — Set lookup instead of an O(n)
// renderList.includes scan per mesh per import event (audit C3).
const _casterIds = new Set();

// Environment floor — solid-colour shadow-catcher plane. Lazily created on
// first enable; never registered (no meshId), never pickable, never exported,
// kept VISIBLE in renders (it exists for them).
let _floor = null;
let _floorMat = null;        // solid-colour material (normal viewport look)
let _floorShadowMat = null;  // ShadowOnlyMaterial — transparent-PNG capture

// HDRI environment — prefiltered .env cube textures bundled in public/env/.
// Lighting only: scene.environmentTexture drives PBR IBL while the gradient
// backdrop Layer stays the visible background.
export const HDRI_PRESETS = ['studio', 'neutral', 'outdoor'];
let _hdriTex    = null;   // live CubeTexture (kept while enabled)
let _hdriPreset = null;   // which preset _hdriTex was built from
let _prewarmed  = false;

// ── Init ─────────────────────────────────────────────────

// Neutral 3-light studio: broad hemispheric fill (sky white, soft floor
// bounce so undersides never go black), one soft key for form + a single
// gentle contact shadow, and a low opposite fill with no specular so it
// adds no second highlight. Reads flat-and-even like Fusion's default env.
export function initEnvironmentRig(scene) {
  _scene = scene;
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity   = HEMI_INTENSITY;
  hemi.diffuse     = new BABYLON.Color3(1, 1, 1);
  hemi.groundColor = BABYLON.Color3.FromHexString(HEMI_GROUND_COLOR);
  hemi.specular    = new BABYLON.Color3(0.15, 0.15, 0.15);

  const key = new BABYLON.DirectionalLight('key', new BABYLON.Vector3(-1, -2, -1), scene);
  key.intensity = KEY_INTENSITY;
  key.position  = new BABYLON.Vector3(6, 12, 6);

  const fill = new BABYLON.DirectionalLight('fill', new BABYLON.Vector3(1, -1, 1), scene);
  fill.intensity = FILL_INTENSITY;
  fill.specular  = new BABYLON.Color3(0, 0, 0);

  _lights = { hemi, key, fill };

  _shadowGen = new BABYLON.ShadowGenerator(2048, key);
  _shadowGen.useBlurExponentialShadowMap = true;
  _shadowGen.useKernelBlur = true;
  _shadowGen.blurKernel    = SHADOW_BLUR_KERNEL;
  _shadowGen.darkness      = SHADOW_DARKNESS;
  // The 2048² blurred ESM is the single largest fixed per-frame GPU cost.
  // Render it only when something actually moved (perf audit): RENDERONCE +
  // invalidateShadows() re-arms one render. Caster world-matrix updates
  // (gizmo drags, bounce-in), light moves (turntable sweep), and setting
  // changes all invalidate.
  const map = _shadowGen.getShadowMap();
  if (map) map.refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDERONCE;
}

/** @returns {BABYLON.ShadowGenerator} */
export function getShadowGenerator() { return _shadowGen; }

/** Re-render the shadow map on the next frame (it is RENDERONCE otherwise). */
export function invalidateShadows() {
  _shadowGen?.getShadowMap()?.resetRefreshCounter();
}

// Register every content mesh as a shadow caster (idempotent — _casterIds).
// Disposal self-removes so the list never holds dead meshes.
export function ensureShadowCasters() {
  const map = _shadowGen?.getShadowMap();
  if (!map) return;
  // Content = any mesh whose ancestor chain carries a registered meshId
  // (glTF parents wrap geometry-bearing children that have no id of their
  // own — same walk as pickMeshIdAt). Edge overlays never cast.
  const ownsContent = (m) => {
    let node = m;
    while (node) {
      if (node.metadata?.edgeOverlay) return false;
      if (node.metadata?.meshId) return true;
      node = node.parent;
    }
    return false;
  };
  for (const mesh of _scene.meshes) {
    if (!mesh.geometry || _casterIds.has(mesh.uniqueId) || !ownsContent(mesh)) continue;
    _casterIds.add(mesh.uniqueId);
    _shadowGen.addShadowCaster(mesh, false);
    // Movement (gizmo drag, bounce-in, programmatic transforms) re-renders
    // the RENDERONCE shadow map; static frames skip it entirely.
    const obs = mesh.onAfterWorldMatrixUpdateObservable.add(invalidateShadows);
    mesh.onDisposeObservable.addOnce(() => {
      mesh.onAfterWorldMatrixUpdateObservable.remove(obs);
      _casterIds.delete(mesh.uniqueId);
      _shadowGen?.removeShadowCaster(mesh, false);
      invalidateShadows();
    });
  }
  invalidateShadows();
}

// ── Settings (environment half of applyRenderSettings) ──

// Partial-safe like the rest of applyRenderSettings: only the fields present
// are touched.
export function applyEnvironmentSettings(render = {}) {
  if (!_scene) return;
  if (_shadowGen) {
    if (Number.isFinite(render.shadowDarkness)) {
      _shadowGen.darkness = render.shadowDarkness;
      invalidateShadows();
    }
    const light = _shadowGen.getLight?.();
    if (light && typeof render.shadowsEnabled === 'boolean') {
      light.shadowEnabled = render.shadowsEnabled;
      if (render.shadowsEnabled) invalidateShadows();
    }
  }
  if (_lights) {
    if (Number.isFinite(render.hemiIntensity)) _lights.hemi.intensity = render.hemiIntensity;
    if (Number.isFinite(render.keyIntensity))  _lights.key.intensity  = render.keyIntensity;
    if (Number.isFinite(render.fillIntensity)) _lights.fill.intensity = render.fillIntensity;
  }
  _updateFloor(render);
  _updateHdri(render);
}

// ── Environment floor ────────────────────────────────────

// Sized generously off the printer bed so shadows of framed content always
// land on it.
function _updateFloor(render) {
  if (typeof render.floorEnabled === 'boolean') {
    if (render.floorEnabled && !_floor) {
      // Round disc (was a square ground). Built as a unit disc — radius 0.5 ⇒
      // 1 BU diameter — and SCALED to the requested diameter, so a diameter
      // change never rebuilds the mesh. Rotated flat (normal +Y).
      _floor = BABYLON.MeshBuilder.CreateDisc('mx-env-floor', { radius: 0.5, tessellation: 96 }, _scene);
      _floor.rotation.x = Math.PI / 2;
      _floor.isPickable = false;
      _floor.receiveShadows = true;
      _floorMat = new BABYLON.StandardMaterial('mx-env-floor-mat', _scene);
      _floorMat.specularColor = new BABYLON.Color3(0, 0, 0);   // matte — no hot highlight
      _floorMat.backFaceCulling = false;                       // visible from below
      _floor.material = _floorMat;
      _applyFloorDiameter(render.floorDiameterMM);
    }
    if (_floor) _floor.setEnabled(render.floorEnabled);
  }
  if (!_floor) return;
  if ('floorDiameterMM' in render) _applyFloorDiameter(render.floorDiameterMM);
  if (typeof render.floorColor === 'string') {
    try { _floorMat.diffuseColor = BABYLON.Color3.FromHexString(render.floorColor); } catch { /* keep */ }
  }
  if (Number.isFinite(render.floorZMM)) {
    // 0.05 mm below the requested height — at the default Z=0 the bed grid
    // ground sits at exactly y=0 and an opaque coplanar floor would z-fight.
    _floor.position.y = render.floorZMM / 1000 - 0.00005;
  }
}

// Diameter in mm → uniform XY scale on the unit disc. ≤0 / unset = AUTO
// (4× the largest bed dimension — the legacy square-floor size).
function _applyFloorDiameter(mm) {
  if (!_floor) return;
  const bed = getState().print.bedDimensions;
  const autoMM = Math.max(bed.x, bed.y) * 4;
  const diaMM = Number.isFinite(mm) && mm > 0 ? mm : autoMM;
  const d = diaMM / 1000;                 // mm → BU (= disc diameter, radius 0.5×d)
  _floor.scaling.set(d, d, 1);
}

/**
 * Swap the floor between its solid-colour material and a shadow-only one.
 * Transparent PNG capture uses this so an enabled floor contributes ONLY its
 * caught shadow to the alpha channel instead of an opaque plane — model +
 * floating soft shadow composite onto anything. No-op when the floor is off.
 * @param {boolean} on  true = shadow-catcher only
 */
export function setFloorShadowOnly(on) {
  if (!_floor || !_floor.isEnabled()) return;
  if (on) {
    if (!_floorShadowMat) {
      _floorShadowMat = new BABYLON.ShadowOnlyMaterial('mx-env-floor-shadow', _scene);
      const keyLight = _shadowGen?.getLight?.();
      if (keyLight) _floorShadowMat.activeLight = keyLight;
    }
    _floor.material = _floorShadowMat;
  } else {
    _floor.material = _floorMat;
  }
}

// ── HDRI environment lighting ────────────────────────────

// Texture is created on first enable / preset change and disposed on preset
// change; toggling off detaches it from the scene but keeps it cached for
// cheap re-enable. HDRI_STATUS events give the UI load/error feedback (the
// .env streams in over ~0.2–1 MB — lighting pops without it).
function _updateHdri(render) {
  if (typeof render.hdriPreset === 'string' && HDRI_PRESETS.includes(render.hdriPreset)
      && render.hdriPreset !== _hdriPreset && _hdriTex) {
    _hdriTex.dispose();
    _hdriTex = null;
    _hdriPreset = null;
  }
  if (typeof render.hdriEnabled === 'boolean') {
    if (render.hdriEnabled) {
      const preset = HDRI_PRESETS.includes(render.hdriPreset) ? render.hdriPreset
                   : (_hdriPreset ?? 'studio');
      if (!_hdriTex) {
        _hdriTex = BABYLON.CubeTexture.CreateFromPrefilteredData(`env/${preset}.env`, _scene);
        _hdriPreset = preset;
        _hdriTex.onLoadObservable?.addOnce(() =>
          dispatch(EVENTS.HDRI_STATUS, { status: 'loaded', preset }));
        _hdriTex.getInternalTexture?.()?.onErrorObservable?.addOnce(() =>
          dispatch(EVENTS.HDRI_STATUS, { status: 'error', preset }));
        _prewarmOtherPresets(preset);
      }
      _scene.environmentTexture = _hdriTex;
    } else {
      _scene.environmentTexture = null;
    }
  }
  if (Number.isFinite(render.hdriIntensity)) {
    _scene.environmentIntensity = Math.max(0, Math.min(4, render.hdriIntensity));
  }
}

// Warm the HTTP cache for the presets the user hasn't picked yet, off the
// critical path — switching presets then reads from cache instead of the
// network (perf audit #5).
function _prewarmOtherPresets(current) {
  if (_prewarmed) return;
  _prewarmed = true;
  const idle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback : (fn) => setTimeout(fn, 2000);
  idle(() => {
    for (const p of HDRI_PRESETS) {
      // Intentionally silent: idle cache prewarm — a miss just means the
      // preset loads from network when picked (Status policy, local recovery).
      if (p !== current) fetch(`env/${p}.env`, { priority: 'low' }).catch(() => {});
    }
  });
}
