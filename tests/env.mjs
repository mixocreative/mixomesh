// Headless browser/Babylon environment for export tests. Must be called
// BEFORE importing any src/core/* module (they read window.BABYLON / location at
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
  VertexBuffer: { PositionKind: 'position', UVKind: 'uv' },
  Ray: function (origin, dir, len) { this.origin = origin; this.dir = dir; this.len = len; },
  // Matrices are opaque in tests (Vector3.TransformCoordinates is identity);
  // only the call plumbing matters.
  Matrix: {
    RotationX: () => ({ __m: 'Rx', multiply() { return this; } }),
    Scaling:   () => ({ __m: 'S',  multiply() { return this; } }),
    Identity:  () => ({ __m: 'I',  multiply() { return this; } }),
  },
  Color3: Object.assign(function (r, g, b) { return { r, g, b, scale: f => ({ r: r * f, g: g * f, b: b * f }) }; }, {
    // Parses real hex so shader tests can assert colour values.
    FromHexString: (hex) => {
      const h = String(hex ?? '').replace('#', '');
      const r = (parseInt(h.slice(0, 2), 16) || 0) / 255;
      const g = (parseInt(h.slice(2, 4), 16) || 0) / 255;
      const b = (parseInt(h.slice(4, 6), 16) || 0) / 255;
      return { r, g, b, scale: f => vec(r * f, g * f, b * f) };
    },
  }),
  Color4: function (r, g, b, a) { return { r, g, b, a }; },
  StandardMaterial: function (name) {
    return { name, specularPower: 64, diffuseColor: null,
             diffuseTexture: null, albedoTexture: null, baseTexture: null,
             alpha: 1,
             clone(n) { return { ...this, name: n }; },
             dispose() { this._disposed = true; } };
  },
  PBRMaterial: function (name) {
    return { name, metallic: 0, roughness: 0.5, albedoColor: null,
             albedoTexture: null, baseTexture: null, alpha: 1,
             clone(n) { return { ...this, name: n }; },
             dispose() { this._disposed = true; } };
  },
  Quaternion: Object.assign(function (x, y, z, w) { return { x, y, z, w }; }, {
    Identity: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    FromEulerVector: () => ({ x: 0, y: 0, z: 0, w: 1 }),
  }),
  OBJExport: {
    OBJ: (meshes, ...rest) => { calls.objExportOBJ.push({ count: meshes.length, rest }); return 'OBJ-DATA'; },
    // Realistic per-material block so PrintManager._injectMapKd (which splits
    // the MTL string on `newmtl <name>`) can locate each material and decorate
    // it with `map_Kd textures/solid_*.png`. Production Babylon emits one
    // block per unique material; the stub matches that shape using whichever
    // identifier (.name / .id / mesh.name) the synthesis function also reads.
    MTL: (meshes) => {
      calls.objExportMTL.push({ count: meshes.length });
      return meshes.map(m => {
        const matName = m.material?.name || m.material?.id || m.name;
        return `newmtl ${matName}\nKd 1 1 1\n`;
      }).join('');
    },
  },
  STLExport: {
    CreateSTL: (meshes, ...rest) => {
      calls.stlCreate.push({ count: meshes.length, rest });
      // download=true (rest[0]) is the auto-download path; the caller doesn't
      // use the return value. download=false (individually mode) needs bytes
      // back so the outer zip wrapper has something to embed.
      return rest[0] ? undefined : 'STL-BYTES';
    },
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
  // window.showSaveFilePicker is left undefined so PrintManager._triggerDownload
  // falls back to its anchor-tag path. The anchor's `download` attribute then
  // captures the suggested filename, which is what every export test asserts
  // against. The picker path itself is verified live in Chrome — not in tests.
  globalThis.window = { BABYLON, addEventListener() {} };
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0);

  // Force-stub even when Node already defines these (Node's real
  // createObjectURL rejects our fake-zip object — it demands a real Blob).
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};

  const el = () => {
    let cw = 1, ch = 1;
    let pendingFilename = null;   // captured from `a.download = ...`
    return {
      style: {}, set href(_) {},
      set download(v) { pendingFilename = v; },
      get download() { return pendingFilename; },
      get width() { return cw; }, set width(v) { cw = v; },
      get height() { return ch; }, set height(v) { ch = v; },
      click() { calls.downloads.push(pendingFilename); },
      appendChild() {}, removeChild() {},
      // `data` is a Uint8ClampedArray so `imageData.data.set(pixels)` —
      // the real DOM signature used by _textureToBlob — actually works.
      getContext() {
        return {
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {},
        };
      },
      toBlob(cb) { cb(new Blob([])); },
    };
  };
  globalThis.document = {
    createElement: el,
    body: { appendChild() {}, removeChild() {} },
  };
}

export function resetCalls() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
}
