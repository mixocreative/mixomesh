import { getState } from './StateManager.js';
import { Toast } from '../ui/Toast.js';
import { t } from '../i18n/index.js';
import { MeshValidator } from './MeshValidator.js';
import { AssetLoader } from './AssetLoader.js';
import {
  SCALE_PRESETS,
  exportFactorFor as _exportFactorFor,
  exportBaseName as _exportBaseName,
  perMeshBaseName as _perMeshBaseName,
  setExportTargetOverride,
} from './print/PrintScale.js';
import { createPrepSteps } from './print/PrintPrep.js';
import { createFormats } from './print/PrintFormats.js';
import { packageAndDownload } from './print/PrintPackaging.js';
import { collectTextureExportData, clamp255 as _clamp255, hex2 as _hex2 } from './print/ExportTextures.js';
import { buildColorGroupEntries, buildMaterialsExtEntries } from './print/ThreeMFWriter.js';
import { logicalObjectLeadIds, logicalObjectPartIds } from './LogicalObjects.js';
import { objectRatio, exportRatiosFromState } from './scale/ScaleMath.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const BU_TO_MM = 1000;

export { SCALE_PRESETS, getExportedDimensions, getExportReference };

// ── Mesh Collection ──────────────────────────────────────

/**
 * Collect all printable meshes (isPrintPart:true, not empty).
 * If selectedOnly, filter to selected meshes only.
 */
function _collectPrintMeshes(selectedOnly) {
  const state = getState();
  const objects = state.scene.objects;
  const selected = new Set(state.selection.selectedIds);
  const result = [];

  for (const leadId of logicalObjectLeadIds(objects)) {
    const leadObj = objects[leadId];
    if (!leadObj || leadObj.isGhost || !leadObj.isPrintPart) continue;
    if (selectedOnly && !selected.has(leadId)) continue;

    const parts = [];
    for (const meshId of logicalObjectPartIds(leadId, objects)) {
      const obj = objects[meshId];
      if (!obj || obj.isGhost || !obj.isPrintPart) continue;
      const mesh = AssetLoader.getBabylonMesh(meshId);
      if (!mesh) continue;
      if (!mesh.getTotalVertices?.() || mesh.getTotalVertices() === 0) continue;
      parts.push({ meshId, mesh, obj });
    }

    if (parts.length) result.push({ logicalId: leadId, name: leadObj.name, obj: leadObj, parts });
  }

  return result;
}

function _flattenPrintUnits(units) {
  return units.flatMap(unit => unit.parts.map(part => ({ ...part, logicalId: unit.logicalId, logicalName: unit.name })));
}

function _groupCloneEntries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = entry.logicalId ?? entry.meshId;
    if (!byId.has(id)) {
      byId.set(id, { logicalId: id, name: entry.logicalName ?? entry.name, meshes: [] });
    }
    byId.get(id).meshes.push(entry);
  }
  return [...byId.values()];
}

function _exportReferenceUnit(units, state) {
  const activeId = state.selection?.activeId ?? null;
  const activeUnit = activeId ? units.find(unit => unit.logicalId === activeId) : null;
  return activeUnit ?? units[0] ?? null;
}

function _exportReferenceRatio(units, state) {
  return objectRatio(_exportReferenceUnit(units, state)?.obj ?? null);
}

function _meshWorldOrigin(mesh) {
  if (!mesh) return null;
  mesh.computeWorldMatrix?.(true);
  const world = mesh.getWorldMatrix?.();
  const t = world?.getTranslation?.();
  if (t?.clone) return t.clone();
  if (t && Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) {
    return new BABYLON.Vector3(t.x, t.y, t.z);
  }
  const abs = mesh.absolutePosition;
  if (abs?.clone) return abs.clone();
  if (abs && Number.isFinite(abs.x) && Number.isFinite(abs.y) && Number.isFinite(abs.z)) {
    return new BABYLON.Vector3(abs.x, abs.y, abs.z);
  }
  const pos = mesh.position;
  if (pos?.clone) return pos.clone();
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
    return new BABYLON.Vector3(pos.x, pos.y, pos.z);
  }
  return BABYLON.Vector3.Zero();
}

function _exportReferencePivot(unit) {
  const leadPart = unit?.parts?.find(part => part.meshId === unit.logicalId) ?? unit?.parts?.[0] ?? null;
  return _meshWorldOrigin(leadPart?.mesh) ?? BABYLON.Vector3.Zero();
}

function _exportTargetRatioForReference(state, referenceRatio) {
  const explicit = exportRatiosFromState(state);
  return explicit.length ? explicit[0] : referenceRatio;
}

