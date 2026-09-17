// One-click watertight repair. Engine = vendored MeshFixLib (MIT,
// public/vendor/meshfix): merge → degenerate → winding → duplicates →
// normals → non-manifold edges/vertices → hole fill.
//
// Runs on the main thread inside the ProgressOverlay; capped so a tab cannot
// be blown (REPAIR_TRIANGLE_CAP) and wall-clock bounded so a pathological
// mesh cannot hang it forever (REPAIR_TIMEOUT_MS, CIA F4). No runtime CDN:
// mesh-fix-core.js / mesh-fix-lib.js are vendored classic scripts
// (UMD/global-assignment, NOT ES modules — neither has an `export`
// statement, see public/vendor/meshfix/*.js), so the engine is loaded by
// injecting <script> tags rather than dynamic import(). Headless tests never
// exercise that path — they inject a fake engine via
// MeshRepair.__test.setEngine(fake).
//
// Off-thread diagnose/repair is DEFERRED: the vendored engine is a classic
// script that registers a window global and loads its own .wasm relative to
// itself, so it cannot be imported inside a module Worker as-is. Until that
// lands, `diagnoseMesh` and `repairMesh` are both capped at
// REPAIR_TRIANGLE_CAP (I2) so a huge mesh reports "too large" instead of
// freezing the UI thread.

import { signedVolume } from '../print/PrintSpace.js';

const CLOCKWISE = 0;         // BABYLON.Material.ClockWiseSideOrientation
const COUNTER_CLOCKWISE = 1; // BABYLON.Material.CounterClockWiseSideOrientation
export const REPAIR_TRIANGLE_CAP = 300_000;
/** Wall-clock budget for ONE repairMesh call (CIA F4). Override per call with `opts.timeoutMs`. */
export const REPAIR_TIMEOUT_MS = 60_000;
let _engine = null;
let _loading = null;

