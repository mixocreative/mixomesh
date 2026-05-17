import { getState } from './StateManager.js';
import { Toast } from '../ui/Toast.js';
import { MeshValidator } from './MeshValidator.js';
import { AssetLoader } from './AssetLoader.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Scale ────────────────────────────────────────────────

export const SCALE_PRESETS = [
  { category: 'Default',  label: '1:1 Full Scale', ratio: 1 },
  { category: 'Military', label: '1:35 Armor', ratio: 35 },
  { category: 'Military', label: '1:48 Aircraft', ratio: 48 },
  { category: 'Military', label: '1:72 Small', ratio: 72 },
  { category: 'Military', label: '1:100 Micro', ratio: 100 },
  { category: 'Miniatures', label: '28mm Heroic', ratio: 56 },
  { category: 'Miniatures', label: '32mm Standard', ratio: 48 },
  { category: 'Miniatures', label: '54mm Large', ratio: 32 },
  { category: 'Tabletop', label: '6mm Epic', ratio: 300 },
  { category: 'Custom', label: 'Custom', ratio: null },
];

function _exportFactor() {
  const state = getState();
  const wr = state.print.workingRatio > 0 ? state.print.workingRatio : 1;
  const tr = state.print.targetRatio > 0 ? state.print.targetRatio : 1;
  return (wr / tr) * 1000; // BU (m at workingRatio) → mm at targetRatio
}

export function getExportedDimensions(meshId) {
  const state = getState();
  const obj = state.scene.objects[meshId];
  if (!obj) return null;
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return null;

  const bb = mesh.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const factor = _exportFactor();

  return {
    x: size.x * factor,
    y: size.y * factor,
    z: size.z * factor,
  };
}

// ── Mesh Collection ──────────────────────────────────────

/**
 * Collect all printable meshes (isPrintPart:true, not empty).
 * If selectedOnly, filter to selected meshes only.
 */
function _collectPrintMeshes(selectedOnly) {
  const state = getState();
  const objects = state.scene.objects;
  const result = [];

  for (const [meshId, obj] of Object.entries(objects)) {
    if (obj.isGhost || !obj.isPrintPart) continue;

    const mesh = AssetLoader.getBabylonMesh(meshId);
    if (!mesh) continue;

    // Skip empty nodes (no geometry / zero vertices)
    if (!mesh.getTotalVertices?.() || mesh.getTotalVertices() === 0) continue;

    // If selectedOnly, check if in selection
    if (selectedOnly && !state.selection.selectedIds.includes(meshId)) continue;

    result.push({ meshId, mesh, obj });
  }

  return result;
}

// ── Texture Export ───────────────────────────────────────

/**
 * Extract all unique textures from a list of meshes and convert to PNG blobs.
 * Returns Map<filename, blob>.
 */
async function _collectTextureBlobs(meshes) {
  const textureMap = new Map(); // assetId → { name, blob }
  const state = getState();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!mat) continue;

    // Check diffuse/albedo/base textures
    const textures = [];
    if (mat.diffuseTexture) textures.push(mat.diffuseTexture);
    else if (mat.albedoTexture) textures.push(mat.albedoTexture);
    else if (mat.baseTexture) textures.push(mat.baseTexture);

    for (const tex of textures) {
      if (!tex) continue;

      // Generate unique asset ID-based filename
      const assetId = _getAssetIdForTexture(tex);
      if (!assetId || textureMap.has(assetId)) continue;

      // Re-encode texture to PNG blob
      try {
        const blob = await _textureToBlob(tex);
        textureMap.set(assetId, {
          name: tex.name || assetId,
          blob,
        });
      } catch (err) {
        console.error(`Failed to export texture ${tex.name}:`, err);
      }
    }
  }

  // Build result map with deduped filenames
  const result = new Map();
  const usedNames = new Set();

  for (const [assetId, { name, blob }] of textureMap) {
    let filename = `${name}.png`;
    let counter = 0;
    while (usedNames.has(filename)) {
      counter++;
      filename = `${name}_${counter}.png`;
    }
    usedNames.add(filename);
    result.set(filename, blob);
  }

  return result;
}