function _exportFactorForReference(state, referenceRatio) {
  const targetRatio = _exportTargetRatioForReference(state, referenceRatio);
  return (referenceRatio / targetRatio) * BU_TO_MM;
}

function getExportReference(options = {}) {
  const state = getState();
  const unit = _exportReferenceUnit(_collectPrintMeshes(!!options.selectedOnly), state);
  return {
    logicalId: unit?.logicalId ?? null,
    ratio: objectRatio(unit?.obj ?? null),
  };
}

function getExportedDimensions(meshId, options = {}) {
  const state = getState();
  const obj = state.scene.objects[meshId];
  if (!obj) return null;
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return null;

  const bb = mesh.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const factor = _exportFactorForReference(state, getExportReference(options).ratio);

  return {
    x: size.x * factor,
    y: size.y * factor,
    z: size.z * factor,
  };
}

// ── Texture Export ───────────────────────────────────────
// Texture collection lives in print/ExportTextures.js (shared with the 3MF
// Materials Extension writer). OBJ solid-colour synthesis stays here — it is
// an OBJ-specific fallback.

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
 * Toggle: `state.print.objBakeSolidTextures` (default OFF). Disabling skips
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
    const a = _clamp255(_safeAlpha01(mat.alpha));
    const hex = `${_hex2(r)}${_hex2(g)}${_hex2(b)}${_hex2(a)}`;
    const filename = `solid_${hex}.png`;
    const matName = _objMaterialName(mesh);
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

// Alpha as a finite 0..1, treating null/undefined/NaN alike as fully opaque.
// Used by BOTH the solid-PNG synthesis and the MTL `d`/`Tr` lines so a
// non-finite material alpha can never make the PNG α byte and the MTL value
// disagree (audit LOW #10 — a NaN alpha used to emit a literal "NaN").
function _safeAlpha01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function _objMaterialName(mesh) {
  const mat = mesh?.material;
  return String(mat?.id || mat?.name || mesh?.name || 'material');
}

function _mtlColor(mat) {
  return mat?.diffuseColor || mat?.albedoColor || mat?.baseColor || { r: 0.8, g: 0.8, b: 0.8 };
}

function _mtlLineColor(prefix, color) {
  const r = Number(color?.r ?? 0).toFixed(4);
  const g = Number(color?.g ?? 0).toFixed(4);
  const b = Number(color?.b ?? 0).toFixed(4);
  return `${prefix} ${r} ${g} ${b}`;
}

