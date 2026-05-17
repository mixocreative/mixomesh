// Headless browser/Babylon environment for export tests. Must be called
// BEFORE importing any core/* module (they read window.BABYLON / location at
// module-eval time).

export const calls = {
  objExportOBJ: [],
  objExportMTL: [],
  stlCreate: [],
  downloads: [],
  csgFrom: [],
  vdApply: [],
};

function vec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    subtract(o)      { return vec(this.x - o.x, this.y - o.y, this.z - o.z); },
    add(o)           { return vec(this.x + o.x, this.y + o.y, this.z + o.z); },
    addInPlace(o)    { this.x += o.x; this.y += o.y; this.z += o.z; return this; },
    clone()          { return vec(this.x, this.y, this.z); },
    scale(f)         { return vec(this.x * f, this.y * f, this.z * f); },
    scaleInPlace(f)  { this.x *= f; this.y *= f; this.z *= f; return this; },
    set(x, y, z)     { this.x = x; this.y = y; this.z = z; return this; },
    copyFrom(o)      { this.x = o.x; this.y = o.y; this.z = o.z; return this; },
    lengthSquared()  { return this.x ** 2 + this.y ** 2 + this.z ** 2; },
    normalize()      { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; },
  };
}

const real = {
  Vector3: Object.assign(function (x, y, z) { return vec(x, y, z); }, {
    Zero: () => vec(0, 0, 0),
    Minimize: (a, b) => vec(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
    Maximize: (a, b) => vec(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
    Center:   (a, b) => vec((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2),
    TransformCoordinates: (v) => vec(v.x, v.y, v.z),
    Cross: (a, b) => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x),
  }),
  VertexBuffer: { PositionKind: 'position' },
  Ray: function (origin, dir, len) { this.origin = origin; this.dir = dir; this.len = len; },
  // Matrices are opaque in tests (Vector3.TransformCoordinates is identity);
  // only the call plumbing matters.
  Matrix: {
    RotationX: () => ({ __m: 'Rx', multiply() { return this; } }),
    Scaling:   () => ({ __m: 'S',  multiply() { return this; } }),
    Identity:  () => ({ __m: 'I',  multiply() { return this; } }),
  },
  Color3: Object.assign(function (r, g, b) { return { r, g, b, scale: f => ({ r: r * f, g: g * f, b: b * f }) }; }, {
    FromHexString: () => ({ r: 0.96, g: 0.62, b: 0.04, scale: f => vec(0.96 * f, 0.62 * f, 0.04 * f) }),
  }),
  Color4: function (r, g, b, a) { return { r, g, b, a }; },
  StandardMaterial: function (name) {
    return { name, specularPower: 64, diffuseColor: null,
             diffuseTexture: null, albedoTexture: null, baseTexture: null };
  },
  Quaternion: Object.assign(function (x, y, z, w) { return { x, y, z, w }; }, {
    Identity: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    FromEulerVector: () => ({ x: 0, y: 0, z: 0, w: 1 }),
  }),
  OBJExport: {
    OBJ: (meshes, ...rest) => { calls.objExportOBJ.push({ count: meshes.length, rest }); return 'OBJ-DATA'; },
    MTL: (meshes) => { calls.objExportMTL.push({ count: meshes.length }); return 'MTL-DATA'; },
  },
  STLExport: {
    CreateSTL: (meshes, ...rest) => { calls.stlCreate.push({ count: meshes.length, rest }); },
  },
  // CSG2 present by default so the STL re-bake path is exercised. Tests that
  // need the "CSG2 unavailable" branch null these out + restore.
  CSG2: {
    FromMesh: (m) => { calls.csgFrom.push(m.name); return { toMesh: () => ({ dispose() {} }), dispose() {} }; },
  },
  InitializeCSG2Async: async () => {},
  VertexData: { ExtractFromMesh: () => ({ applyToMesh: () => { calls.vdApply.push(true); } }) },
};

// Anything not explicitly modelled returns a chainable no-op (covers
// SceneManager/AssetLoader top-level construction we don't exercise).
const auto = new Proxy(function () {}, {
  get:       () => auto,
  apply:     () => auto,
  construct: () => auto,
});

const BABYLON = new Proxy(real, {
  get: (t, p) => (p in t ? t[p] : auto),
});

export function installEnv() {
  globalThis.location = { hostname: 'localhost' };
  globalThis.window = { BABYLON, addEventListener() {} };
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0);

  // Force-stub even when Node already defines these (Node's real
  // createObjectURL rejects our fake-zip object — it demands a real Blob).
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};

  const el = () => ({
    style: {}, set href(_) {}, set download(_) {},
    click() { calls.downloads.push(true); },
    appendChild() {}, removeChild() {},
    getContext() { return { createImageData: () => ({ data: [] }), putImageData() {} }; },
    toBlob(cb) { cb(new Blob([])); },
  });
  globalThis.document = {
    createElement: el,
    body: { appendChild() {}, removeChild() {} },
  };
}

export function resetCalls() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
}
