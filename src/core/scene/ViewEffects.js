// View effects (audit feature wave 2026-06-13): SSAO contact darkening and
// the cross-section clip plane. Both are VIEWPORT inspection/shading tools:
//
// - SSAO (SSAO2RenderingPipeline) attaches to the nav camera's post chain.
//   The RTT capture paths (PNG / offline video) deliberately skip camera
//   post-processes (that is what keeps the selection silhouette out of
//   renders), so SSAO does not appear in exports — documented behaviour.
// - The section plane applies scene.clipPlane per CONTENT mesh only (set in
//   onBeforeRender, cleared in onAfterRender), so the grid, floor, axes and
//   backdrop are never sliced. Content meshes render through Mesh.render()
//   in RTT captures too, so the cut DOES appear in PNG/video exports.
//   Known limit: the shadow-map pass renders depth directly (no mesh
//   observables, no clip planes) — shadows show the uncut object.
//   A semi-transparent striped indicator quad (Fusion-360 style) is drawn at
//   the cut location so the user can see where/which-axis the cut is.

import { getState } from '../StateManager.js';
import { ACCENT_HEX } from './SceneConstants.js';

const BABYLON = window.BABYLON;

// Accent as rgb() parts for canvas fills (the stripe texture).
const _accent = BABYLON.Color3.FromHexString(ACCENT_HEX);
const ACCENT_RGB = `${Math.round(_accent.r * 255)}, ${Math.round(_accent.g * 255)}, ${Math.round(_accent.b * 255)}`;

let _scene  = null;
let _camera = null;

// ── SSAO ─────────────────────────────────────────────────

let _ssao = null;            // SSAO2RenderingPipeline while enabled
let _ssaoUnsupported = false;

// Contact-shadow radius in BU: ~9 mm reach suits the 300 mm working area
// (smaller reads as noise on hobbyist-print scale, larger reads as smoke).
const SSAO_RADIUS_BU = 0.009;

export function initViewEffects(scene, camera) {
  _scene  = scene;
  _camera = camera;
}

/**
 * Apply the view-effects half of state.scene.render. Partial-safe.
 * @param {{ ssaoEnabled?: boolean, ssaoStrength?: number }} [render]
 */
export function applyViewEffects(render = {}) {
  if (!_scene) return;
  if (typeof render.ssaoEnabled === 'boolean') {
    if (render.ssaoEnabled) _enableSsao();
    else _disposeSsao();
  }
  if (_ssao && Number.isFinite(render.ssaoStrength)) {
    _ssao.totalStrength = Math.max(0, Math.min(2, render.ssaoStrength));
  }
}

function _enableSsao() {
  if (_ssao || _ssaoUnsupported) return;
  const SSAO2 = BABYLON.SSAO2RenderingPipeline;
  // Feature-detected, never version-sniffed: SSAO2 needs WebGL2 (MRT depth
  // prepass). Unsupported → silently stays off; the toggle is still shown
  // so the setting round-trips.
  if (!SSAO2 || (SSAO2.IsSupported !== undefined && !SSAO2.IsSupported)) {
    _ssaoUnsupported = true;
    return;
  }
  try {
    // Half-res AO, full-res bilateral blur — the Fusion-ish contact
    // darkening without the grainy halo.
    _ssao = new SSAO2(`mxSSAO`, _scene, { ssaoRatio: 0.5, blurRatio: 1 }, [_camera]);
    _ssao.radius        = SSAO_RADIUS_BU;
    _ssao.totalStrength = Math.max(0, Math.min(2,
      getState().scene.render?.ssaoStrength ?? 1));
    _ssao.samples       = 12;
    _ssao.expensiveBlur = false;
  } catch (err) {
    // A driver/headless build without the needed extensions throws on
    // construction — treat exactly like unsupported.
    console.warn('SSAO unavailable on this GPU/driver:', err);
    _ssaoUnsupported = true;
    _disposeSsao();
  }
}

function _disposeSsao() {
  if (!_ssao) return;
  try { _ssao.dispose(); } catch { /* pipeline already torn down */ }
  _ssao = null;
}

/** @returns {boolean} SSAO pipeline currently active (smoke probe hook) */
export function isSsaoActive() { return !!_ssao; }

// ── Cross-section plane ──────────────────────────────────

let _plane = null;                  // BABYLON.Plane | null (null = off)
const _sectionIds = new Set();      // uniqueIds with clip observers attached

// Print-space → Babylon axis map (floor = printer bed XY, print Z is up).
const AXIS_NORMALS = {
  x: () => new BABYLON.Vector3(1, 0, 0),
  y: () => new BABYLON.Vector3(0, 0, 1),
  z: () => new BABYLON.Vector3(0, 1, 0),
};

/**
 * Enable/update/disable the section plane.
 * @param {{ enabled?: boolean, axis?: 'x'|'y'|'z', offsetMM?: number,
 *           flip?: boolean }} [section]
 */
export function setSectionPlane(section = {}) {
  if (!section.enabled) { _plane = null; _disposeSectionViz(); return; }
  const axis = section.axis in AXIS_NORMALS ? section.axis : 'z';
  const n = AXIS_NORMALS[axis]();
  const off = (Number.isFinite(section.offsetMM) ? section.offsetMM : 0) / 1000;  // mm → BU
  // Babylon discards fragments where dot(n, p) + d > 0. With the boundary at
  // coordinate `off` along the axis: unflipped (n = +u, d = −off) keeps the
  // side BELOW the offset; flipped (n = −u, d = +off) keeps the side above.
  if (section.flip) n.scaleInPlace(-1);
  _plane = new BABYLON.Plane(n.x, n.y, n.z, section.flip ? off : -off);
  registerSectionMeshes();
  _updateSectionViz(axis, off);
}

