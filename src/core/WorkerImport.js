// Main-thread side of worker-based OBJ import (field report 2026-06-12:
// big imports freeze the UI). workers/ObjParse.worker.js runs Babylon's own
// OBJ/MTL loader in a NullEngine scene and posts back transferable geometry
// plus plain material descriptors; this module rebuilds real meshes,
// StandardMaterials, and textures in the live scene.
//
// Strictly an enhancement: any failure (worker bundle missing, unexpected
// container shape, no Worker support) rejects, and AssetLoader falls back to
// the main-thread SceneLoader path. Headless tests have no Worker, so they
// always exercise the fallback — the worker path is covered by browser smoke.

const BABYLON = window.BABYLON;

let _worker = null;
let _seq = 0;
const _pending = new Map();      // id → { resolve, reject, onProgress }
let _chain = Promise.resolve();  // serialize: worker swaps engine-global PreprocessUrl

export function isWorkerImportSupported() {
  return typeof Worker === 'function';
}

function _ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./workers/ObjParse.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const msg = e.data;
    const p = _pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') { p.onProgress?.(msg); return; }
    _pending.delete(msg.id);
    if (msg.type === 'done') p.resolve(msg);
    else p.reject(new Error(msg.message ?? 'worker parse failed'));
  };
  _worker.onerror = (err) => {
    // Wholesale failure (worker bundle failed to load/execute). Reject all
    // in-flight requests and drop the worker — callers fall back, and the
    // next import retries a fresh spawn.
    const reason = new Error(err?.message ?? 'import worker error');
    for (const p of _pending.values()) p.reject(reason);
    _pending.clear();
    try { _worker.terminate(); } catch { /* already dead */ }
    _worker = null;
  };
  return _worker;
}

function _parseInWorker(blobUrl, ext, siblings, onProgress) {
  const run = () => new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject, onProgress });
    _ensureWorker().postMessage({
      id, blobUrl, ext,
      siblings: [...(siblings ?? new Map()).entries()],
    });
  });
  const result = _chain.then(run, run);
  _chain = result.catch(() => {});
  return result;
}

const TEXTURE_SLOTS = {
  diffuse: 'diffuseTexture',
  bump: 'bumpTexture',
  opacity: 'opacityTexture',
  ambient: 'ambientTexture',
  specular: 'specularTexture',
  emissive: 'emissiveTexture',
};

/**
 * Rebuild an AssetContainer from the worker's parsed payload. Meshes,
 * materials, and textures are created in the live scene, collected into the
 * container, then removed again — so the caller's normal
 * `container.addAllToScene()` flow works unchanged.
 */
function _buildContainer(scene, parsed, siblings) {
  const container = new BABYLON.AssetContainer(scene);
  const textures = [];

  const materials = parsed.materials.map(spec => {
    const mat = new BABYLON.StandardMaterial(spec.name, scene);
    if (spec.diffuseColor)  mat.diffuseColor  = BABYLON.Color3.FromArray(spec.diffuseColor);
    if (spec.ambientColor)  mat.ambientColor  = BABYLON.Color3.FromArray(spec.ambientColor);
    if (spec.emissiveColor) mat.emissiveColor = BABYLON.Color3.FromArray(spec.emissiveColor);
    if (spec.specularColor) mat.specularColor = BABYLON.Color3.FromArray(spec.specularColor);
    mat.specularPower = spec.specularPower ?? 64;
    mat.alpha = spec.alpha ?? 1;
    mat.backFaceCulling = spec.backFaceCulling !== false;
    for (const [slot, prop] of Object.entries(TEXTURE_SLOTS)) {
      const filename = spec.textures?.[slot];
      const url = filename ? siblings?.get(filename) : null;
      if (!url) continue;   // no sibling bytes — slot stays empty, like the fallback path
      const tex = new BABYLON.Texture(url, scene);
      mat[prop] = tex;
      textures.push(tex);
    }
    return mat;
  });

  for (const m of parsed.meshes) {
    const mesh = new BABYLON.Mesh(m.name, scene);
    const vd = new BABYLON.VertexData();
    vd.positions = m.kinds[BABYLON.VertexBuffer.PositionKind] ?? null;
    vd.normals   = m.kinds[BABYLON.VertexBuffer.NormalKind] ?? null;
    vd.uvs       = m.kinds[BABYLON.VertexBuffer.UVKind] ?? null;
    vd.colors    = m.kinds[BABYLON.VertexBuffer.ColorKind] ?? null;
    vd.indices   = m.indices ?? null;
    vd.applyToMesh(mesh);

    mesh.position = new BABYLON.Vector3(...m.position);
    mesh.rotation = new BABYLON.Vector3(...m.rotation);
    if (m.rotationQuaternion) {
      mesh.rotationQuaternion = new BABYLON.Quaternion(...m.rotationQuaternion);
    }
    mesh.scaling = new BABYLON.Vector3(...m.scaling);
    if (m.sideOrientation != null) {
      if ('sideOrientation' in mesh) mesh.sideOrientation = m.sideOrientation;
      else mesh.overrideMaterialSideOrientation = m.sideOrientation;
    }
    if (m.materialIndex >= 0) mesh.material = materials[m.materialIndex] ?? null;
    container.meshes.push(mesh);
  }

  container.materials.push(...materials);
  container.textures.push(...textures);
  // Constructors registered everything with the scene; undo that so the
  // standard import flow's addAllToScene() doesn't double-register.
  container.removeAllFromScene();
  return container;
}

/**
 * Parse an OBJ off the main thread and return a rebuilt AssetContainer
 * (NOT yet added to the scene — caller does addAllToScene, same as the
 * SceneLoader path). Rejects on any worker/shape problem; caller falls back.
 *
 * @param {BABYLON.Scene} scene
 * @param {string} blobUrl
 * @param {Map<string,string>|null} siblings  lowercase filename → object URL
 * @param {(evt:{lengthComputable:boolean,loaded:number,total:number})=>void} [onProgress]
 * @returns {Promise<BABYLON.AssetContainer>}
 */
export async function loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress) {
  const parsed = await _parseInWorker(blobUrl, '.obj', siblings, onProgress);
  if (!parsed.meshes?.length) throw new Error('worker returned no geometry');
  return _buildContainer(scene, parsed, siblings);
}

export const WorkerImport = { isWorkerImportSupported, loadObjContainerViaWorker };