/**
 * Find the asset ID for a texture by checking the asset library.
 */
function _getAssetIdForTexture(texture) {
  const state = getState();
  // Textures from imports are stored in assetLibrary
  for (const [assetId, asset] of Object.entries(state.scene.assetLibrary)) {
    if (asset.textures?.[texture.name]) {
      return assetId;
    }
  }
  // Fallback: use texture name
  return texture.name || texture.uniqueId?.toString();
}

/**
 * Convert a Babylon texture to a PNG blob using readPixels and canvas.
 */
async function _textureToBlob(texture) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = texture.getBaseSize().width;
      canvas.height = texture.getBaseSize().height;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');

      // Use Babylon's readPixels to extract texture data
      const pixels = texture.readPixels();
      if (!pixels) throw new Error('readPixels returned null');

      const imageData = ctx.createImageData(canvas.width, canvas.height);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);

      canvas.toBlob(blob => {
        if (!blob) throw new Error('toBlob produced no blob');
        resolve(blob);
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

// ── Export ───────────────────────────────────────────────

async function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Pre-export auto-fix ──────────────────────────────────

let _csgInitPromise = null;

/**
 * Lazily initialise Babylon's Manifold-backed CSG2. Returns false (not throw)
 * when CSG2 isn't present in the loaded Babylon build so callers degrade
 * gracefully.
 */
async function _ensureCSG2() {
  const B = window.BABYLON;
  if (!B || !B.CSG2 || typeof B.InitializeCSG2Async !== 'function') return false;
  try {
    if (!_csgInitPromise) _csgInitPromise = B.InitializeCSG2Async();
    await _csgInitPromise;
    return true;
  } catch (err) {
    console.error('CSG2 init failed:', err);
    return false;
  }
}

/**
 * Round-trip a mesh through CSG2 (Manifold). A Manifold result is watertight
 * by construction, so this single re-bake closes sub-tolerance gaps AND
 * dissolves internal faces (the geometry that would otherwise become FEP-stuck
 * islands). Geometry is replaced in place.
 */
function _csgRebake(mesh) {
  const B = window.BABYLON;
  const csg = B.CSG2.FromMesh(mesh);
  const baked = csg.toMesh(`${mesh.name}__csg`, mesh.getScene());
  const vd = B.VertexData.ExtractFromMesh(baked);
  vd.applyToMesh(mesh);
  baked.dispose();
  csg.dispose?.();
}

/**
 * File-type-specific final geometry hygiene, run on the export *clone* only —
 * never on the live scene mesh.
 *
 *  Coincident vertices → optimizeIndices()  — kills zero-thickness walls /
 *                                             light-leak slivers.
 *  Small gaps           → CSG2 re-bake      — slicer would read a gap as
 *                                             "outside" and wreck hollowing.
 *  Internal faces       → CSG2 union        — internal geometry → islands
 *                                             that stick to the FEP film.
 *  Inverted normals     → createNormals(true) — slicer needs a consistent
 *                                               "solid" direction.
 *
 * OBJ is the colored-print format: CSG2 would collapse per-face materials, so
 * the watertight re-bake is **STL-only**. OBJ gets the colour-safe subset.
 *
 * @param {object} mesh
 * @param {'obj'|'stl'} fileType
 * @param {boolean} csgReady
 */
const WELD_DISTANCE = 1e-4;   // 0.1 mm (1 BU = 1 m) — matches MeshValidator

/** Weld coincident vertices (color-safe, both formats). Resolves the
 *  unwelded-import "non-manifold" noise and primes geometry for CSG. */
function _weld(mesh) {
  const B = window.BABYLON;
  try {
    if (typeof mesh.mergeVerticesByDistance === 'function') {
      mesh.mergeVerticesByDistance(WELD_DISTANCE);
    } else if (typeof B.VertexData?.MergeByDistance === 'function') {
      const vd = B.VertexData.ExtractFromMesh(mesh);
      B.VertexData.MergeByDistance(vd, WELD_DISTANCE);
      vd.applyToMesh(mesh);
    }
  } catch (err) {
    console.error(`Vertex weld skipped for ${mesh.name}:`, err);
  }
}

/** A mesh is "solid colour" when its material carries no image texture — safe
 *  for a per-mesh CSG2 re-bake (3MF colour is per-object, not per-face). */
function _isSolidColor(mesh) {
  const m = mesh.material;
  if (!m) return true;
  return !(m.diffuseTexture || m.albedoTexture || m.baseTexture);
}

// ── Structured export pipeline ───────────────────────────
//
// Every format runs the same orchestration:
//   collect → clone+scale → format-specific PREP steps → re-validate the
//   fixed clones → serialize → package/download.
// A format is just a declarative entry in FORMATS: which PREP steps to run
// (in order) and how to serialize. Add/adjust a format here, nowhere else.

// Babylon is Y-up (and, after the import bake, left-handed). 3MF / slicers
// are Z-up right-handed. This rotation maps Babylon (x,y,z) → 3MF; the
// winding flip restores outward normals for the RH consumer. Both are single
// switches: if a live test shows the model lying down / mirrored, this is the
// one place to adjust (LH↔RH reasoning is unreliable on paper — verify in a
// slicer, same lesson as the nav-cube convention).
const Y_UP_TO_Z_UP = BABYLON.Matrix.RotationX(-Math.PI / 2);
const THREEMF_REVERSE_WINDING = true;
// 3MF 3×4 row-major identity — emitted on every build item so placement is
// driven solely by the baked vertices, never a viewer-guessed transform.
const THREEMF_IDENTITY = '1 0 0 0 1 0 0 0 1 0 0 0';

/** Single reusable clean-up operations, keyed by name. (mesh, ctx) → void. */
const PREP_STEPS = {
  // OBJ/3MF MTL serializers deref material.specularPower — an untextured
  // glTF import has none. Give the export clone a neutral material.
  fallbackMaterial(mesh) {
    if (mesh.material) return;
    const m = new BABYLON.StandardMaterial(`${mesh.name}__mat`, mesh.getScene?.() ?? null);
    if ('diffuseColor' in m && BABYLON.Color3) m.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
    mesh.material = m;
  },
  // Bake the FULL world matrix (ancestors included) + the export mm scale
  // into the vertices, then flatten the node to identity. Without this, a
  // mesh parented into a group exports at its group-local transform — the
  // "scales/locations messed up" bug. Hierarchy-independent afterwards, so
  // OBJ/STL/3MF all read correct world geometry.
  flattenWorld(mesh, ctx) {
    mesh.computeWorldMatrix?.(true);
    const W = mesh.getWorldMatrix?.();
    if (!W) return;
    const M = W.multiply(BABYLON.Matrix.Scaling(ctx.factor, ctx.factor, ctx.factor));
    mesh.bakeTransformIntoVertices?.(M);
    mesh.setParent?.(null);
    mesh.position?.set?.(0, 0, 0);
    mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
    mesh.rotation?.set?.(0, 0, 0);
    mesh.scaling?.set?.(1, 1, 1);
    mesh.refreshBoundingInfo?.();
  },
  weld(mesh)            { _weld(mesh); },
  optimizeIndices(mesh) { mesh.optimizeIndices?.(); },
  createNormals(mesh)   { mesh.createNormals?.(true); },
  // Watertight re-bake. `csg` = unconditional (STL). `csgSolidOnly` skips
  // textured meshes so their UVs survive (3MF colour is per-object).
  //
  // CSG2/Manifold REQUIRES watertight input — it cannot heal a non-watertight
  // mesh, it rejects it ("Not manifold"). That is the normal case for
  // downloaded display models and is NOT an error: we skip the re-bake for
  // that part, record it, and let the slicer auto-repair. Only the count is
  // surfaced (one info toast), never per-mesh console noise.
  csg(mesh, ctx)          { _tryCsg(mesh, ctx); },
  csgSolidOnly(mesh, ctx) { if (_isSolidColor(mesh)) _tryCsg(mesh, ctx); },
};

function _tryCsg(mesh, ctx) {
  if (!ctx.csgReady) return;
  try { _csgRebake(mesh); }
  catch { ctx.csgSkipped.push(mesh.name); }   // not watertight → slicer repairs
}

function _exportError(message, validationErrors) {
  return Object.assign(new Error(message), { validationErrors });
}

/**
 * Re-validate the auto-fixed export clones. Only what's still wrong AFTER the
 * prep steps is reported — the error list never shows a problem the clean-up
 * already resolved.
 */
async function _validateExportMeshes(list, onStep) {
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const { mesh, name } = list[i];
    let results;
    try { results = await MeshValidator.validateMesh(mesh); }
    catch (err) { console.error(`Validation failed for ${name}:`, err); continue; }
    for (const r of results || []) {
      if (r.severity === 'error') errors.push({ meshName: name, message: r.message });
    }
    onStep?.(i + 1, list.length);
  }
  return errors;
}

/**
 * One orchestrator for every format.
 * @param {'obj'|'stl'|'3mf'} formatKey
 * @param {{ selectedOnly?:boolean, individually?:boolean,
 *           onProgress?:(frac:number,msg:string)=>void }} options
 */
async function _runExport(formatKey, options = {}) {
  const fmt = FORMATS[formatKey];
  if (!fmt) throw new Error(`Unknown export format: ${formatKey}`);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  progress(0.02, 'Collecting meshes…');
  const printMeshes = _collectPrintMeshes(!!options.selectedOnly);
  if (printMeshes.length === 0) throw new Error('No printable meshes to export.');

  const state  = getState();
  const factor = _exportFactor();
  const ctx = {
    state, factor, options,
    projectName: state.project.name || 'Untitled',
    individually: !!options.individually,
    meshes: [],
    csgReady: false,
    csgSkipped: [],
  };

  if (fmt.needsCSG) {
    ctx.csgReady = await _ensureCSG2();
    if (!ctx.csgReady) Toast.show('CSG2 unavailable — watertight re-bake skipped', 'warning', 4000);
  }

  const clones = [];
  const dispose = () => { for (const e of clones) { try { e.mesh.dispose?.(); } catch { /* */ } } };

  try {
    const N = printMeshes.length;
    for (let i = 0; i < N; i++) {
      const { meshId, mesh } = printMeshes[i];
      // Keep the parent so the clone's world matrix includes group/ancestor
      // transforms; `flattenWorld` then bakes that full world (+ mm scale)
      // into the vertices.
      const clone = (mesh.clone?.(`${mesh.name}__export`, mesh.parent ?? null, true)) || mesh;
      // CRITICAL: Babylon's clone shares the source geometry by reference.
      // Every prep step rewrites vertex data in place — without a unique
      // geometry copy here they would corrupt the live scene mesh. This makes
      // the whole export pipeline non-destructive for ALL formats.
      if (clone !== mesh) clone.makeGeometryUnique?.();
      for (const stepKey of fmt.prep) {
        const step = PREP_STEPS[stepKey];
        if (!step) continue;
        try { step(clone, ctx); }
        catch (e) { console.error(`Prep "${stepKey}" failed for ${clone.name}:`, e); }
      }
      clones.push({ meshId, mesh: clone, name: mesh.name || `mesh_${meshId}` });
      progress(0.05 + 0.45 * ((i + 1) / N), `Preparing ${i + 1}/${N}…`);
    }
    ctx.meshes = clones;

    const remaining = await _validateExportMeshes(
      clones, (d, t) => progress(0.5 + 0.3 * (d / t), `Validating ${d}/${t}…`));
    if (remaining.length) throw _exportError('Validation errors remain after auto-fix.', remaining);

    progress(0.82, `Writing ${fmt.label}…`);
    const out = await fmt.serialize(ctx);

    if (out.kind === 'direct') {
      out.run();
    } else {
      progress(0.9, 'Packaging…');
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const e of out.entries) zip.file(e.path, e.data);
      const blob = await zip.generateAsync({ type: 'blob', mimeType: out.mime });
      progress(0.98, 'Downloading…');
      await _triggerDownload(blob, out.filename);
    }
    progress(1, 'Done');
    Toast.show(`✓ Exported ${out.filename ?? fmt.label}`, 'success', 3000);
    if (ctx.csgSkipped.length) {
      const n = ctx.csgSkipped.length;
      Toast.show(`${n} part${n === 1 ? '' : 's'} not watertight — re-bake skipped; slicer will auto-repair`, 'info', 5000);
    }
  } catch (err) {
    if (!err.validationErrors) console.error(`${fmt.label} export failed:`, err);
    throw err;
  } finally {
    dispose();
  }
}