// ── Cross-section visual indicator (Fusion-360-style cut plane) ──
//
// A semi-transparent, diagonally-striped quad sat at the cut location so the
// user can SEE where the section happens (and on which axis) instead of
// staring at a floating cut edge. It carries NO metadata.meshId, so by the
// same ancestor-walk used everywhere it is auto-excluded from clipping
// (registerSectionMeshes), shadow casters (EnvironmentRig.ensureShadowCasters),
// and the selection mask. Sized to the live content bounds, re-placed on every
// axis/offset edit.

let _vizMesh = null;
let _vizTex  = null;

function _contentBounds() {
  if (!_scene) return null;
  let min = null, max = null;
  for (const m of _scene.meshes) {
    let node = m, isContent = false;
    while (node) { if (node.metadata?.meshId) { isContent = true; break; } node = node.parent; }
    if (!isContent || !m.geometry) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (!min) { min = bb.minimumWorld.clone(); max = bb.maximumWorld.clone(); }
    else { min = BABYLON.Vector3.Minimize(min, bb.minimumWorld); max = BABYLON.Vector3.Maximize(max, bb.maximumWorld); }
  }
  if (!min) return null;
  return { min, max, center: min.add(max).scale(0.5), size: max.subtract(min) };
}

function _buildStripeTexture() {
  const N = 256;
  const tex = new BABYLON.DynamicTexture('mx-section-stripes', N, _scene, false);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, N, N);
  ctx.fillStyle = `rgba(${ACCENT_RGB}, 0.16)`;     // translucent fill
  ctx.fillRect(0, 0, N, N);
  ctx.strokeStyle = `rgba(${ACCENT_RGB}, 0.6)`;     // brighter diagonal hatch
  ctx.lineWidth = 16;
  for (let i = -N; i < N * 2; i += 48) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + N, N); ctx.stroke();
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function _updateSectionViz(axis, off) {
  const b = _contentBounds();
  if (!b) { _disposeSectionViz(); return; }   // empty scene — nothing to indicate

  if (!_vizMesh) {
    _vizTex = _buildStripeTexture();
    const mat = new BABYLON.StandardMaterial('mx-section-plane-mat', _scene);
    mat.diffuseTexture = _vizTex;
    mat.emissiveTexture = _vizTex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;      // alpha overlay — don't occlude geometry behind it
    _vizMesh = BABYLON.MeshBuilder.CreatePlane('mx-section-plane',
      { size: 1, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, _scene);
    _vizMesh.material = mat;
    _vizMesh.isPickable = false;
    _vizMesh.metadata = { sectionPlaneViz: true };
    _vizMesh.renderingGroupId = 1;     // draw after opaque content
  }

  const { center, size } = b;
  const MARGIN = 1.12;
  if (axis === 'x') {
    _vizMesh.rotation.set(0, Math.PI / 2, 0);
    _vizMesh.scaling.set(size.z * MARGIN, size.y * MARGIN, 1);
    _vizMesh.position.set(off, center.y, center.z);
  } else if (axis === 'y') {                 // print Y = Babylon Z
    _vizMesh.rotation.set(0, 0, 0);
    _vizMesh.scaling.set(size.x * MARGIN, size.y * MARGIN, 1);
    _vizMesh.position.set(center.x, center.y, off);
  } else {                                   // 'z' — print height = Babylon Y
    _vizMesh.rotation.set(Math.PI / 2, 0, 0);
    _vizMesh.scaling.set(size.x * MARGIN, size.z * MARGIN, 1);
    _vizMesh.position.set(center.x, off, center.z);
  }
}

function _disposeSectionViz() {
  if (_vizMesh) { _vizMesh.dispose(); _vizMesh = null; }
  if (_vizTex)  { _vizTex.dispose();  _vizTex  = null; }
}

/** Is the cross-section indicator plane currently shown? */
export function isSectionVizVisible() {
  return !!_vizMesh && _vizMesh.isEnabled();
}

/**
 * Show/hide the cross-section indicator plane. The plane is a VIEWPORT aid, so
 * RenderOutput hides it during PNG/video capture (like grid/axes furniture) —
 * the geometric CUT still appears in exports, but the striped overlay does not.
 * No-op when the section is off (no mesh).
 * @param {boolean} on
 */
export function setSectionVizVisible(on) {
  if (_vizMesh) _vizMesh.setEnabled(!!on);
}

/**
 * Attach the per-mesh clip observers to every content mesh that doesn't
 * have them yet (idempotent — _sectionIds). Called on enable and on the
 * same import/load hooks as shadow casters. Observers are permanent and
 * read _plane each render: null = zero-cost no-op when the section is off.
 */
export function registerSectionMeshes() {
  if (!_scene) return;
  const isContent = (m) => {
    let node = m;
    while (node) {
      if (node.metadata?.meshId) return true;   // edge overlays are parented
      node = node.parent;                       // to content — sliced too
    }
    return false;
  };
  for (const mesh of _scene.meshes) {
    if (!mesh.geometry || _sectionIds.has(mesh.uniqueId) || !isContent(mesh)) continue;
    _sectionIds.add(mesh.uniqueId);
    mesh.onBeforeRenderObservable.add(() => { if (_plane) _scene.clipPlane = _plane; });
    mesh.onAfterRenderObservable.add(() => { if (_scene.clipPlane) _scene.clipPlane = null; });
    mesh.onDisposeObservable.addOnce(() => _sectionIds.delete(mesh.uniqueId));
  }
}