function _buildOBJMtl(meshEntries, filenameByMaterialName) {
  const blocks = [];
  const seen = new Set();
  for (const { mesh } of meshEntries) {
    const mat = mesh.material || {};
    const matName = _objMaterialName(mesh);
    if (seen.has(matName)) continue;
    seen.add(matName);
    const color = _mtlColor(mat);
    const alpha = _safeAlpha01(mat.alpha);
    const lines = [
      `newmtl ${matName}`,
      `Ns ${Number(mat.specularPower ?? 64).toFixed(4)}`,
      'Ni 1.5000',
      `d ${alpha.toFixed(4)}`,
      `Tr ${(1 - alpha).toFixed(4)}`,
      'illum 2',
      _mtlLineColor('Ka', mat.ambientColor || { r: 0, g: 0, b: 0 }),
      _mtlLineColor('Kd', color),
      _mtlLineColor('Ks', mat.specularColor || { r: 0, g: 0, b: 0 }),
      _mtlLineColor('Ke', mat.emissiveColor || { r: 0, g: 0, b: 0 }),
    ];
    const map = filenameByMaterialName.get(matName);
    if (map) lines.push(`map_Kd textures/${map}`);
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

function _rewriteObjMtllib(objString, base) {
  const desired = `mtllib ${base}.mtl`;
  const text = String(objString);
  if (/^mtllib\s+.+$/m.test(text)) return text.replace(/^mtllib\s+.+$/m, desired);
  return `${desired}\n${text}`;
}

function _hasTextured3MFContent(meshList) {
  return meshList.some(({ mesh }) => {
    const mat = mesh.material;
    const tex = mat?.diffuseTexture || mat?.albedoTexture || mat?.baseTexture;
    if (!tex) return false;
    const uvs = mesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
    return !!uvs && uvs.length > 0;
  });
}

// ── Export ───────────────────────────────────────────────

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

const PREP_STEPS = createPrepSteps({
  BABYLON,
  weld: _weld,
  isSolidColor: _isSolidColor,
  tryCsg: _tryCsg,
});

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

  // Per-object ratio redesign: export the scene ONCE PER target ratio in
  // `print.exportRatios`, producing a scaled file each. An EMPTY list = "as
  // shown": target = the export REFERENCE ratio (active print unit, else first
  // unit) so the factor is exactly 1000 — using the reference (not the raw
  // selection-active ratio) keeps "as shown" correct even when the active
  // object is excluded from the export set.
  const state0 = getState();
  const explicit = exportRatiosFromState(state0);
  const targets = explicit.length
    ? explicit
    : [_exportReferenceRatio(_collectPrintMeshes(!!options.selectedOnly), state0)];
  for (let ti = 0; ti < targets.length; ti++) {
    setExportTargetOverride(targets[ti]);
    try {
      const span = (frac, msg) => progress((ti + Math.max(0, Math.min(1, frac))) / targets.length,
        targets.length > 1 ? `[${ti + 1}/${targets.length}] ${msg}` : msg);
      await _runExportForTarget(fmt, options, span);
    } finally {
      setExportTargetOverride(null);
    }
  }
}

async function _runExportForTarget(fmt, options, progress) {
  progress(0.02, 'Collecting meshes…');
  const printUnits = _collectPrintMeshes(!!options.selectedOnly);
  const printMeshes = _flattenPrintUnits(printUnits);
  if (printMeshes.length === 0) throw new Error('No printable meshes to export.');

  const state  = getState();
  const referenceUnit = _exportReferenceUnit(printUnits, state);
  const referenceRatio = objectRatio(referenceUnit?.obj ?? null);
  const ctx = {
    state, referenceUnit, referenceRatio, options,
    projectName: state.project.name || 'Untitled',
    individually: !!options.individually,
    pivot: _exportReferencePivot(referenceUnit),
    meshes: [],
    units: [],
    csgReady: false,
    csgSkipped: [],
  };
  ctx.factor = _exportFactorFor(ctx);
  ctx.ratioFactor = ctx.factor / BU_TO_MM;
  ctx.unitFactor = BU_TO_MM;

  if (fmt.needsCSG) {
    ctx.csgReady = await _ensureCSG2();
    if (!ctx.csgReady) Toast.show(t('toast.csgUnavailable'), 'warning', 4000);
  }

  const clones = [];
  const dispose = () => { for (const e of clones) { try { e.mesh.dispose?.(); } catch { /* */ } } };

  try {
    const N = printMeshes.length;
    for (let i = 0; i < N; i++) {
      const { meshId, mesh, logicalId, logicalName } = printMeshes[i];
      // Keep the parent so the clone's world matrix includes group/ancestor
      // transforms; `flattenWorld` then bakes that full world (+ mm scale)
      // into the vertices.
      const clone = mesh.clone?.(`${mesh.name}__export`, mesh.parent ?? null, true);
      if (!clone || clone === mesh) {
        // Never fall back to the live mesh: prep steps bake mm-scale into
        // vertices and the finally-block disposes clones (review M10).
        throw new Error(`Could not clone "${mesh.name}" for export.`);
      }
      // CRITICAL: Babylon's clone shares the source geometry by reference.
      // Every prep step rewrites vertex data in place — without a unique
      // geometry copy here they would corrupt the live scene mesh. This makes
      // the whole export pipeline non-destructive for ALL formats.
      clone.makeGeometryUnique?.();
      for (const stepKey of fmt.prep) {
        const step = PREP_STEPS[stepKey];
        if (!step) continue;
        try { step(clone, ctx); }
        catch (e) { console.error(`Prep "${stepKey}" failed for ${clone.name}:`, e); }
      }
      clones.push({ meshId, logicalId, mesh: clone, name: mesh.name || `mesh_${meshId}`, logicalName: logicalName || mesh.name || `mesh_${meshId}` });
      progress(0.05 + 0.45 * ((i + 1) / N), `Preparing ${i + 1}/${N}…`);
    }
    ctx.meshes = clones;
    ctx.units = _groupCloneEntries(clones);

    const remaining = await _validateExportMeshes(
      clones, (d, t) => progress(0.5 + 0.3 * (d / t), `Validating ${d}/${t}…`));
    if (remaining.length) throw _exportError('Validation errors remain after auto-fix.', remaining);

    progress(0.82, `Writing ${fmt.label}…`);
    const out = await fmt.serialize(ctx);

    await packageAndDownload(out, fmt.label, progress);
    progress(1, 'Done');
    Toast.show(t('toast.exportedOk', { filename: out.filename ?? fmt.label }), 'success', 3000);
    if (ctx.csgSkipped.length) {
      const n = ctx.csgSkipped.length;
      Toast.show(t('toast.partsNotWatertight', { n }), 'info', 5000);
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
  const {
    blobByFilename: textureBlobs,
    textureFilenameByMaterialName,
  } = await collectTextureExportData(meshes);
  // OBJ-only fallback: every solid-colour material gets a tiny 4×4 RGBA PNG
  // so Mimaki UV-inkjet (texture-first) slicers receive an image even when
  // the artist set a flat diffuse colour with no map. Toggle is off by default;
  // enabling it in the Export tab opts into synthesis.
  const bakeSolids = !!getState().print?.objBakeSolidTextures;
  const synth = bakeSolids
    ? await _synthesizeSolidShaderTextures(ctx.meshes)
    : { blobByName: new Map(), filenameByMaterialName: new Map() };
  const filenameByMaterialName = new Map([
    ...textureFilenameByMaterialName,
    ...synth.filenameByMaterialName,
  ]);

  const entries = [];
  if (ctx.individually) {
    for (const unit of ctx.units) {
      const meshesForUnit = unit.meshes.map(e => e.mesh);
      const base = _perMeshBaseName(ctx, unit.name);
      const objData = BABYLON.OBJExport.OBJ(meshesForUnit, true, base, true);
      entries.push({ path: `${base}.obj`, data: _rewriteObjMtllib(objData, base) });
      entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(unit.meshes, filenameByMaterialName) });
    }
  } else {
    const base = _exportBaseName(ctx);
    const objData = BABYLON.OBJExport.OBJ(meshes, true, base, true);
    entries.push({ path: `${base}.obj`, data: _rewriteObjMtllib(objData, base) });
    entries.push({ path: `${base}.mtl`, data: _buildOBJMtl(ctx.meshes, filenameByMaterialName) });
  }
  for (const [filename, blob] of textureBlobs) entries.push({ path: `textures/${filename}`, data: blob });
  for (const [filename, blob] of synth.blobByName) entries.push({ path: `textures/${filename}`, data: blob });
  return { kind: 'zip', mime: 'application/zip', filename: `${_exportBaseName(ctx)}.zip`, entries };
}

function _serializeSTL(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  if (ctx.individually) {
    const entries = [];
    for (const unit of ctx.units) {
      const base = _perMeshBaseName(ctx, unit.name);
      const data = BABYLON.STLExport.CreateSTL(unit.meshes.map(e => e.mesh), false, base, true, false, false, false);
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
 * The 3MF entry serializer is content-driven. The Export panel chooses 3MF;
 * texture presence chooses the sub-pipeline:
 *
 *   3mf-materials-ext → Mimaki UV-inkjet: per-vertex UVs + embedded PNG
 *                       textures via the Materials Extension. Continuous-
 *                       tone colour preserved.
 *   3mf-colorgroup    → Filament multi-colour (Bambu/Prusa/Orca): solid
 *                       diffuse colour per object via <m:colorgroup>.
 *
 * Solid-only scenes emit lean colorgroup packages. Printer profile selection
 * is only a build-area/reference choice and must not switch 3MF flavour.
 */
async function _serialize3MF(ctx) {
  if (_hasTextured3MFContent(ctx.meshes)) return _serialize3MFMaterialsExt(ctx);
  return _serialize3MFColorGroup(ctx);
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
  for (const unit of ctx.units) {
    const inner = await entriesForMesh([unit]);
    const innerZip = new JSZip();
    for (const x of inner) innerZip.file(x.path, x.data);
    const data = await innerZip.generateAsync({ type: 'uint8array', mimeType: 'model/3mf' });
    entries.push({ path: `${_perMeshBaseName(ctx, unit.name)}.3mf`, data });
  }
  return { kind: 'zip', mime: 'application/zip', filename: `${_exportBaseName(ctx)}.zip`, entries };
}

async function _serialize3MFColorGroup(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => buildColorGroupEntries(list));
  }
  return {
    kind: 'zip', mime: 'model/3mf', filename: `${_exportBaseName(ctx)}.3mf`,
    entries: buildColorGroupEntries(ctx.units),
  };
}

async function _serialize3MFMaterialsExt(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => buildMaterialsExtEntries(list));
  }
  const entries = await buildMaterialsExtEntries(ctx.units);
  return { kind: 'zip', mime: 'model/3mf', filename: `${_exportBaseName(ctx)}.3mf`, entries };
}

const FORMATS = createFormats({
  serializeOBJ: _serializeOBJ,
  serializeSTL: _serializeSTL,
  serialize3MF: _serialize3MF,
});

/** Public export entry points — thin wrappers over the one orchestrator. */
export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);

// 3MF package writers live in print/ThreeMFWriter.js (split, review L29).

export const PrintManager = {
  exportOBJ,
  exportSTL,
  exportThreeMF,
  getExportedDimensions,
  getExportReference,
  SCALE_PRESETS,
};
