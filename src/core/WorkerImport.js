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

import { WorkerTask } from './workers/WorkerTask.js';

const BABYLON = window.BABYLON;

/** Per-job wall clock. A job that never posts back (stalled blob fetch,
 *  pathological file) would otherwise pin `_pending` forever and queue every
 *  later import behind it (audit F17). */
export const WORKER_JOB_TIMEOUT_MS = 120_000;

// One persistent worker, jobs strictly one at a time (the worker swaps the
// engine-global Tools.PreprocessUrl). A timeout or crash fails the running job
// and terminates the worker; imports still queued behind it then run on a
// fresh worker (WorkerTask serial queue).
const _task = new WorkerTask({
  name: 'OBJ worker',
  label: 'job.importObj',
  concurrency: 'serial',
  timeoutMs: WORKER_JOB_TIMEOUT_MS,
  create: () => new Worker(new URL('./workers/ObjParse.worker.js', import.meta.url), { type: 'module' }),
});

export function isWorkerImportSupported() {
  return typeof Worker === 'function';
}

async function _parseInWorker(blobUrl, ext, siblings, onProgress, timeoutMs, signal) {
  try {
    return await _task.run(
      { blobUrl, ext, siblings: [...(siblings ?? new Map()).entries()] },
      { timeoutMs, onProgress, signal, cancellable: true },
    );
  } catch (err) {
    const secs = Math.round(timeoutMs / 1000);
    // Keep the code: AssetImport never retries a timed-out (big) file on the main thread.
    const coded = (message) => Object.assign(new Error(message), { code: err.code });
    if (err?.code === 'timeout') throw coded(`OBJ import timed out after ${secs} s`);
    if (err?.code === 'restarted') throw coded(`OBJ worker restarted after another job failed (${err.message})`);
    throw err;
  }
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

  _assertParsedShape(parsed);
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
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]  per-job timeout (default WORKER_JOB_TIMEOUT_MS), Cancel
 * @returns {Promise<BABYLON.AssetContainer>}
 */
export async function loadObjContainerViaWorker(scene, blobUrl, siblings, onProgress, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? WORKER_JOB_TIMEOUT_MS;
  const parsed = await _parseInWorker(blobUrl, '.obj', siblings, onProgress, timeoutMs, opts.signal);
  if (!parsed.meshes?.length) throw new Error('worker returned no geometry');
  _assertParsedShape(parsed);
  return _buildContainer(scene, parsed, siblings);
}

export const WorkerImport = { isWorkerImportSupported, loadObjContainerViaWorker, WORKER_JOB_TIMEOUT_MS };

// F14: the worker's `done` payload crosses a boundary; a malformed entry used
// to build an empty/NaN mesh silently. Reject → caller falls back to the
// main-thread parser.
function _assertParsedShape(parsed) {
  const bad = (why) => { throw new Error(`OBJ worker returned malformed geometry — ${why}; falling back to main-thread parse`); };
  if (!Array.isArray(parsed?.meshes)) bad('meshes is not an array');
  for (const m of parsed.meshes) {
    const pos = m?.kinds?.position;
    if (!pos || typeof pos.length !== 'number' || pos.length === 0 || pos.length % 3 !== 0) bad(`"${m?.name ?? '?'}" has no valid positions`);
    const vcount = pos.length / 3;
    const idx = m.indices;
    if (idx != null) {
      if (typeof idx.length !== 'number' || idx.length % 3 !== 0) bad(`"${m.name}" has a malformed index list`);
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i];
        if (!Number.isInteger(v) || v < 0 || v >= vcount) bad(`"${m.name}" index ${i} out of range`);
      }
    }
    for (const key of ['position', 'rotation', 'scaling']) {
      const arr = m[key];
      if (arr != null && !(Array.isArray(arr) && arr.length === 3 && arr.every(Number.isFinite))) bad(`"${m.name}" ${key} is not a finite xyz triple`);
    }
  }
}
