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
  _setAllStencil(true);    // cap mesh now exists — turn on the interior mask
}

/**
 * Content extent along a section axis, in print-space mm — the slider range
 * (lowest..highest point). Reuses the cap's `_contentBounds` (no extra cost).
 * Axis maps to Babylon: x→X, y→Z, z→Y (print Z = up = Babylon Y).
 * @param {'x'|'y'|'z'} axis
 * @returns {{ minMM: number, maxMM: number, hasContent: boolean }}
 */
export function getSectionExtentMM(axis) {
  const b = _contentBounds();
  if (!b) return { minMM: -150, maxMM: 150, hasContent: false };
  const a = axis in AXIS_NORMALS ? axis : 'z';
  const lo = a === 'x' ? b.min.x : a === 'y' ? b.min.z : b.min.y;
  const hi = a === 'x' ? b.max.x : a === 'y' ? b.max.z : b.max.y;
  return { minMM: lo * 1000, maxMM: hi * 1000, hasContent: true };
}

// ── Cross-section cap + cut-plane border (Fusion-360-style) ──
//
// Two viewport aids, both shown only while the cut is on:
//
//  • CAP — the actual solid interior cross-section, striped + semi-transparent.
//    Done with the STENCIL buffer, NOT an extra geometry pass (heavy-asset
//    perf): while the section is on, every clipped content material renders
//    with `stencil` INVERT, so at each pixel the stencil parity flips once per
//    solid surface the camera ray crosses → set inside the solid, clear outside
//    (even-odd rule; exact for watertight meshes — print models). A cap quad at
//    the plane then draws ONLY where stencil != 0, so the stripes fill just the
//    solid's cut face, never the empty bounds around it.
//  • BORDER — a thin accent rectangle OUTLINE at the plane extent so the user
//    sees the plane position and that cut-view is active, even where the cut
//    misses the solid.
//
// Neither carries metadata.meshId → both auto-excluded from clipping, shadow
// casters, and the selection mask. RenderOutput hides them during PNG/video
// capture (the geometric cut still renders; the stripes/border do not).

let _capMesh    = null;
let _capTex     = null;
let _borderMesh = null;
const _sectionMeshes = new Set();   // content mesh refs (for stencil toggling)

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
  // OPAQUE fill + dark diagonal hatch — the cut face reads as a SOLID machined
  // cross-section (Fusion-style) and, with depth-write on, OCCLUDES the hollow
  // interior / back faces behind the plane. Semi-transparency is deliberately
  // NOT used: a see-through face would reveal the hollow it's meant to hide.
  ctx.fillStyle = `rgb(${ACCENT_RGB})`;
  ctx.fillRect(0, 0, N, N);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.lineWidth = 16;
  for (let i = -N; i < N * 2; i += 48) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + N, N); ctx.stroke();
  }
  tex.update();
  return tex;   // opaque (no hasAlpha) — occludes what's behind the cut
}

// Configure a clipped content material to INVERT the stencil where it draws,
// so the cap quad can mask itself to the solid interior. Reversible.
function _setMeshStencil(mesh, on) {
  const mat = mesh.material;
  if (!mat || !mat.stencil) return;
  if (on) {
    mat.stencil.enabled  = true;
    mat.stencil.mask     = 0xFF;
    mat.stencil.func     = BABYLON.Constants.ALWAYS;
    mat.stencil.funcRef  = 1;
    mat.stencil.funcMask = 0xFF;
    mat.stencil.opStencilFail       = BABYLON.Constants.KEEP;
    mat.stencil.opDepthFail         = BABYLON.Constants.KEEP;
    mat.stencil.opStencilDepthPass  = BABYLON.Constants.INVERT;
  } else {
    mat.stencil.enabled = false;
  }
}

function _setAllStencil(on) {
  for (const m of _sectionMeshes) { if (!m.isDisposed?.()) _setMeshStencil(m, on); }
}

