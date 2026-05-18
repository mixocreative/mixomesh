import { getState } from './StateManager.js';
import { Toast } from '../ui/Toast.js';
import { MeshValidator } from './MeshValidator.js';
import { AssetLoader } from './AssetLoader.js';
import scalePresetData from '../config/scale-presets.json' with { type: 'json' };
import printersData from '../config/printers.json' with { type: 'json' };

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Scale ────────────────────────────────────────────────

// Working/target-ratio presets, maintained in `config/scale-presets.json`
// (`ratio: null` = the free-form Custom row). Edit the JSON to add scales.
export const SCALE_PRESETS = scalePresetData;

function _exportFactor() {
  const state = getState();
  const wr = state.print.workingRatio > 0 ? state.print.workingRatio : 1;
  const tr = state.print.targetRatio > 0 ? state.print.targetRatio : 1;
  return (wr / tr) * 1000; // BU (m at workingRatio) → mm at targetRatio
}

/**
 * Ratio suffix appended to every export filename, so two exports at
 * different scales never overwrite each other on disk and the user can
 * see at a glance which scale a file is at: `1:144` → `_r1to144`,
 * `1:1` → `_r1to1`, etc. Always present — even at 1:1 — for consistency.
 */
function _ratioSuffix() {
  const s = getState().print;
  const wr = s.workingRatio > 0 ? s.workingRatio : 1;
  const tr = s.targetRatio > 0 ? s.targetRatio : 1;
  return `_r${wr}to${tr}`;
}

/** Combined-export base name: `${projectName}_r{w}to{t}` (no extension). */
function _exportBaseName(ctx) {
  return `${ctx.projectName}${_ratioSuffix()}`;
}

/** Per-mesh base name (individually mode): `${projectName}_${meshName}_r{w}to{t}`. */
function _perMeshBaseName(ctx, meshName) {
  return `${ctx.projectName}_${meshName}${_ratioSuffix()}`;
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
 * Synthesise a 4×4 RGBA PNG per solid-colour material — OBJ-only fallback so
 * slicers that key off textures (Mimaki especially) still receive an image
 * even when the artist set a plain diffuse colour with no map. Tiled sampling
 * makes a 4×4 acceptable: every texel is the same colour, so any UV — or
 * none — resolves to the same pixel. Alpha = `material.alpha × 255` lives in
 * the PNG channel; the writer-side MTL keeps `d` at the same value so legacy
 * slicers (which read MTL opacity, ignore PNG α) still get the right value.
 *
 * Dedup key is `${HEX_RRGGBBAA}` — one blob per unique (rgb, α) tuple shared
 * across every material that maps to it.
 *
 * Returns:
 *   blobByName              – Map<'solid_RRGGBBAA.png', Blob>   (zip entries)
 *   filenameByMaterialName  – Map<materialName, 'solid_RRGGBBAA.png'>
 *                             (drives the MTL post-process)
 *
 * Toggle: `state.print.objBakeSolidTextures` (default ON). Disabling skips
 * this synthesis entirely — the OBJ ships as classic vertex-coloured
 * material with no texture references.
 */
async function _synthesizeSolidShaderTextures(meshList) {
  const blobByName = new Map();
  const filenameByMaterialName = new Map();
  const seenMaterials = new Set();
  for (const { mesh } of meshList) {
    const mat = mesh.material;
    if (!mat) continue;
    if (seenMaterials.has(mat)) continue;
    seenMaterials.add(mat);
    if (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture) continue;
    const c = mat.diffuseColor || mat.albedoColor || mat.baseColor || { r: 0.8, g: 0.8, b: 0.8 };
    const r = _clamp255(c.r), g = _clamp255(c.g), b = _clamp255(c.b);
    const a = _clamp255(mat.alpha ?? 1);
    const hex = `${_hex2(r)}${_hex2(g)}${_hex2(b)}${_hex2(a)}`;
    const filename = `solid_${hex}.png`;
    const matName = mat.name || mat.id || mesh.name;
    if (matName) filenameByMaterialName.set(matName, filename);
    if (!blobByName.has(filename)) {
      try { blobByName.set(filename, await _solidColorBlob(r, g, b, a)); }
      catch (err) { console.error(`Solid PNG synthesis failed for ${hex}:`, err); }
    }
  }
  return { blobByName, filenameByMaterialName };
}

/** 4×4 RGBA PNG of one flat colour. Tiled sampling = uniform anywhere. */
async function _solidColorBlob(r, g, b, a) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 4; canvas.height = 4;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');
      const imageData = ctx.createImageData(4, 4);
      const px = imageData.data;
      for (let i = 0; i < 16; i++) {
        px[i * 4]     = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = a;
      }
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('toBlob produced no blob')); return; }
        resolve(blob);
      }, 'image/png');
    } catch (err) { reject(err); }
  });
}