// ── Per-format serializers ───────────────────────────────

async function _serializeOBJ(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  const textureBlobs = await _collectTextureBlobs(meshes);
  const entries = [];
  if (ctx.individually) {
    for (const { mesh, name } of ctx.meshes) {
      entries.push({ path: `${name}.obj`, data: BABYLON.OBJExport.OBJ([mesh], true, `${ctx.projectName}.mtl`, true) });
      entries.push({ path: `${name}.mtl`, data: BABYLON.OBJExport.MTL([mesh]) });
    }
  } else {
    entries.push({ path: `${ctx.projectName}.obj`, data: BABYLON.OBJExport.OBJ(meshes, true, `${ctx.projectName}.mtl`, true) });
    entries.push({ path: `${ctx.projectName}.mtl`, data: BABYLON.OBJExport.MTL(meshes) });
  }
  for (const [filename, blob] of textureBlobs) entries.push({ path: `textures/${filename}`, data: blob });
  return { kind: 'zip', mime: 'application/zip', filename: `${ctx.projectName}.zip`, entries };
}

function _serializeSTL(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  return {
    kind: 'direct', filename: `${ctx.projectName}.stl`,
    run: () => BABYLON.STLExport.CreateSTL(meshes, true, ctx.projectName, true, false, false, false),
  };
}

