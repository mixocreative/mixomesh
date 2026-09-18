/**
 * GroupRepair — watertight repair of a MULTI-PART logical object as ONE
 * solid (2026-09-18).
 *
 * A glTF multi-primitive / MultiMaterial-split import is one surface cut
 * into parts along material seams. Every part is OPEN along those seams by
 * construction, so repairing parts one at a time (the previous
 * `RepairSession._repairOnePart(groupPart)` path, and the export pipeline's
 * per-clone `repair` step) capped every seam: a perfectly closed cube split
 * into two materials came back as two closed half-cubes with an internal
 * wall (12 + 4 triangles instead of 12), and a photogrammetry scan split by
 * texture atlas grew a wall along every atlas boundary. That is worse than
 * no repair at all — and it is what the user saw as "still not watertight
 * after the fix".
 *
 * This module repairs the WELDED UNION of the parts (seams become interior
 * edges, real holes stay holes), then hands every output triangle back to
 * the part it came from:
 *   • an output triangle whose three corners are three original union
 *     vertices in an original triangle's corner set (any rotation / either
 *     winding) goes to that triangle's part — the engine keeps untouched
 *     vertices bit-exact (same assumption `MeshRepair.arraysToMesh` rests on);
 *   • a hole-fill triangle goes to the part owning the majority of its
 *     corners (nearest original vertex for brand-new ones).
 * Each part is then rewritten through `MeshRepair.arraysToMesh`, which
 * re-attaches that part's own UVs corner-by-corner; the winding is decided
 * once for the whole union under the parts' shared side flag. Materials are never mixed: a part only ever
 * receives triangles, never another part's texture.
 *
 * Spaces: parts are unioned in the LEAD part's local space through
 * `toLead` (part-local → lead-local). For a glTF multi-primitive every part
 * shares the lead's world matrix, so `toLead` is identity and nothing is
 * transformed at all (no float drift for the exact-key UV lookup). Export
 * clones are already flattened to one space — pass no matrix.
 */

import {
  repairArraysByComponent, arraysToMesh, posKey, nearestIndex,
  ensureRepairEngine, REPAIR_TRIANGLE_CAP,
} from './MeshRepair.js';
import { WELD_DISTANCE } from './Weld.js';
import { signedVolume, frontFaceIsClockwise } from '../print/PrintSpace.js';

const BABYLON = window.BABYLON;

/**
 * @typedef {object} GroupPart
 * @property {object} mesh   Babylon mesh (or duck-typed get/setVerticesData, get/setIndices)
 * @property {object|null} [toLead]  BABYLON.Matrix mapping part-local → lead-local; null/undefined = identity
 */

// Float32 world matrices: the product of two IDENTICAL rotated/scaled
// matrices with an inverse comes back ~1e-7 off identity, so a 1e-9 test
// would transform the exact glTF multi-primitive case the header promises
// to leave alone (review finding 2026-09-18).
const IDENTITY_EPS = 1e-6;

function _isIdentity(m) {
  if (!m) return true;
  const a = m.m ?? m.asArray?.();
  if (!a) return false;
  for (let i = 0; i < 16; i++) {
    const want = (i % 5 === 0) ? 1 : 0;
    if (Math.abs(a[i] - want) > IDENTITY_EPS) return false;
  }
  return true;
}

function _transformFlat(flat, matrix) {
  if (_isIdentity(matrix)) return flat;
  const out = new Float32Array(flat.length);
  const v = new BABYLON.Vector3();
  for (let i = 0; i < flat.length; i += 3) {
    v.set(flat[i], flat[i + 1], flat[i + 2]);
    const w = BABYLON.Vector3.TransformCoordinates(v, matrix);
    out[i] = w.x; out[i + 1] = w.y; out[i + 2] = w.z;
  }
  return out;
}

/** The 6 corner-order keys (3 rotations × both windings) of a triangle. */
function _cornerKeys(a, b, c) {
  return [`${a}|${b}|${c}`, `${b}|${c}|${a}`, `${c}|${a}|${b}`, `${a}|${c}|${b}`, `${c}|${b}|${a}`, `${b}|${a}|${c}`];
}

/**
 * Weld the parts into one union in lead space.
 * @returns {{V:number[][], T:number[][], owner:Int32Array, triOwner:Int32Array,
 *   cornerOwner:Map<string,number>, partData:Array}}
 */
