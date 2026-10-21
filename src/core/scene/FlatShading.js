// Flat shading for welded imports (heavy-mesh review I1). STL used to arrive
// unwelded with the file's face normal on every corner, so it always rendered
// faceted — what the print will look like. Welded geometry keeps the memory win
// (~20 B/triangle instead of 84) but its vertex normals are smooth below the
// crease angle. This material plugin restores the faceted look per pixel: the
// fragment normal becomes the screen-space face normal
// normalize(cross(dFdx(p), dFdy(p))), oriented into the same hemisphere as the
// interpolated normal (which already carries winding / two-sided / mirrored
// flips). Positions, indices, picking and exports are untouched.
//
// Per mesh: `mesh.metadata.flatShading === true` (set by the STL import).
// Per user: the "Smooth shading" view toggle (`scene.overlays.smoothShading`,
// default off) turns it off everywhere. A per-mesh define, so meshes sharing a
// material can differ.

const BABYLON = window.BABYLON;
const SUPPORTED = new Set(['StandardMaterial', 'PBRMaterial']);
const NAME = 'MxFlatShading';

const GLSL = `
#ifdef MXFLAT
  vec3 mxFaceN = normalize(cross(dFdx(vPositionW), dFdy(vPositionW)));
  normalW = dot(mxFaceN, normalW) < 0.0 ? -mxFaceN : mxFaceN;
#endif
`;
const WGSL = `
#ifdef MXFLAT
  var mxFaceN: vec3f = normalize(cross(dpdx(fragmentInputs.vPositionW), dpdy(fragmentInputs.vPositionW)));
  normalW = select(mxFaceN, -mxFaceN, dot(mxFaceN, normalW) < 0.0);
#endif
`;

let _installed = false;
let _smooth = false;
let _scene = null;

/** True when the user asked for smooth shading (flat plugin off everywhere). */
export function isSmooth() { return _smooth; }

/** Mark a mesh as one that should render faceted (welded STL import). */
export function markFlat(mesh) {
  if (!mesh) return;
  mesh.metadata = { ...(mesh.metadata ?? {}), flatShading: true };
}

/** Should this mesh render faceted right now? (pure; unit-tested) */
export function wantsFlat(mesh, smooth = _smooth) {
  return !smooth && mesh?.metadata?.flatShading === true;
}

function _pluginClass() {
  const Base = BABYLON?.MaterialPluginBase;
  if (!Base) return null;
  return class MxFlatShadingPlugin extends Base {
    constructor(material) {
      super(material, NAME, 300, { MXFLAT: false }, true, true);
    }
    getClassName() { return 'MxFlatShadingPlugin'; }
    isCompatible() { return true; }
    prepareDefines(defines, _scene, mesh) {
      defines.MXFLAT = wantsFlat(mesh);
    }
    getCustomCode(shaderType, shaderLanguage) {
      if (shaderType !== 'fragment') return null;
      return { CUSTOM_FRAGMENT_BEFORE_LIGHTS: shaderLanguage === 1 /* WGSL */ ? WGSL : GLSL };
    }
  };
}

/**
 * Register the plugin for every Standard / PBR material created from now on.
 * Call before the scene (and its default material) exist. Idempotent.
 * @param {any} [scene]  remembered for setSmooth's re-evaluation
 */
export function install(scene = null) {
  if (scene) _scene = scene;
  if (_installed) return true;
  const Plugin = _pluginClass();
  if (!Plugin || typeof BABYLON.RegisterMaterialPlugin !== 'function') return false;
  BABYLON.RegisterMaterialPlugin(NAME, (material) => (SUPPORTED.has(material.getClassName?.()) ? new Plugin(material) : null));
  _installed = true;
  return true;
}

/** Remember the live scene (SceneManager.init after the scene exists). */
export function attachScene(scene) { _scene = scene; }

/**
 * "Smooth shading" view toggle. Re-evaluates the define on every material.
 * @param {boolean} on
 */
export function setSmooth(on) {
  _smooth = !!on;
  for (const mat of _scene?.materials ?? []) {
    try { mat.markAsDirty?.(BABYLON.Material?.MiscDirtyFlag ?? 16); } catch { /* disposed */ }
  }
}

export const FlatShading = { install, attachScene, markFlat, wantsFlat, setSmooth, isSmooth };