function _serialize3MF(ctx) {
  return {
    kind: 'zip', mime: 'model/3mf', filename: `${ctx.projectName}.3mf`,
    entries: [
      { path: '[Content_Types].xml', data: _3MF_CONTENT_TYPES },
      { path: '_rels/.rels',         data: _3MF_RELS },
      { path: '3D/3dmodel.model',    data: _build3MFModel(ctx.meshes) },
    ],
  };
}

/**
 * Format registry — the single place that defines what each export type does.
 *  prep:     ordered PREP_STEPS keys run on every clone
 *  needsCSG: initialise Manifold/CSG2 before prep (for csg* steps)
 *  serialize(ctx) → { kind:'zip', mime, filename, entries } | { kind:'direct', run }
 */
const FORMATS = {
  obj: {
    label: 'OBJ + MTL', needsCSG: false,
    prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'optimizeIndices', 'createNormals'],
    serialize: _serializeOBJ,
  },
  stl: {
    label: 'STL', needsCSG: true,
    prep: ['flattenWorld', 'weld', 'optimizeIndices', 'csg', 'createNormals'],
    serialize: _serializeSTL,
  },
  '3mf': {
    label: '3MF', needsCSG: true,
    prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'optimizeIndices',
           'csgSolidOnly', 'createNormals'],
    serialize: _serialize3MF,
  },
};

