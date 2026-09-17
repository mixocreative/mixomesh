// One-click watertight repair. Engine = vendored MeshFixLib (MIT,
// public/vendor/meshfix): merge → degenerate → winding → duplicates →
// normals → non-manifold edges/vertices → hole fill.
//
// Runs on the main thread inside the ProgressOverlay; capped so a tab cannot
// be blown. No runtime CDN: mesh-fix-core.js / mesh-fix-lib.js are vendored
// classic scripts (UMD/global-assignment, NOT ES modules — neither has an
// `export` statement, see public/vendor/meshfix/*.js), so the engine is
// loaded by injecting <script> tags rather than dynamic import(). Headless
// tests never exercise that path — they inject a fake engine via
// MeshRepair.__test.setEngine(fake).
const CLOCKWISE = 0; // BABYLON.Material.ClockWiseSideOrientation
export const REPAIR_TRIANGLE_CAP = 300_000;
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
  if (typeof document === 'undefined') throw new Error('no engine: DOM unavailable');
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

// Write repaired arrays back. MeshFixLib re-indexes, so UVs are re-attached
// by nearest ORIGINAL vertex (grid hash, exact hits first). Filled triangles
// inherit the UV of their nearest source vertex — a smear inside a hole is
// acceptable; a lost texture on the rest of the part is not.
export function arraysToMesh(mesh, V, T, originalPositions, originalUvs) {
  const pos = new Float32Array(V.length * 3);
  for (let i = 0; i < V.length; i++) { pos[i * 3] = V[i][0]; pos[i * 3 + 1] = V[i][1]; pos[i * 3 + 2] = V[i][2]; }
  const ind = new Uint32Array(T.length * 3);
  for (let i = 0; i < T.length; i++) { ind[i * 3] = T[i][0]; ind[i * 3 + 1] = T[i][1]; ind[i * 3 + 2] = T[i][2]; }
  mesh.setVerticesData('position', pos, true);
  if (originalUvs && originalPositions) {
    const lookup = _nearestIndex(originalPositions);
    const uv = new Float32Array(V.length * 2);
    for (let i = 0; i < V.length; i++) { const j = lookup(V[i]); uv[i * 2] = originalUvs[j * 2]; uv[i * 2 + 1] = originalUvs[j * 2 + 1]; }
    mesh.setVerticesData('uv', uv, true);
  }
  mesh.setIndices(ind, null, true);
  mesh.createNormals?.(true); mesh.refreshBoundingInfo?.();
}

// Exact-hit assumption: an UNTOUCHED vertex round-trips through the engine
// with its float32 bits unchanged, so the grid-hash lookup below finds it by
// exact key match; the brute-force nearest-neighbour scan only runs for
// vertices the engine actually moved or created (new hole-fill verts).
function _nearestIndex(positions) {
  const n = positions.length / 3; const cell = 1e-4; const map = new Map();
  const key = (x, y, z) => `${Math.round(x / cell)}:${Math.round(y / cell)}:${Math.round(z / cell)}`;
  for (let i = 0; i < n; i++) map.set(key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]), i);
  return ([x, y, z]) => {
    const hit = map.get(key(x, y, z)); if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const dx = positions[i * 3] - x, dy = positions[i * 3 + 1] - y, dz = positions[i * 3 + 2] - z; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
    return best;
  };
}

export async function diagnoseMesh(mesh) {
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

export async function repairMesh(mesh, opts = {}) {
  const tris = (mesh.getIndices()?.length ?? 0) / 3;
  if (tris > (opts.triangleCap ?? REPAIR_TRIANGLE_CAP)) throw new Error(`"${mesh.name}" is too large to repair in the browser (${tris} triangles > ${REPAIR_TRIANGLE_CAP})`);
  const lib = await ensureRepairEngine(); const { V, T } = meshToArrays(mesh);
  const originalPositions = Float32Array.from(mesh.getVerticesData('position'));
  const originalUvs = mesh.getVerticesData('uv') ? Float32Array.from(mesh.getVerticesData('uv')) : null;
  const out = await lib.repairObject(V, T, opts.onProgress, { removeSmallShells: false, repairSelfIntersections: false, ...opts.engine });
  const r = out.report ?? {};
  const changed = !_sameTriples(out.V, V, 1e-9) || !_sameTriples(out.T, T, 0);
  if (changed) arraysToMesh(mesh, out.V, out.T, originalPositions, originalUvs);
  // Repaired output is native (CounterClockWise) winding; a ClockWise-flagged glTF clone must be re-tagged (same rule as PrintPipeline._csgRebake).
  if (changed && mesh.sideOrientation === CLOCKWISE) mesh.sideOrientation = 1;
  // Diagnose the mesh as it now IS: the written-back repair output when
  // changed, otherwise the original (out.V/out.T were discarded, unchanged).
  const after = changed ? lib.diagnose(out.V, out.T) : lib.diagnose(V, T);
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