/**
 * Post-process the MTL string emitted by Babylon's OBJExport: for every
 * `newmtl <name>` block whose material is in `filenameByMaterialName`, append
 * `map_Kd textures/<filename>`. Block boundaries are detected by a regex
 * split on the `newmtl` keyword so we don't depend on Babylon's internal MTL
 * shape. Untouched if the map is empty (synthesis off, or every material has
 * a real texture).
 */
function _injectMapKd(mtlString, filenameByMaterialName) {
  if (!filenameByMaterialName.size) return mtlString;
  const blocks = String(mtlString).split(/(?=^newmtl\s+)/m);
  return blocks.map(block => {
    const m = block.match(/^newmtl\s+(\S+)/);
    if (!m) return block;
    const filename = filenameByMaterialName.get(m[1]);
    if (!filename) return block;
    return block.replace(/\s*$/, '') + `\nmap_Kd textures/${filename}\n`;
  }).join('');
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

/**
 * Save bytes to disk. The default filename is `suggestedName` (caller-built:
 * `${projectName}${_ratioSuffix()}.${ext}` or per-mesh equivalent). On
 * Chrome/Edge — our only supported browsers — `showSaveFilePicker` is always
 * present, so the user sees a Save dialog with that name pre-filled and can
 * accept with one click. If the user cancels (`AbortError`) it is a silent
 * no-op, not an error. The anchor fallback exists only for environments
 * where the API is missing (e.g. headless tests) — never used in production.
 *
 * @param {Blob} blob
 * @param {string} suggestedName
 * @param {{ description?:string, mime?:string, ext?:string }=} hint
 *        ext WITHOUT the dot. Used to populate `types[].accept` so the
 *        picker filters correctly.
 */
async function _triggerDownload(blob, suggestedName, hint = {}) {
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const mime = hint.mime || blob.type || 'application/octet-stream';
      const ext = hint.ext || (suggestedName.split('.').pop() || '');
      const accept = ext ? { [mime]: [`.${ext}`] } : { [mime]: [] };
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: hint.description || `${ext.toUpperCase()} file`, accept }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // user cancelled — silent
      console.error('Save dialog failed, falling back to anchor download:', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
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
  // 3MF Materials Extension: textured meshes carry UV seams whose vertex
  // tuples MUST stay split. Welding by position alone would average UVs at
  // seams and shred the texture mapping. Solid-color meshes have no UVs to
  // protect, so weld them as usual.
  weldSolidOnly(mesh)   { if (_isSolidColor(mesh)) _weld(mesh); },
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

    // Every format funnels through `_triggerDownload`, which shows the
    // Save-As dialog with `filename` pre-filled. `kind` only varies how the
    // payload is built — zip-of-entries vs. single blob.
    let blob;
    if (out.kind === 'zip') {
      progress(0.9, 'Packaging…');
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const e of out.entries) zip.file(e.path, e.data);
      blob = await zip.generateAsync({ type: 'blob', mimeType: out.mime });
    } else {
      // kind: 'blob' — caller supplied raw bytes (STL combined).
      blob = out.data instanceof Blob
        ? out.data
        : new Blob([out.data], { type: out.mime || 'application/octet-stream' });
    }
    progress(0.98, 'Downloading…');
    const ext = (out.filename.split('.').pop() || '').toLowerCase();
    await _triggerDownload(blob, out.filename, { mime: out.mime, ext, description: `${fmt.label} file` });
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
  // OBJ-only fallback: every solid-colour material gets a tiny 4×4 RGBA PNG
  // so Mimaki UV-inkjet (texture-first) slicers receive an image even when
  // the artist set a flat diffuse colour with no map. Toggle is on by default,
  // off via the Export-tab checkbox.
  const bakeSolids = !!getState().print?.objBakeSolidTextures;
  const synth = bakeSolids
    ? await _synthesizeSolidShaderTextures(ctx.meshes)
    : { blobByName: new Map(), filenameByMaterialName: new Map() };

  const entries = [];
  if (ctx.individually) {
    for (const { mesh, name } of ctx.meshes) {
      const base = _perMeshBaseName(ctx, name);
      const mtl = BABYLON.OBJExport.MTL([mesh]);
      entries.push({ path: `${base}.obj`, data: BABYLON.OBJExport.OBJ([mesh], true, `${base}.mtl`, true) });
      entries.push({ path: `${base}.mtl`, data: _injectMapKd(mtl, synth.filenameByMaterialName) });
    }
  } else {
    const base = _exportBaseName(ctx);
    const mtl = BABYLON.OBJExport.MTL(meshes);
    entries.push({ path: `${base}.obj`, data: BABYLON.OBJExport.OBJ(meshes, true, `${base}.mtl`, true) });
    entries.push({ path: `${base}.mtl`, data: _injectMapKd(mtl, synth.filenameByMaterialName) });
  }
  for (const [filename, blob] of textureBlobs) entries.push({ path: `textures/${filename}`, data: blob });
  for (const [filename, blob] of synth.blobByName) entries.push({ path: `textures/${filename}`, data: blob });
  return { kind: 'zip', mime: 'application/zip', filename: `${_exportBaseName(ctx)}.zip`, entries };
}