/** Public export entry points — thin wrappers over the one orchestrator. */
export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);

// ── 3MF (color, mm-native, multi-shell) ──────────────────

function _clamp255(c) { return Math.max(0, Math.min(255, Math.round((c ?? 0) * 255))); }
function _hex2(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }

/** Solid diffuse colour of a mesh's material as 3MF #RRGGBBFF. */
function _materialHex(mesh) {
  const m = mesh.material || {};
  const c = m.diffuseColor || m.albedoColor || m.baseColor;
  if (!c) return '#CCCCCCFF';
  return `#${_hex2(_clamp255(c.r))}${_hex2(_clamp255(c.g))}${_hex2(_clamp255(c.b))}FF`;
}

/**
 * Build the 3MF `3D/3dmodel.model` XML. Each export mesh becomes its own
 * <object> (multi-shell hierarchy preserved, unlike STL's single blob) with a
 * solid colour via the Materials extension colorgroup — exactly the
 * one-colour-per-part model this tool produces.
 *
 * Vertices arrive world-space millimetre (from `flattenWorld`) in Babylon
 * Y-up; here they're rotated into 3MF Z-up (`Y_UP_TO_Z_UP`), winding flipped
 * for the right-handed consumer, then the whole build is centred on the
 * origin so it lands on the slicer bed. `unit="millimeter"` is literal.
 */