function _updateSectionViz(axis, off) {
  const b = _contentBounds();
  if (!b) { _disposeSectionViz(); return; }   // empty scene — nothing to show

  // Cap quad — stencil-masked to the solid interior.
  if (!_capMesh) {
    _capTex = _buildStripeTexture();
    const mat = new BABYLON.StandardMaterial('mx-section-cap-mat', _scene);
    mat.diffuseTexture  = _capTex;
    mat.emissiveTexture = _capTex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    // OPAQUE + depth-write ON (defaults): the cap sits at the cut plane — the
    // frontmost surface after clipping — so it occludes the back faces / hollow
    // interior behind it, making the cut read solid. Drawn ONLY where the
    // clipped solids set the stencil (the actual interior cross-section).
    mat.stencil.enabled  = true;
    mat.stencil.func     = BABYLON.Constants.NOTEQUAL;
    mat.stencil.funcRef  = 0;
    mat.stencil.funcMask = 0xFF;
    _capMesh = BABYLON.MeshBuilder.CreatePlane('mx-section-plane',
      { size: 1, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, _scene);
    _capMesh.material = mat;
    _capMesh.isPickable = false;
    _capMesh.metadata = { sectionPlaneViz: true };
    _capMesh.renderingGroupId = 1;     // after opaque content (which writes stencil)
  }
  // Border outline — rebuilt each update (LinesMesh extent changes with axis).
  if (_borderMesh) { _borderMesh.dispose(); _borderMesh = null; }

  const { center, size } = b;
  const MARGIN = 1.12;
  const hw = (a) => a * MARGIN / 2;    // half-width helper
  let corners;
  if (axis === 'x') {
    _capMesh.rotation.set(0, Math.PI / 2, 0);
    _capMesh.scaling.set(size.z * MARGIN, size.y * MARGIN, 1);
    _capMesh.position.set(off, center.y, center.z);
    const dz = hw(size.z), dy = hw(size.y);
    corners = [
      new BABYLON.Vector3(off, center.y - dy, center.z - dz),
      new BABYLON.Vector3(off, center.y - dy, center.z + dz),
      new BABYLON.Vector3(off, center.y + dy, center.z + dz),
      new BABYLON.Vector3(off, center.y + dy, center.z - dz),
    ];
  } else if (axis === 'y') {                 // print Y = Babylon Z
    _capMesh.rotation.set(0, 0, 0);
    _capMesh.scaling.set(size.x * MARGIN, size.y * MARGIN, 1);
    _capMesh.position.set(center.x, center.y, off);
    const dx = hw(size.x), dy = hw(size.y);
    corners = [
      new BABYLON.Vector3(center.x - dx, center.y - dy, off),
      new BABYLON.Vector3(center.x + dx, center.y - dy, off),
      new BABYLON.Vector3(center.x + dx, center.y + dy, off),
      new BABYLON.Vector3(center.x - dx, center.y + dy, off),
    ];
  } else {                                   // 'z' — print height = Babylon Y
    _capMesh.rotation.set(Math.PI / 2, 0, 0);
    _capMesh.scaling.set(size.x * MARGIN, size.z * MARGIN, 1);
    _capMesh.position.set(center.x, off, center.z);
    const dx = hw(size.x), dz = hw(size.z);
    corners = [
      new BABYLON.Vector3(center.x - dx, off, center.z - dz),
      new BABYLON.Vector3(center.x + dx, off, center.z - dz),
      new BABYLON.Vector3(center.x + dx, off, center.z + dz),
      new BABYLON.Vector3(center.x - dx, off, center.z + dz),
    ];
  }
  corners.push(corners[0]);   // close the loop
  _borderMesh = BABYLON.MeshBuilder.CreateLines('mx-section-border', { points: corners }, _scene);
  _borderMesh.color = BABYLON.Color3.FromHexString(ACCENT_HEX);
  _borderMesh.isPickable = false;
  _borderMesh.metadata = { sectionPlaneViz: true };
  _borderMesh.renderingGroupId = 1;
}

function _disposeSectionViz() {
  _setAllStencil(false);
  if (_capMesh)    { _capMesh.material?.dispose(); _capMesh.dispose(); _capMesh = null; }
  if (_capTex)     { _capTex.dispose();  _capTex  = null; }
  if (_borderMesh) { _borderMesh.dispose(); _borderMesh = null; }
}

/** Is the cross-section cap/border currently shown? */
export function isSectionVizVisible() {
  return !!_capMesh && _capMesh.isEnabled();
}

/**
 * Show/hide the cross-section cap + border. They are VIEWPORT aids, so
 * RenderOutput hides them during PNG/video capture (like grid/axes furniture) —
 * the geometric CUT still appears in exports, but the stripes/border do not.
 * Hiding also drops the content stencil writes so capture is unaffected.
 * No-op when the section is off (no meshes).
 * @param {boolean} on
 */
export function setSectionVizVisible(on) {
  if (_capMesh)    _capMesh.setEnabled(!!on);
  if (_borderMesh) _borderMesh.setEnabled(!!on);
  if (_capMesh) _setAllStencil(!!on);
}

/**
 * Attach the per-mesh clip observers to every content mesh that doesn't
 * have them yet (idempotent — _sectionIds). Called on enable and on the
 * same import/load hooks as shadow casters. Observers are permanent and
 * read _plane each render: null = zero-cost no-op when the section is off.
 * Also enables the cap stencil on newly-registered meshes while a cut is live.
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
    if (!mesh.geometry || !isContent(mesh)) continue;
    if (!_sectionIds.has(mesh.uniqueId)) {
      _sectionIds.add(mesh.uniqueId);
      _sectionMeshes.add(mesh);
      mesh.onBeforeRenderObservable.add(() => { if (_plane) _scene.clipPlane = _plane; });
      mesh.onAfterRenderObservable.add(() => { if (_scene.clipPlane) _scene.clipPlane = null; });
      mesh.onDisposeObservable.addOnce(() => { _sectionIds.delete(mesh.uniqueId); _sectionMeshes.delete(mesh); });
    }
    if (_plane && _capMesh) _setMeshStencil(mesh, true);   // late import during a live cut
  }
}