// Absolute-from-site-root URL so both `npm run dev` and the Electron
// `file://dist/index.html` load resolve (relative `base: './'` in
// vite.config.js means a leading '/' would break the packaged app).
function _vendorUrl(relPath) {
  return (typeof document !== 'undefined' && document.baseURI)
    ? new URL(relPath, document.baseURI).href
    : `/${relPath}`;
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

async function _loadEngine() {
  // `no engine:` prefix is load-bearing — callers classify it as "cannot
  // answer" rather than a real engine failure (MeshValidator._engineDiagnose,
  // applyGeometryFix's weld fallback). A DOM with no `head` (the headless
  // test stub, a detached document) cannot host the vendored <script> tags,
  // which is the same "engine unavailable" class as no DOM at all.
  if (typeof document === 'undefined' || typeof document.head?.appendChild !== 'function') {
    throw new Error('no engine: DOM unavailable');
  }
  if (typeof window.MeshFixCore === 'undefined') {
    await _loadScript(_vendorUrl('vendor/meshfix/mesh-fix-core.js'));
  }
  if (typeof window.MeshFixLib === 'undefined') {
    await _loadScript(_vendorUrl('vendor/meshfix/mesh-fix-lib.js'));
  }
  if (typeof window.MeshFixLib === 'undefined') throw new Error('no engine: MeshFixLib did not register');
  const lib = new window.MeshFixLib();
  await lib.init();
  return lib;
}

export async function ensureRepairEngine() {
  if (_engine) return _engine;
  if (!_loading) {
    _loading = _loadEngine()
      .then(lib => { _engine = lib; return lib; })
      .catch(err => { _loading = null; throw new Error(`Mesh repair engine unavailable: ${err?.message ?? err}`); });
  }
  return _loading;
}

export function meshToArrays(mesh) {
  const p = mesh.getVerticesData('position'); const idx = mesh.getIndices() ?? [];
  const V = []; for (let i = 0; i < p.length; i += 3) V.push([p[i], p[i + 1], p[i + 2]]);
  const T = []; for (let i = 0; i + 2 < idx.length; i += 3) T.push([idx[i], idx[i + 1], idx[i + 2]]);
  return { V, T };
}

// Position grid cell for the original-vertex lookups below. Matches the
// validator's MERGE_DISTANCE / the pipeline's WELD_DISTANCE (0.1 mm at
// 1 BU = 1 m) so "same position" means the same thing everywhere.
const POS_CELL = 1e-4;

function _posKey(x, y, z) {
  return `${Math.round(x / POS_CELL)}:${Math.round(y / POS_CELL)}:${Math.round(z / POS_CELL)}`;
}

/**
 * Reject engine output that cannot be written into a Babylon buffer (CIA F2).
 * A NaN coordinate or an out-of-range index would otherwise be written
 * straight into the live/clone geometry and ship to a slicer as garbage.
 * @throws {Error} `engine returned malformed geometry: …`
 */
function _assertWellFormed(V, T) {
  for (let i = 0; i < V.length; i++) {
    const v = V[i];
    if (!v || v.length < 3
      || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) {
      throw new Error(`engine returned malformed geometry: vertex ${i} is not finite`);
    }
  }
  for (let i = 0; i < T.length; i++) {
    const tri = T[i];
    if (!tri || tri.length < 3) throw new Error(`engine returned malformed geometry: triangle ${i} is not a triple`);
    for (let c = 0; c < 3; c++) {
      const idx = tri[c];
      if (!Number.isInteger(idx) || idx < 0 || idx >= V.length) {
        throw new Error(`engine returned malformed geometry: triangle ${i} index ${idx} outside [0, ${V.length})`);
      }
    }
  }
}

/**
 * Write repaired arrays back.
 *
 * MeshFixLib re-indexes and (stage 1) MERGES duplicate positions, which is
 * exactly what a UV seam is made of: two vertices at one position carrying
 * different UVs. Re-attaching UVs by position alone therefore collapsed both
 * sides of every seam onto one UV and smeared the texture across the part
 * (review C1). So when the caller supplies the original TRIANGLES as well,
 * each output triangle is matched back to its original triangle by the
 * position keys of its three corners (all rotations, both windings) and each
 * corner recovers the UV of its OWN original vertex — then the output vertex
 * buffer is rebuilt per corner, de-duplicated on (output vertex, uv), so a
 * seam vertex the engine merged is split apart again with both UVs intact.
 *
 * Corners with no original triangle (the new hole-fill triangles) fall back
 * to the nearest original vertex's UV — a smear inside a hole is acceptable;
 * a lost texture on the rest of the part is not.
 *
 * @param {object} mesh
 * @param {number[][]} V engine output vertices
 * @param {number[][]} T engine output triangles
 * @param {ArrayLike<number>} [originalPositions]
 * @param {ArrayLike<number>} [originalUvs]
 * @param {number[][]} [originalTriangles] original triangle list (enables the
 *   seam-preserving corner mapping; omitted ⇒ nearest-vertex UVs only)
 */
export function arraysToMesh(mesh, V, T, originalPositions, originalUvs, originalTriangles = null) {
  _assertWellFormed(V, T);
  if (originalUvs && originalPositions) {
    _writeUvAware(mesh, V, T, originalPositions, originalUvs, originalTriangles);
  } else {
    const pos = new Float32Array(V.length * 3);
    for (let i = 0; i < V.length; i++) { pos[i * 3] = V[i][0]; pos[i * 3 + 1] = V[i][1]; pos[i * 3 + 2] = V[i][2]; }
    const ind = new Uint32Array(T.length * 3);
    for (let i = 0; i < T.length; i++) { ind[i * 3] = T[i][0]; ind[i * 3 + 1] = T[i][1]; ind[i * 3 + 2] = T[i][2]; }
    mesh.setVerticesData('position', pos, true);
    mesh.setIndices(ind, null, true);
  }
  mesh.createNormals?.(true); mesh.refreshBoundingInfo?.();
}

/**
 * `posKeyA|posKeyB|posKeyC` → the original triangle's corner indices in that
 * same order, registered for all 3 rotations AND the 3 reversed rotations
 * (the engine may re-wind a triangle while leaving its corners in place).
 */
function _originalTriangleCorners(originalPositions, originalTriangles) {
  const keyOf = (i) => _posKey(originalPositions[i * 3], originalPositions[i * 3 + 1], originalPositions[i * 3 + 2]);
  const map = new Map();
  const put = (a, b, c) => {
    const k = `${keyOf(a)}|${keyOf(b)}|${keyOf(c)}`;
    if (!map.has(k)) map.set(k, [a, b, c]);
  };
  for (const tri of originalTriangles) {
    const [a, b, c] = tri;
    put(a, b, c); put(b, c, a); put(c, a, b);
    put(a, c, b); put(c, b, a); put(b, a, c);
  }
  return map;
}

function _writeUvAware(mesh, V, T, originalPositions, originalUvs, originalTriangles) {
  const cornerMap = originalTriangles?.length
    ? _originalTriangleCorners(originalPositions, originalTriangles)
    : null;
  const nearest = _nearestIndex(originalPositions);
  const uvCount = originalUvs.length / 2;
  const uvAt = (i) => {
    const j = (i >= 0 && i < uvCount) ? i : 0;
    return [originalUvs[j * 2] ?? 0, originalUvs[j * 2 + 1] ?? 0];
  };
  const vKeys = V.map(v => _posKey(v[0], v[1], v[2]));

  const posOut = []; const uvOut = [];
  const ind = new Uint32Array(T.length * 3);
  const emitted = new Map();   // `${outputVertex}#${u},${v}` → new index

  for (let ti = 0; ti < T.length; ti++) {
    const tri = T[ti];
    const orig = cornerMap?.get(`${vKeys[tri[0]]}|${vKeys[tri[1]]}|${vKeys[tri[2]]}`) ?? null;
    for (let c = 0; c < 3; c++) {
      const vi = tri[c];
      const [u, w] = uvAt(orig ? orig[c] : nearest(V[vi]));
      const key = `${vi}#${u},${w}`;
      let ni = emitted.get(key);
      if (ni === undefined) {
        ni = posOut.length / 3;
        posOut.push(V[vi][0], V[vi][1], V[vi][2]);
        uvOut.push(u, w);
        emitted.set(key, ni);
      }
      ind[ti * 3 + c] = ni;
    }
  }

  mesh.setVerticesData('position', Float32Array.from(posOut), true);
  mesh.setVerticesData('uv', Float32Array.from(uvOut), true);
  mesh.setIndices(ind, null, true);
}

// Exact-hit assumption: an UNTOUCHED vertex round-trips through the engine
// with its float32 bits unchanged, so the grid-hash lookup below finds it by
// exact key match; the brute-force nearest-neighbour scan only runs for
// vertices the engine actually moved or created (new hole-fill verts).
function _nearestIndex(positions) {
  const n = positions.length / 3; const map = new Map();
  for (let i = 0; i < n; i++) map.set(_posKey(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]), i);
  return ([x, y, z]) => {
    const hit = map.get(_posKey(x, y, z)); if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const dx = positions[i * 3] - x, dy = positions[i * 3 + 1] - y, dz = positions[i * 3 + 2] - z; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
    return best;
  };
}