function _serializeSTL(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  if (ctx.individually) {
    const entries = [];
    for (const { mesh, name } of ctx.meshes) {
      const base = _perMeshBaseName(ctx, name);
      const data = BABYLON.STLExport.CreateSTL([mesh], false, base, true, false, false, false);
      entries.push({ path: `${base}.stl`, data });
    }
    return { kind: 'zip', mime: 'application/zip', filename: `${_exportBaseName(ctx)}.zip`, entries };
  }
  // Combined STL: ask the exporter for raw bytes (download=false) and route
  // through `_triggerDownload` like every other format so the user sees the
  // same Save-As dialog with the project+ratio default name.
  const base = _exportBaseName(ctx);
  const data = BABYLON.STLExport.CreateSTL(meshes, false, base, true, false, false, false);
  return { kind: 'blob', mime: 'model/stl', filename: `${base}.stl`, data };
}

/**
 * The 3MF entry serializer is printer-profile driven. The printer's
 * `format` field in `config/printers.json` picks the sub-pipeline:
 *
 *   3mf-materials-ext → Mimaki UV-inkjet: per-vertex UVs + embedded PNG
 *                       textures via the Materials Extension. Continuous-
 *                       tone colour preserved.
 *   3mf-colorgroup    → Filament multi-colour (Bambu/Prusa/Orca): solid
 *                       diffuse colour per object via <m:colorgroup>.
 *
 * Default is Mimaki (project goal). Unknown formats fall back to colorgroup
 * — never silently change the file shape.
 */
async function _serialize3MF(ctx) {
  const profile = _getPrinterProfile();
  if (profile?.format === '3mf-materials-ext') return _serialize3MFMaterialsExt(ctx);
  return _serialize3MFColorGroup(ctx);
}

