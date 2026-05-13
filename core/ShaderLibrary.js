import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const FALLBACK_DIFFUSE = '#cccccc';

// Module-local: Babylon material objects keyed by shaderId.
// Not persisted in state — state holds only the JSON-serializable ShaderEntry.
const _materials = new Map();

let _idCounter = 0;
function _nextShaderId() { return `sh_${Date.now().toString(36)}_${++_idCounter}`; }

function _color3ToHex(c3) {
  if (!c3) return FALLBACK_DIFFUSE;
  const r = Math.round(Math.max(0, Math.min(1, c3.r)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c3.g)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c3.b)) * 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function _detectType(material) {
  if (material instanceof BABYLON.PBRMaterial)          return 'pbr';
  if (material instanceof BABYLON.PBRMetallicRoughnessMaterial) return 'pbr';
  if (material instanceof BABYLON.PBRSpecularGlossinessMaterial) return 'pbr';
  if (material.disableLighting === true)                return 'unlit';
  return 'standard';
}

function _buildEntry(material) {
  const type = _detectType(material);
  let diffuseColor = FALLBACK_DIFFUSE;
  let opacity = 1, roughness = 0.5, metallic = 0;

  if (type === 'pbr') {
    diffuseColor = _color3ToHex(material.albedoColor ?? material.baseColor);
    opacity      = material.alpha ?? 1;
    roughness    = material.roughness ?? 0.5;
    metallic     = material.metallic ?? 0;
  } else {
    diffuseColor = _color3ToHex(material.diffuseColor);
    opacity      = material.alpha ?? 1;
  }

  return {
    id: _nextShaderId(),
    name: material.name || 'Material',
    type,
    diffuseColor,
    diffuseTextureAssetId: null,
    uvBase: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity, roughness, metallic,
    linkedMeshIds: [],
  };
}

/**
 * Register every unique material in an AssetContainer as a ShaderEntry.
 * Returns parallel arrays so callers can map mesh → shaderId after instantiation.
 *
 * Phase 2 stub: no merge-strategy modal yet (BLUEPRINT §10). Duplicate names
 * are kept as-is; Phase 4 introduces conflict resolution.
 *
 * @param {BABYLON.AssetContainer} container
 * @returns {{ shaderIds: string[], byMaterial: Map<BABYLON.Material, string> }}
 */
export function registerFromContainer(container) {
  const byMaterial = new Map();
  const shaderIds = [];

  for (const mat of container.materials) {
    if (byMaterial.has(mat)) continue;
    const entry = _buildEntry(mat);
    _materials.set(entry.id, mat);
    byMaterial.set(mat, entry.id);
    shaderIds.push(entry.id);

    setState(state => ({
      ...state,
      scene: {
        ...state.scene,
        shaders: { ...state.scene.shaders, [entry.id]: entry },
      },
    }), { silent: true });

    dispatch(EVENTS.SHADER_CREATED, { shaderId: entry.id });
  }

  return { shaderIds, byMaterial };
}

/**
 * Add a meshId to a shader's linkedMeshIds list (runtime index).
 * @param {string} shaderId
 * @param {string} meshId
 */
export function linkMesh(shaderId, meshId) {
  const shaders = getState().scene.shaders;
  const entry = shaders[shaderId];
  if (!entry) return;
  if (entry.linkedMeshIds.includes(meshId)) return;
  setState(state => {
    const sh = state.scene.shaders[shaderId];
    if (!sh) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        shaders: {
          ...state.scene.shaders,
          [shaderId]: { ...sh, linkedMeshIds: [...sh.linkedMeshIds, meshId] },
        },
      },
    };
  }, { silent: true });
}

/**
 * Remove a meshId from a shader's linkedMeshIds list.
 * @param {string} shaderId
 * @param {string} meshId
 */
export function unlinkMesh(shaderId, meshId) {
  setState(state => {
    const sh = state.scene.shaders[shaderId];
    if (!sh) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        shaders: {
          ...state.scene.shaders,
          [shaderId]: { ...sh, linkedMeshIds: sh.linkedMeshIds.filter(id => id !== meshId) },
        },
      },
    };
  }, { silent: true });
}

/**
 * Look up the live Babylon material assigned to a mesh.
 * @param {string} meshId
 * @returns {BABYLON.Material|null}
 */
export function getBabylonMaterial(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj?.shaderId) return null;
  return _materials.get(obj.shaderId) ?? null;
}

/** @param {string} shaderId */
export function getMaterialById(shaderId) {
  return _materials.get(shaderId) ?? null;
}

export const ShaderLibrary = {
  registerFromContainer, linkMesh, unlinkMesh,
  getBabylonMaterial, getMaterialById,
};