function _buildUnion(parts) {
  const cell = WELD_DISTANCE;
  const canonical = new Map();   // posKey → union index
  const V = [];
  const owner = [];              // union vertex → first part index
  const T = [];
  const triOwner = [];           // union triangle → part index
  const cornerOwner = new Map(); // corner-key → part index (original triangles only)
  const partData = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const { mesh, toLead = null } = parts[pi];
    const localPos = mesh.getVerticesData('position');
    const idx = mesh.getIndices() ?? [];
    const uvs = mesh.getVerticesData('uv');
    const pos = _transformFlat(localPos, toLead);
    const n = Math.floor(pos.length / 3);
    const remap = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const k = `${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}`;
      let u = canonical.get(k);
      if (u === undefined) { u = V.length; canonical.set(k, u); V.push([x, y, z]); owner.push(pi); }
      remap[i] = u;
    }
    const tris = [];
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
      tris.push([idx[i], idx[i + 1], idx[i + 2]]);
      if (a === b || b === c || c === a) continue;   // degenerate after weld
      T.push([a, b, c]); triOwner.push(pi);
      for (const k of _cornerKeys(a, b, c)) if (!cornerOwner.has(k)) cornerOwner.set(k, pi);
    }
    partData.push({
      mesh, toLead,
      originalPositions: Float32Array.from(localPos),
      originalUvs: uvs ? Float32Array.from(uvs) : null,
      originalTriangles: tris,
    });
  }
  return { V, T, owner: Int32Array.from(owner), triOwner: Int32Array.from(triOwner), cornerOwner, partData };
}

/**
 * Grid-hashed nearest-original-triangle-centroid lookup → owning part index.
 * Cells are sized to the union's extent; the search widens ring by ring and
 * gives up (−1) after a few rings so a stray far-away triangle never scans
 * the whole mesh.
 */