function _build3MFColorGroupEntries(meshList) {
  return [
    { path: '[Content_Types].xml', data: _3MF_CONTENT_TYPES },
    { path: '_rels/.rels',         data: _3MF_RELS },
    { path: '3D/3dmodel.model',    data: _build3MFModel(meshList) },
  ];
}

async function _build3MFMaterialsExtEntries(meshList) {
  const { blobByPath, pathByMesh } = await _collectMimakiTextures(meshList);
  const modelXml = _build3MFModelMaterialsExt(meshList, pathByMesh);
  const entries = [
    { path: '[Content_Types].xml', data: _3MF_CONTENT_TYPES_TEXTURED },
    { path: '_rels/.rels',         data: _3MF_RELS },
    { path: '3D/3dmodel.model',    data: modelXml },
  ];
  if (blobByPath.size) {
    entries.push({ path: '3D/_rels/3dmodel.model.rels', data: _buildTextureRels(blobByPath) });
    for (const [path, blob] of blobByPath) entries.push({ path, data: blob });
  }
  return entries;
}

/**
 * Per-mesh 3MF wrapper: builds N standalone `.3mf` zips and bundles them
 * inside an outer `.zip` so the user gets one file per part on disk.
 * The outer archive is a plain `application/zip` — each inner entry is a
 * complete, slicer-importable 3MF in its own right.
 */
async function _wrapIndividual3MF(ctx, entriesForMesh) {
  const { default: JSZip } = await import('jszip');
  const entries = [];
  for (const e of ctx.meshes) {
    const inner = await entriesForMesh([e]);
    const innerZip = new JSZip();
    for (const x of inner) innerZip.file(x.path, x.data);
    const data = await innerZip.generateAsync({ type: 'uint8array', mimeType: 'model/3mf' });
    entries.push({ path: `${_perMeshBaseName(ctx, e.name)}.3mf`, data });
  }
  return { kind: 'zip', mime: 'application/zip', filename: `${_exportBaseName(ctx)}.zip`, entries };
}

async function _serialize3MFColorGroup(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => _build3MFColorGroupEntries(list));
  }
  return {
    kind: 'zip', mime: 'model/3mf', filename: `${_exportBaseName(ctx)}.3mf`,
    entries: _build3MFColorGroupEntries(ctx.meshes),
  };
}

async function _serialize3MFMaterialsExt(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => _build3MFMaterialsExtEntries(list));
  }
  const entries = await _build3MFMaterialsExtEntries(ctx.meshes);
  return { kind: 'zip', mime: 'model/3mf', filename: `${_exportBaseName(ctx)}.3mf`, entries };
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
    // `weldSolidOnly` (not `weld`) so textured Mimaki meshes keep their UV
    // seams intact — solid-colour filament meshes are still welded.
    prep: ['fallbackMaterial', 'flattenWorld', 'weldSolidOnly', 'optimizeIndices',
           'csgSolidOnly', 'createNormals'],
    serialize: _serialize3MF,
  },
};

/** Public export entry points — thin wrappers over the one orchestrator. */
export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);

// ── Printer profile dispatch ─────────────────────────────

/**
 * Resolve the current target printer's profile from `config/printers.json`.
 * Falls back to the project default (mimaki-3duj-553) if the id is missing
 * or unknown — the export pipeline must never crash on a bad id.
 */
function _getPrinterProfile() {
  const id = getState().print?.targetPrinterId || 'mimaki-3duj-553';
  return printersData[id] || printersData['mimaki-3duj-553'];
}

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