function _build3MFModel(list) {
  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of list) {
    const hex = _materialHex(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }

  // Pass 1: rotate every mesh's vertices into 3MF space and find the union
  // bounds (for origin-centering) over the *converted* coordinates.
  const converted = new Map();   // mesh → Float32Array (3MF-space xyz)
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const { mesh } of list) {
    const p = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    if (!p) continue;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const w = BABYLON.Vector3.TransformCoordinates(
        new BABYLON.Vector3(p[i], p[i + 1], p[i + 2]), Y_UP_TO_Z_UP);
      out[i] = w.x; out[i + 1] = w.y; out[i + 2] = w.z;
      if (w.x < mnx) mnx = w.x; if (w.x > mxx) mxx = w.x;
      if (w.y < mny) mny = w.y; if (w.y > mxy) mxy = w.y;
      if (w.z < mnz) mnz = w.z; if (w.z > mxz) mxz = w.z;
    }
    converted.set(mesh, out);
  }
  const cx = Number.isFinite(mnx) ? (mnx + mxx) / 2 : 0;
  const cy = Number.isFinite(mny) ? (mny + mxy) / 2 : 0;
  const cz = Number.isFinite(mnz) ? (mnz + mxz) / 2 : 0;

  const objs = [];
  const items = [];
  let objId = 2;                                  // id 1 = colorgroup
  for (const { mesh } of list) {
    const pos = converted.get(mesh);
    const idx = mesh.getIndices();
    if (!pos || !idx || idx.length === 0) { objId++; continue; }

    let v = '';
    for (let i = 0; i < pos.length; i += 3) {
      v += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    let t = '';
    for (let i = 0; i < idx.length; i += 3) {
      const [b, c] = THREEMF_REVERSE_WINDING ? [idx[i + 2], idx[i + 1]] : [idx[i + 1], idx[i + 2]];
      t += `<triangle v1="${idx[i]}" v2="${b}" v3="${c}"/>`;
    }
    const pidx = colorIndex.get(_materialHex(mesh)) ?? 0;
    objs.push(
      `<object id="${objId}" type="model" pid="1" pindex="${pidx}">` +
      `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`
    );
    // Geometry is fully baked into the vertices (flattenWorld → absolute,
    // origin-centred). The build item therefore carries an EXPLICIT identity
    // matrix (3MF 3×4 row-major) — no viewer/slicer can place the object
    // anywhere but exactly where its vertices say. Placement is consistent
    // across every 3MF consumer.
    items.push(`<item objectid="${objId}" transform="${THREEMF_IDENTITY}"/>`);
    objId++;
  }

  const colorXml = colors.map(c => `<m:color color="${c}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources><m:colorgroup id="1">${colorXml}</m:colorgroup>${objs.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
}

const _3MF_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

const _3MF_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

export const PrintManager = {
  exportOBJ,
  exportSTL,
  exportThreeMF,
  getExportedDimensions,
  SCALE_PRESETS,
};