function _centroidOwnerLookup(V, T, triOwner) {
  if (!T.length) return () => -1;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of V) { if (v[0] < minX) minX = v[0]; if (v[1] < minY) minY = v[1]; if (v[2] < minZ) minZ = v[2]; if (v[0] > maxX) maxX = v[0]; if (v[1] > maxY) maxY = v[1]; if (v[2] > maxZ) maxZ = v[2]; }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const cell = extent / 64;
  const cells = new Map();
  const cx = new Float64Array(T.length), cy = new Float64Array(T.length), cz = new Float64Array(T.length);
  const keyOf = (x, y, z) => `${Math.floor((x - minX) / cell)}|${Math.floor((y - minY) / cell)}|${Math.floor((z - minZ) / cell)}`;
  for (let i = 0; i < T.length; i++) {
    const [a, b, c] = T[i];
    cx[i] = (V[a][0] + V[b][0] + V[c][0]) / 3; cy[i] = (V[a][1] + V[b][1] + V[c][1]) / 3; cz[i] = (V[a][2] + V[b][2] + V[c][2]) / 3;
    const k = keyOf(cx[i], cy[i], cz[i]);
    let list = cells.get(k); if (!list) { list = []; cells.set(k, list); }
    list.push(i);
  }
  return (x, y, z) => {
    const gx = Math.floor((x - minX) / cell), gy = Math.floor((y - minY) / cell), gz = Math.floor((z - minZ) / cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= 3; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;   // shell only
        const list = cells.get(`${gx + dx}|${gy + dy}|${gz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const d = (cx[i] - x) ** 2 + (cy[i] - y) ** 2 + (cz[i] - z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0) return triOwner[best];
    }
    return -1;
  };
}

/**
 * Diagnose the welded union of `parts` (no repair, no write).
 * @param {GroupPart[]} parts
 * @param {{triangleCap?:number}} [opts]
 * @returns {Promise<{boundaryEdges:number, nonManifoldEdges:number, isWatertight:boolean, triangles:number}>}
 */
export async function diagnoseGroup(parts, opts = {}) {
  const cap = opts.triangleCap ?? REPAIR_TRIANGLE_CAP;
  const { V, T } = _buildUnion(parts);
  if (T.length > cap) throw new Error(`multi-part object is too large to diagnose in the browser (${T.length} triangles > ${cap})`);
  const lib = await ensureRepairEngine();
  const d = lib.diagnose(V, T);
  return { boundaryEdges: d.boundary, nonManifoldEdges: d.nonManifold, isWatertight: !!d.isWatertight, triangles: T.length };
}

/**
 * Repair a multi-part logical object as one solid and write each part back.
 * Diagnose-first: a union the engine already reports closed and manifold is
 * left completely alone (nothing rewritten, `changed:false`).
 *
 * @param {GroupPart[]} parts  the live meshes (or export clones) of ONE logical object
 * @param {{triangleCap?:number, timeoutMs?:number, onProgress?:Function, engine?:object, name?:string}} [opts]
 * @returns {Promise<{holesFilled:number, nmFixed:number, isWatertight:boolean, changed:boolean, partsWritten:number}>}
 * @throws when a part would end up with no triangles (nothing is written then)
 */
export async function repairGroup(parts, opts = {}) {
  if (!parts?.length) return { holesFilled: 0, nmFixed: 0, isWatertight: false, changed: false, partsWritten: 0 };
  const cap = opts.triangleCap ?? REPAIR_TRIANGLE_CAP;
  const name = opts.name ?? parts[0].mesh?.name ?? 'multi-part object';
  const union = _buildUnion(parts);
  const { V, T, owner, cornerOwner, partData } = union;
  if (T.length > cap) throw new Error(`"${name}" is too large to repair in the browser (${T.length} triangles > ${cap})`);

  const lib = await ensureRepairEngine();
  const before = lib.diagnose(V, T);
  if (before.isWatertight && !(before.boundary > 0) && !(before.nonManifold > 0)) {
    return { holesFilled: 0, nmFixed: 0, isWatertight: true, changed: false, partsWritten: 0 };
  }

  const out = await repairArraysByComponent(V, T, { ...opts, name });
  if (!out.changed) {
    return { holesFilled: 0, nmFixed: 0, isWatertight: !!out.after.isWatertight, changed: false, partsWritten: 0 };
  }

  // Winding is decided ONCE for the whole union, never per part: a part is an
  // open patch whose partial signed volume has an arbitrary sign, so
  // conforming each part on its own can reverse one patch and not its
  // neighbour and the seam comes back inconsistently wound (measured: a
  // closed 12-triangle cube re-validated with a non-manifold edge). Same
  // rule as MeshRepair.conformWinding — the engine emits a positive
  // right-handed signed volume; Babylon's CounterClockWise-outward is
  // negative — applied to the union under the parts' shared side flag.
  {
    const flat = new Float32Array(out.V.length * 3);
    for (let i = 0; i < out.V.length; i++) { flat[i * 3] = out.V[i][0]; flat[i * 3 + 1] = out.V[i][1]; flat[i * 3 + 2] = out.V[i][2]; }
    const idx = new Uint32Array(out.T.length * 3);
    for (let i = 0; i < out.T.length; i++) { idx[i * 3] = out.T[i][0]; idx[i * 3 + 1] = out.T[i][1]; idx[i * 3 + 2] = out.T[i][2]; }
    const v = signedVolume(flat, idx);
    // One flag for the whole union: siblings of one import share it. If they
    // ever disagree there is no single right answer — refuse before writing
    // (the validator's _groupOrientation skips its check for the same reason).
    const flags = new Set(partData.map(d => frontFaceIsClockwise(d.mesh)));
    if (flags.size > 1) throw new Error(`"${name}": its parts disagree on front-face winding — cannot repair as one solid`);
    const outwardIsNegative = !frontFaceIsClockwise(partData[0].mesh);
    if (Math.abs(v) > 0 && (v < 0) !== outwardIsNegative) {
      for (const t of out.T) { const b = t[1]; t[1] = t[2]; t[2] = b; }
    }
  }

  // ── Hand every output triangle to a part ────────────────
  const unionKey = new Map();
  for (let i = 0; i < V.length; i++) unionKey.set(posKey(V[i][0], V[i][1], V[i][2]), i);
  const flatV = new Float32Array(V.length * 3);
  for (let i = 0; i < V.length; i++) { flatV[i * 3] = V[i][0]; flatV[i * 3 + 1] = V[i][1]; flatV[i * 3 + 2] = V[i][2]; }
  const nearest = nearestIndex(flatV);
  const outUnion = new Int32Array(out.V.length);       // output vertex → original union vertex or -1
  const outOwner = new Int32Array(out.V.length);       // output vertex → owning part
  for (let i = 0; i < out.V.length; i++) {
    const v = out.V[i];
    const hit = unionKey.get(posKey(v[0], v[1], v[2]));
    outUnion[i] = hit === undefined ? -1 : hit;
    outOwner[i] = owner[hit === undefined ? nearest(v) : hit];
  }
  // Spatial fallback for triangles the engine re-cut: the part whose
  // ORIGINAL triangle centroid is nearest. The earlier "first part that
  // touched the vertex" rule handed every seam-adjacent fill to the first
  // part and, on a scan whose parts the engine re-triangulated wholesale,
  // left a small second part with no triangles at all (real scans,
  // 2026-09-18).
  const nearestOriginalOwner = _centroidOwnerLookup(V, T, union.triOwner);
  const perPart = partData.map(() => ({ tris: [], vmap: new Map(), verts: [] }));
  for (const [a, b, c] of out.T) {
    let pi = -1;
    const ua = outUnion[a], ub = outUnion[b], uc = outUnion[c];
    if (ua >= 0 && ub >= 0 && uc >= 0) {
      const hit = cornerOwner.get(`${ua}|${ub}|${uc}`);
      if (hit !== undefined) pi = hit;
    }
    if (pi < 0) {
      const va = out.V[a], vb = out.V[b], vc = out.V[c];
      pi = nearestOriginalOwner((va[0] + vb[0] + vc[0]) / 3, (va[1] + vb[1] + vc[1]) / 3, (va[2] + vb[2] + vc[2]) / 3);
    }
    if (pi < 0) {
      // No original triangle anywhere near (should not happen): majority owner of the corners.
      const oa = outOwner[a], ob = outOwner[b], oc = outOwner[c];
      pi = (ob === oc && ob !== oa) ? ob : oa;
    }
    const bucket = perPart[pi];
    const local = [a, b, c].map(vi => {
      let li = bucket.vmap.get(vi);
      if (li === undefined) { li = bucket.verts.length; bucket.vmap.set(vi, li); bucket.verts.push(out.V[vi]); }
      return li;
    });
    bucket.tris.push(local);
  }

  // Every part must survive: an emptied part would leave a mesh with no
  // triangles in the scene / the export (both reject that). Check before
  // writing anything so a failure leaves all parts untouched.
  for (let pi = 0; pi < perPart.length; pi++) {
    if (!perPart[pi].tris.length) {
      throw new Error(`Repairing "${name}" as one solid would leave part "${partData[pi].mesh?.name ?? pi}" with no triangles — aborted, nothing changed`);
    }
  }

  // ── Write back, part-local space, own UVs ───────────────
  for (let pi = 0; pi < perPart.length; pi++) {
    const { mesh, toLead, originalPositions, originalUvs, originalTriangles } = partData[pi];
    const { tris, verts } = perPart[pi];
    let Vp = verts;
    if (!_isIdentity(toLead)) {
      const inv = toLead.clone(); inv.invert();
      const flat = new Float32Array(verts.length * 3);
      for (let i = 0; i < verts.length; i++) { flat[i * 3] = verts[i][0]; flat[i * 3 + 1] = verts[i][1]; flat[i * 3 + 2] = verts[i][2]; }
      const back = _transformFlat(flat, inv);
      Vp = [];
      for (let i = 0; i < back.length; i += 3) Vp.push([back[i], back[i + 1], back[i + 2]]);
    }
    arraysToMesh(mesh, Vp, tris, originalPositions, originalUvs, originalTriangles);
  }

  const r = out.report;
  return {
    holesFilled: r.holesFilled | 0, nmFixed: r.nmFixed | 0,
    isWatertight: !!out.after.isWatertight, changed: true, partsWritten: perPart.length,
  };
}

/**
 * `toLead` matrix for a live part: part-local → lead-local, i.e.
 * W_part · W_lead⁻¹ (Babylon row-vector convention). Identity when the two
 * world matrices agree (the glTF multi-primitive case).
 * @param {object} partMesh
 * @param {object} leadMesh
 * @returns {object|null} BABYLON.Matrix, or null for identity
 */
export function toLeadMatrix(partMesh, leadMesh) {
  if (partMesh === leadMesh) return null;
  partMesh.computeWorldMatrix?.(true); leadMesh.computeWorldMatrix?.(true);
  const wp = partMesh.getWorldMatrix?.(), wl = leadMesh.getWorldMatrix?.();
  if (!wp || !wl || typeof wl.clone !== 'function' || typeof wp.multiply !== 'function') return null;
  // Same world matrix (element-wise) ⇒ identity without touching the
  // inverse at all — no float drift for the exact-key UV lookup.
  const a = wp.m ?? wp.asArray?.(), b = wl.m ?? wl.asArray?.();
  if (a && b) {
    let same = true;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > IDENTITY_EPS) { same = false; break; }
    if (same) return null;
  }
  const inv = wl.clone(); inv.invert();
  const m = wp.multiply(inv);
  return _isIdentity(m) ? null : m;
}