// Adds the PNG default content type for the Mimaki textured pipeline.
// Plain colorgroup packages don't carry binaries, so we keep the lean
// version for filament exports and only emit this one when textures are
// in the package.
const _3MF_CONTENT_TYPES_TEXTURED = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>`;

const _3MF_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

const _3MF_TEXTURE_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture';

// ── 3MF Materials Extension (Mimaki textured) ────────────
//
// The texture writer is the exact inverse of the loader's parse path. To
// keep round-trip trivial we emit ONE <m:tex2coord> per vertex in
// vertex-order, and every triangle's `p1/p2/p3` index simply re-states its
// `v1/v2/v3` — vertex i ↔ UV i. Welding is skipped on textured meshes (see
// PREP_STEPS.weldSolidOnly) so UV seams survive into this writer.
//
// File package additions (vs. colorgroup):
//   3D/_rels/3dmodel.model.rels — one Relationship per unique texture
//   3D/Textures/<n>.png         — the texture bytes themselves
//   [Content_Types].xml         — adds Default Extension="png"

function _sanitizeTextureName(name) {
  return String(name || 'texture').replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Walk export clones, extract every unique diffuse/albedo/base texture as a
 * PNG blob, and assign each a stable package path. Returns:
 *   blobByPath  – Map<packagePath, Blob>   (zip entries)
 *   pathByMesh  – Map<mesh, packagePath>   (XML attrs)
 * Meshes without a texture (or with no UVs) are absent from pathByMesh and
 * the writer falls them through to the colorgroup path.
 */
async function _collectMimakiTextures(meshList) {
  const blobByPath = new Map();
  const pathByMesh = new Map();
  const pathByAssetId = new Map();
  const usedNames = new Set();

  for (const { mesh } of meshList) {
    const mat = mesh.material;
    if (!mat) continue;
    const tex = mat.diffuseTexture || mat.albedoTexture || mat.baseTexture;
    if (!tex) continue;
    // Need UVs to map this texture to geometry. Without them, fall through
    // to colorgroup with the material's diffuse colour.
    const uvs = mesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
    if (!uvs || uvs.length === 0) continue;

    const assetId = _getAssetIdForTexture(tex);
    let path = pathByAssetId.get(assetId);
    if (!path) {
      const base = _sanitizeTextureName(tex.name || assetId);
      let filename = `${base}.png`;
      let counter = 0;
      while (usedNames.has(filename)) { counter++; filename = `${base}_${counter}.png`; }
      usedNames.add(filename);
      path = `3D/Textures/${filename}`;
      try {
        const blob = await _textureToBlob(tex);
        blobByPath.set(path, blob);
        pathByAssetId.set(assetId, path);
      } catch (err) {
        console.error(`Texture encode failed for ${tex.name}:`, err);
        continue;
      }
    }
    pathByMesh.set(mesh, path);
  }
  return { blobByPath, pathByMesh };
}

/**
 * Build the model XML for the Materials Extension pipeline. Layout:
 *
 *   <resources>
 *     <m:texture2d id="1" path="/3D/Textures/a.png" contenttype="image/png"/>
 *     ...                                                — one per unique texture
 *     <m:texture2dgroup id="N" texid="1">                — one per textured mesh
 *       <m:tex2coord u=".." v=".."/> × verts
 *     </m:texture2dgroup>
 *     <m:colorgroup id="K">                              — only if any solid mesh
 *       <m:color color="#RRGGBBFF"/> × distinct
 *     </m:colorgroup>
 *     <object id="..." type="model" pid="K" pindex="P">  — solid path
 *     <object id="..." type="model" pid="N">             — textured path
 *       <triangle v1=".." v2=".." v3=".." p1=".." p2=".." p3=".."/>
 *   </resources>
 *
 * Geometry transforms (Y-up→Z-up, winding flip, origin-center) mirror the
 * colorgroup builder one-for-one so the loader's inverse remains shared.
 */
function _build3MFModelMaterialsExt(list, pathByMesh) {
  // Pass 1: assign resource ids, gather distinct solid colours.
  let nextId = 1;
  const tex2dIdByPath = new Map();
  for (const p of new Set([...pathByMesh.values()])) tex2dIdByPath.set(p, nextId++);

  const tex2dGroupIdByMesh = new Map();
  for (const { mesh } of list) if (pathByMesh.has(mesh)) tex2dGroupIdByMesh.set(mesh, nextId++);

  const colors = [];
  const colorIndex = new Map();
  for (const { mesh } of list) {
    if (pathByMesh.has(mesh)) continue;
    const hex = _materialHex(mesh);
    if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); }
  }
  const colorGroupId = colors.length ? nextId++ : null;

  // Pass 2: rotate vertices into 3MF space and find union bounds.
  const converted = new Map();
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

  // Resources — texture2d.
  const tex2dXml = [...tex2dIdByPath.entries()]
    .map(([path, id]) => `<m:texture2d id="${id}" path="/${path}" contenttype="image/png"/>`)
    .join('');

  // Resources — texture2dgroup (one per textured mesh, coord per vertex).
  const tex2dGroupXmls = [];
  for (const { mesh } of list) {
    const groupId = tex2dGroupIdByMesh.get(mesh);
    if (!groupId) continue;
    const texPath = pathByMesh.get(mesh);
    const texId = tex2dIdByPath.get(texPath);
    const uvs = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind) || [];
    let coords = '';
    for (let i = 0; i < uvs.length; i += 2) {
      coords += `<m:tex2coord u="${+uvs[i].toFixed(6)}" v="${+uvs[i + 1].toFixed(6)}"/>`;
    }
    tex2dGroupXmls.push(`<m:texture2dgroup id="${groupId}" texid="${texId}">${coords}</m:texture2dgroup>`);
  }

  // Resources — colorgroup (only when any solid meshes exist).
  const colorXml = colorGroupId
    ? `<m:colorgroup id="${colorGroupId}">${colors.map(c => `<m:color color="${c}"/>`).join('')}</m:colorgroup>`
    : '';

  // Objects + build items.
  const objs = [];
  const items = [];
  let objId = nextId;
  for (const { mesh } of list) {
    const pos = converted.get(mesh);
    const idx = mesh.getIndices();
    if (!pos || !idx || idx.length === 0) { objId++; continue; }

    let v = '';
    for (let i = 0; i < pos.length; i += 3) {
      v += `<vertex x="${+(pos[i] - cx).toFixed(5)}" y="${+(pos[i + 1] - cy).toFixed(5)}" z="${+(pos[i + 2] - cz).toFixed(5)}"/>`;
    }
    let t = '';
    const isTextured = tex2dGroupIdByMesh.has(mesh);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i];
      const [b, c] = THREEMF_REVERSE_WINDING ? [idx[i + 2], idx[i + 1]] : [idx[i + 1], idx[i + 2]];
      // Textured: per-triangle p1/p2/p3 mirror v1/v2/v3 because we emit one
      // tex2coord per vertex in vertex order. The loader inverts this 1:1.
      t += isTextured
        ? `<triangle v1="${a}" v2="${b}" v3="${c}" p1="${a}" p2="${b}" p3="${c}"/>`
        : `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
    }
    let pidAttrs;
    if (isTextured) {
      pidAttrs = ` pid="${tex2dGroupIdByMesh.get(mesh)}"`;
    } else if (colorGroupId != null) {
      const pidx = colorIndex.get(_materialHex(mesh)) ?? 0;
      pidAttrs = ` pid="${colorGroupId}" pindex="${pidx}"`;
    } else {
      pidAttrs = '';
    }
    objs.push(
      `<object id="${objId}" type="model"${pidAttrs}>` +
      `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`
    );
    items.push(`<item objectid="${objId}" transform="${THREEMF_IDENTITY}"/>`);
    objId++;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources>${tex2dXml}${tex2dGroupXmls.join('')}${colorXml}${objs.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
}

/** Per-part rels file. One Relationship per unique texture path. */
function _buildTextureRels(blobByPath) {
  const rels = [];
  let n = 0;
  for (const path of blobByPath.keys()) {
    rels.push(`<Relationship Id="texRel${n}" Target="/${path}" Type="${_3MF_TEXTURE_REL_TYPE}"/>`);
    n++;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

export const PrintManager = {
  exportOBJ,
  exportSTL,
  exportThreeMF,
  getExportedDimensions,
  SCALE_PRESETS,
};
