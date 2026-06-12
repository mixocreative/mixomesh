// OBJ parse worker. Babylon's OBJ/MTL loader is a synchronous text parser —
// big files freeze the UI for seconds when parsed on the main thread (field
// report 2026-06-12). This worker runs the SAME Babylon loader against a
// NullEngine scene (no parser drift possible), then ships geometry back as
// transferable buffers plus plain material descriptors. The main thread
// (WorkerImport.js) rebuilds real meshes/materials from them.
//
// NullEngine never fetches texture bytes, so material textures come back as
// bare filenames; the main thread re-resolves them against the OBJ sibling
// map (the same map used for MTL resolution here, passed in as entries).

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { Tools } from '@babylonjs/core/Misc/tools.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import '@babylonjs/loaders/OBJ/index.js';

const engine = new NullEngine();

const KINDS = [
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.UVKind,
  VertexBuffer.ColorKind,
];

const TEXTURE_SLOTS = ['diffuse', 'bump', 'opacity', 'ambient', 'specular', 'emissive'];

const _basename = (url) => String(url ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';

function _textureName(tex) {
  if (!tex) return null;
  const name = _basename(tex.url ?? tex.name);
  return name || null;
}

function _color(c) {
  return c ? [c.r, c.g, c.b] : null;
}

// Typed array safe to transfer: must own its whole buffer (vertex data can be
// a view over an interleaved buffer; transferring that would corrupt siblings).
function _ownedF32(data) {
  return (data instanceof Float32Array && data.byteOffset === 0 &&
          data.buffer.byteLength === data.byteLength) ? data : new Float32Array(data);
}

async function _parse({ id, blobUrl, ext, siblings }) {
  const scene = new Scene(engine);
  const sibMap = new Map(siblings ?? []);
  // Same sibling redirect the main thread installs for its fallback path —
  // mtllib/texture references in the OBJ resolve to main-created object URLs
  // (fetchable from a dedicated worker, same origin).
  const prevPre = Tools.PreprocessUrl;
  Tools.PreprocessUrl = (url) => {
    const hit = sibMap.get(_basename(url));
    if (hit) return hit;
    return typeof prevPre === 'function' ? prevPre(url) : url;
  };

  try {
    const container = await SceneLoader.LoadAssetContainerAsync(
      blobUrl, '', scene,
      (evt) => self.postMessage({
        id, type: 'progress',
        lengthComputable: !!evt?.lengthComputable,
        loaded: evt?.loaded ?? 0,
        total: evt?.total ?? 0,
      }),
      ext
    );

    const materials = [];
    const matIndex = new Map();
    for (const mat of container.materials) {
      // Babylon's OBJ loader emits single StandardMaterials; anything else
      // means an upstream change — bail so the caller falls back to the
      // main-thread loader rather than rebuilding wrongly.
      if (Array.isArray(mat.subMaterials)) throw new Error('unexpected MultiMaterial in OBJ container');
      matIndex.set(mat, materials.length);
      const textures = {};
      for (const slot of TEXTURE_SLOTS) {
        textures[slot] = _textureName(mat[`${slot}Texture`]);
      }
      materials.push({
        name: mat.name ?? 'Material',
        diffuseColor: _color(mat.diffuseColor),
        ambientColor: _color(mat.ambientColor),
        emissiveColor: _color(mat.emissiveColor),
        specularColor: _color(mat.specularColor),
        specularPower: mat.specularPower ?? 64,
        alpha: mat.alpha ?? 1,
        backFaceCulling: mat.backFaceCulling !== false,
        textures,
      });
    }

    const meshes = [];
    const transfers = [];
    for (const mesh of container.meshes) {
      if (!mesh.geometry || (mesh.getTotalVertices?.() ?? 0) === 0) continue;
      const kinds = {};
      for (const kind of KINDS) {
        if (!mesh.isVerticesDataPresent(kind)) continue;
        const data = mesh.getVerticesData(kind);
        if (!data) continue;
        const f32 = _ownedF32(data);
        kinds[kind] = f32;
        transfers.push(f32.buffer);
      }
      const rawIdx = mesh.getIndices();
      let indices = null;
      if (rawIdx && rawIdx.length) {
        indices = (rawIdx instanceof Uint32Array && rawIdx.byteOffset === 0 &&
                   rawIdx.buffer.byteLength === rawIdx.byteLength) ? rawIdx : Uint32Array.from(rawIdx);
        transfers.push(indices.buffer);
      }
      const rq = mesh.rotationQuaternion;
      meshes.push({
        name: mesh.name,
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        rotationQuaternion: rq ? [rq.x, rq.y, rq.z, rq.w] : null,
        scaling: [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z],
        sideOrientation: mesh.sideOrientation ?? mesh.overrideMaterialSideOrientation ?? null,
        materialIndex: mesh.material ? (matIndex.get(mesh.material) ?? -1) : -1,
        kinds,
        indices,
      });
    }

    self.postMessage({ id, type: 'done', meshes, materials }, transfers);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  } finally {
    Tools.PreprocessUrl = prevPre;
    scene.dispose();
  }
}

// Requests run strictly one at a time (the PreprocessUrl swap above is
// engine-global); WorkerImport.js also serializes on its side — this chain is
// the in-worker belt to that suspender.
let _queue = Promise.resolve();
self.onmessage = (e) => {
  const job = () => _parse(e.data);
  _queue = _queue.then(job, job);
};