/**
 * Engine diagnose for one mesh (or duck-typed positions/indices wrapper).
 * Capped like `repairMesh` (I2): diagnose is a synchronous WASM call on the
 * main thread, and a multi-million-triangle model froze the tab on every
 * validation pass. Above the cap this REJECTS with a distinct `too large`
 * message so callers can tell "cannot answer" from "answered: broken".
 * @param {object} mesh
 * @param {{triangleCap?:number}} [opts]
 */
export async function diagnoseMesh(mesh, opts = {}) {
  const cap = opts.triangleCap ?? REPAIR_TRIANGLE_CAP;
  const tris = (mesh.getIndices()?.length ?? 0) / 3;
  const name = mesh.name ?? 'mesh';
  if (tris > cap) throw new Error(`"${name}" is too large to diagnose in the browser (${tris} triangles > ${cap})`);
  const lib = await ensureRepairEngine(); const { V, T } = meshToArrays(mesh);
  const d = lib.diagnose(V, T);
  return { boundaryEdges: d.boundary, nonManifoldEdges: d.nonManifold, components: d.components, isWatertight: !!d.isWatertight, triangles: T.length };
}

// Element-wise comparison of two arrays of triples ([x,y,z] or [a,b,c]).
// `tolerance` > 0 compares with float slack (positions); 0 compares exactly
// (indices). Used to decide `changed` from the DATA, not from report field
// names — the vendored wrapper's report only ever sets holesFilled/nmFixed/
// merged (public/vendor/meshfix/mesh-fix-lib.js:374-411,542-544), so a
// winding-only or self-intersection repair would report all-zero counters
// while still returning a different mesh; gating the write-back on counter
// names would silently discard that output.
function _sameTriples(a, b, tolerance) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (tolerance > 0) {
      if (Math.abs(x[0] - y[0]) > tolerance || Math.abs(x[1] - y[1]) > tolerance || Math.abs(x[2] - y[2]) > tolerance) return false;
    } else if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) {
      return false;
    }
  }
  return true;
}

/**
 * The engine's own option defaults, so an upstream default we do not name
 * here still reaches the WASM call (M7). `defaultOptions()` is a STATIC on
 * MeshFixLib (public/vendor/meshfix/mesh-fix-lib.js:91), hence the
 * constructor lookup first; a test fake may expose it as an instance method.
 */
function _engineDefaults(lib) {
  for (const owner of [lib?.constructor, lib]) {
    if (typeof owner?.defaultOptions !== 'function') continue;
    try { return owner.defaultOptions() ?? {}; }
    catch { /* a fake/partial engine: fall through to no defaults */ }
  }
  return {};
}

/**
 * Wall-clock guard (CIA F4). The vendored `repairObject` accepts an
 * `{ signal }` extra and checks it around the WASM call, so the abort
 * actually shortens the run where the engine can honour it; the race
 * guarantees the CALLER is released either way. Rejects with `/timed out/`,
 * which `_tryRepair`/`reportError` already surface with the mesh name.
 */
