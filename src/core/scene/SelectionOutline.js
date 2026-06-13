// Custom selection silhouette (split from SceneManager.js — review L29).
//
// Why custom: Babylon's HighlightLayer composites via stencil, but the stencil
// is only reliably written for materials with `transparencyMode === OPAQUE`.
// Many glTF PBR materials report some alpha mode even when visually opaque,
// which leaves the stencil unset → the halo's gaussian blur is added on top
// of the mesh face. We instead render selected meshes into our own mask
// render-target (forcing an opaque emissive override), then a fullscreen pass
// dilates the mask and subtracts the original silhouette so by construction
// the ring exists ONLY outside the mesh.

import {
  ACCENT_HEX,
  OUTLINE_RADIUS_PX,
  OUTLINE_INTENSITY,
  MASK_BRIGHTNESS_ACTIVE,
  MASK_BRIGHTNESS_SELECTED,
} from './SceneConstants.js';

const BABYLON = window.BABYLON;

let _engine = null;
let _scene  = null;
let _camera = null;
let _outlineActive = false;        // pass + mask RTT gated on a non-empty selection
let _selMaskRTT          = null;   // RenderTargetTexture
let _selMaskMatActive    = null;   // override for active mesh — full intensity
let _selMaskMatSelected  = null;   // override for selected non-active — dim
let _outlinePass         = null;
const _maskMeshes  = new Set();

// Module-local tracking — setActive + setSelected are called separately by
// Selection.js, so we accumulate and refresh once.
let _activeForOutline   = null;
let _selectedForOutline = [];

/** Build mask materials, mask RTT, and the fullscreen outline pass. */
export function initSelectionOutline(scene, engine, camera) {
  _engine = engine;
  _scene  = scene;
  _camera = camera;
  const ACCENT_COLOR = BABYLON.Color3.FromHexString(ACCENT_HEX);

  _selMaskMatActive = new BABYLON.StandardMaterial('mx-sel-mask-active', scene);
  _selMaskMatActive.emissiveColor   = new BABYLON.Color3(MASK_BRIGHTNESS_ACTIVE, MASK_BRIGHTNESS_ACTIVE, MASK_BRIGHTNESS_ACTIVE);
  _selMaskMatActive.diffuseColor    = new BABYLON.Color3(0, 0, 0);
  _selMaskMatActive.disableLighting = true;
  _selMaskMatActive.backFaceCulling = false;

  _selMaskMatSelected = new BABYLON.StandardMaterial('mx-sel-mask-selected', scene);
  _selMaskMatSelected.emissiveColor   = new BABYLON.Color3(MASK_BRIGHTNESS_SELECTED, MASK_BRIGHTNESS_SELECTED, MASK_BRIGHTNESS_SELECTED);
  _selMaskMatSelected.diffuseColor    = new BABYLON.Color3(0, 0, 0);
  _selMaskMatSelected.disableLighting = true;
  _selMaskMatSelected.backFaceCulling = false;

  _selMaskRTT = new BABYLON.RenderTargetTexture(
    'mx-sel-mask-rt', { ratio: 0.5 }, scene, false
  );
  _selMaskRTT.clearColor   = new BABYLON.Color4(0, 0, 0, 0);
  _selMaskRTT.renderList   = [];
  _selMaskRTT.activeCamera = camera;
  _selMaskRTT.refreshRate  = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
  // Keep SSAO's geometry prePass OFF this RTT. Without this the prePass
  // renderer attaches a full MRT (color/normal/depth) pass to the mask
  // target and re-renders all scene geometry into it every frame — on a
  // heavy import (80k tris + 4096² texture) that doubled the per-frame GPU
  // cost into ~240 ms stalls that read as a frozen import.
  _selMaskRTT.noPrePassRenderer = true;
  scene.customRenderTargets.push(_selMaskRTT);

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
    1.0, camera, BABYLON.Texture.BILINEAR_SAMPLINGMODE
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

  // Gate OFF until something is selected: the 64-tap fullscreen outline pass
  // and the mask RTT render were running EVERY frame even with an empty
  // selection — pure waste, and costly at 4K over heavy scenes (perf goal
  // 2026-06-13). _refreshOutlineSet re-enables them when a selection exists.
  // The PostProcess ctor just attached the pass and the mask RTT is already
  // in customRenderTargets, so the live state IS "on" — reflect that before
  // toggling off, or the early-out guard would skip the detach.
  _outlineActive = true;
  _setOutlineEnabled(false);
}

// Attach/detach the outline post-process + the mask render-target together.
// Detached, neither costs anything per frame; the common "nothing selected"
// state is free.
function _setOutlineEnabled(on) {
  if (on === _outlineActive) return;
  _outlineActive = on;
  if (on) {
    if (_scene && !_scene.customRenderTargets.includes(_selMaskRTT)) {
      _scene.customRenderTargets.push(_selMaskRTT);
    }
    _camera?.attachPostProcess(_outlinePass);
  } else {
    const i = _scene ? _scene.customRenderTargets.indexOf(_selMaskRTT) : -1;
    if (i >= 0) _scene.customRenderTargets.splice(i, 1);
    _camera?.detachPostProcess(_outlinePass);
  }
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
  _setOutlineEnabled(entries.length > 0);
}
