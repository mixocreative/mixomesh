// GeometryStore — per-mesh geometry revisions plus the ONE way to copy a
// mesh's geometry out of Babylon for worker jobs and exports.
//
// Babylon still owns the vertex data. What this adds:
//  - revisionOf/bump: a real geometry version per meshId. Every in-place
//    mutation (transform bakes, repair, weld, mirror) bumps it and
//    GEOMETRY_CHANGED fires, so a worker result computed from an older
//    revision can be recognised as stale.
//  - extract: fresh, owned typed arrays (safe to transfer to a worker without
//    detaching Babylon's mirror), optionally baked to world space, made once.
// Nothing is cached: a cache would add a copy, not remove one.

import { dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';

// Babylon VertexBuffer kind names (VertexBuffer.PositionKind / UVKind).
const POSITION = 'position';
const UV = 'uv';

const _revisions = new Map();   // meshId → revision

/** The registry id stamped on a mesh (`mesh.metadata.meshId`), or null. */
export function meshIdOf(mesh) {
  return mesh?.metadata?.meshId ?? null;
}

function _id(meshOrId) {
  return typeof meshOrId === 'string' ? meshOrId : meshIdOf(meshOrId);
}

/** Current geometry revision (0 = never changed / unknown). */
export function revisionOf(meshOrId) {
  const id = _id(meshOrId);
  return id ? (_revisions.get(id) ?? 0) : 0;
}

/** Record an in-place geometry change. Returns the new revision (0 when the mesh has no id). */
export function bump(meshOrId) {
  // Export clones share the original's metadata (meshId) but own their
  // geometry; their prep mutations must not mark the live mesh changed.
  if (meshOrId?.__geometryDetached) return 0;
  const id = _id(meshOrId);
  if (!id) return 0;
  const revision = (_revisions.get(id) ?? 0) + 1;
  _revisions.set(id, revision);
  dispatch(EVENTS.GEOMETRY_CHANGED, { meshId: id, revision });
  return revision;
}

/** Forget a mesh's revision (mesh disposed). */
export function forget(meshOrId) {
  const id = _id(meshOrId);
  if (id) _revisions.delete(id);
}

/** Apply a Babylon world matrix (row-vector layout, translation in m[12..14]) in place. */
function _toWorld(positions, m) {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const w = x * m[3] + y * m[7] + z * m[11] + m[15] || 1;
    positions[i]     = (x * m[0] + y * m[4] + z * m[8]  + m[12]) / w;
    positions[i + 1] = (x * m[1] + y * m[5] + z * m[9]  + m[13]) / w;
    positions[i + 2] = (x * m[2] + y * m[6] + z * m[10] + m[14]) / w;
  }
}

/**
 * Copy a mesh's geometry into fresh, transferable typed arrays.
 * @param {any} mesh  Babylon mesh (or duck-typed: getVerticesData/getIndices/computeWorldMatrix)
 * @param {{ space?: 'local'|'world', uvs?: boolean }} [opts]
 * @returns {{ positions: Float32Array, indices: Uint32Array, uvs?: Float32Array, revision: number }}
 */
export function extract(mesh, { space = 'local', uvs = false } = {}) {
  const src = mesh?.getVerticesData?.(POSITION);
  const positions = src ? Float32Array.from(src) : new Float32Array(0);
  const rawIndices = mesh?.getIndices?.();
  const indices = rawIndices
    ? Uint32Array.from(rawIndices)
    : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  if (space === 'world' && positions.length) {
    const m = mesh.computeWorldMatrix(true)?.m;
    if (m) _toWorld(positions, m);
  }
  const out = { positions, indices, revision: revisionOf(mesh) };
  if (uvs) {
    const srcUv = mesh?.getVerticesData?.(UV);
    out.uvs = srcUv ? Float32Array.from(srcUv) : new Float32Array(0);
  }
  return out;
}

export const GeometryStore = { meshIdOf, revisionOf, bump, forget, extract };