function _withTimeout(run, timeoutMs, name) {
  if (!(timeoutMs > 0)) return Promise.resolve(run(null));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`Mesh repair timed out after ${Math.round(timeoutMs / 1000)}s for "${name}"`));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(run(controller?.signal ?? null)), timeout])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Re-tag the effective winding after a repair (I1).
 *
 * A COMPLETED repair returns geometry in the engine's native
 * (CounterClockWise) winding, so a ClockWise-flagged glTF clone must be
 * re-tagged or PrintSpace.printIndices ships it inside-out (same rule as
 * PrintPipeline._csgRebake). A PARTIAL repair guarantees nothing, so the
 * flag is derived from the geometry as written back instead: Babylon is
 * left-handed, so an outward-facing CounterClockWise mesh has a NEGATIVE
 * right-handed signed volume (PrintSpace.signedVolume / frontFaceIsClockwise).
 */
function _retagWinding(mesh, after) {
  if (mesh.sideOrientation !== CLOCKWISE) return;
  if (after?.isWatertight === true) { mesh.sideOrientation = COUNTER_CLOCKWISE; return; }
  const positions = mesh.getVerticesData?.('position');
  const indices = mesh.getIndices?.();
  if (!positions?.length || !indices?.length) return;
  mesh.sideOrientation = signedVolume(positions, indices) < 0 ? COUNTER_CLOCKWISE : CLOCKWISE;
}

/**
 * Repair one mesh IN PLACE through the engine.
 * @param {object} mesh
 * @param {{triangleCap?:number, timeoutMs?:number, onProgress?:Function, engine?:object}} [opts]
 * @returns {Promise<{holesFilled:number, nmFixed:number, normalsFlipped:number,
 *   merged:number, isWatertight:boolean, changed:boolean}>}
 *   `normalsFlipped` is reported for forward compatibility only — the
 *   vendored engine's report never sets it (CIA F11).
 */
export async function repairMesh(mesh, opts = {}) {
  const cap = opts.triangleCap ?? REPAIR_TRIANGLE_CAP;
  const tris = (mesh.getIndices()?.length ?? 0) / 3;
  // M8: name the cap that was actually APPLIED, not the module default — a
  // caller-lowered cap used to report the 300k number it did not enforce.
  if (tris > cap) throw new Error(`"${mesh.name}" is too large to repair in the browser (${tris} triangles > ${cap})`);
  const lib = await ensureRepairEngine(); const { V, T } = meshToArrays(mesh);
  const originalPositions = Float32Array.from(mesh.getVerticesData('position'));
  const originalUvs = mesh.getVerticesData('uv') ? Float32Array.from(mesh.getVerticesData('uv')) : null;
  const engineOptions = {
    ..._engineDefaults(lib),
    removeSmallShells: false, repairSelfIntersections: false,
    ...opts.engine,
  };
  const out = await _withTimeout(
    (signal) => lib.repairObject(V, T, opts.onProgress, engineOptions, signal ? { signal } : null),
    opts.timeoutMs ?? REPAIR_TIMEOUT_MS,
    mesh.name ?? 'mesh',
  );
  // CIA F2: validate the engine's output BEFORE anything reads it. Checking
  // only inside arraysToMesh was not enough — a NaN coordinate compares
  // "equal" to everything (every NaN comparison is false), so `changed` came
  // out false and the malformed output was silently discarded instead of
  // reported.
  _assertWellFormed(out.V, out.T);
  const r = out.report ?? {};
  const changed = !_sameTriples(out.V, V, 1e-9) || !_sameTriples(out.T, T, 0);
  // Diagnose the mesh as it now IS: the repair output when changed, otherwise
  // the original (out.V/out.T are discarded, unchanged). Taken BEFORE the
  // write-back so the winding re-tag can consult it (I1).
  const after = changed ? lib.diagnose(out.V, out.T) : lib.diagnose(V, T);
  if (changed) {
    arraysToMesh(mesh, out.V, out.T, originalPositions, originalUvs, T);
    _retagWinding(mesh, after);
  }
  return { holesFilled: r.holesFilled | 0, nmFixed: r.nmFixed | 0, normalsFlipped: r.normalsFlipped | 0, merged: r.merged | 0, isWatertight: !!after.isWatertight, changed };
}

// Test-only seam: __test.setEngine(fake) makes ensureRepairEngine() resolve
// the fake without touching the network; setEngine(null) makes it reject
// with /no engine/ (rejection pre-caught so no unhandled-rejection warning).
export const __test = {
  setEngine(e) {
    _engine = e;
    _loading = e ? Promise.resolve(e) : Promise.reject(new Error('no engine (test)'));
    _loading.catch(() => {});
  },
};
