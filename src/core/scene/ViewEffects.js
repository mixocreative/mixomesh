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

import { getState } from '../StateManager.js';

const BABYLON = window.BABYLON;

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
  if (!section.enabled) { _plane = null; return; }
  const axis = section.axis in AXIS_NORMALS ? section.axis : 'z';
  const n = AXIS_NORMALS[axis]();
  const off = (Number.isFinite(section.offsetMM) ? section.offsetMM : 0) / 1000;  // mm → BU
  // Babylon discards fragments where dot(n, p) + d > 0. With the boundary at
  // coordinate `off` along the axis: unflipped (n = +u, d = −off) keeps the
  // side BELOW the offset; flipped (n = −u, d = +off) keeps the side above.
  if (section.flip) n.scaleInPlace(-1);
  _plane = new BABYLON.Plane(n.x, n.y, n.z, section.flip ? off : -off);
  registerSectionMeshes();
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
