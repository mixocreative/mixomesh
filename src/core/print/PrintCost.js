/**
 * PrintCost — per-object volume + a material-cost quote for the Export tab.
 *
 * NO Boolean union: volumes are summed per logical unit (never subtracted),
 * and spatial overlap between units is only FLAGGED (AABB, print-space mm,
 * 0.01 mm epsilon) so the estimate is marked `approximate` rather than
 * silently wrong (touching boxes are NOT an overlap — see _aabbOverlap).
 * Not-watertight parts (a `holes` or `nonManifold` result in the validation
 * cache) mark the quote approximate, and so do parts NOBODY HAS VALIDATED
 * (no cache entry, or a stale one — an unchecked shell's signed volume is
 * arbitrary; CIA F5). `total` is `null` (never 0) whenever density or price
 * is unknown — a missing price must never read as "free".
 *
 * Every consumer (unitVolumesMM3, overlappingPairs, quote) takes an
 * ExportContext (see ExportContext.js) built by the caller — this module
 * never builds one itself, so it stays a pure function of ctx + settings.
 */

import { withRestTransform } from '../scene/ImportBounce.js';
import { positionsToPrintSpace, printIndices, signedVolume, toPrintSpace } from './PrintSpace.js';
import { REPAIR_TRIANGLE_CAP } from '../repair/MeshRepair.js';
import { caps } from '../storage/capabilities.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const AABB_EPSILON_MM = 0.01;

/**
 * Triangle ceiling for a LIVE cost estimate (M9). This is a UI-responsiveness
 * limit, not a repair limit: the quote recomputes on every keystroke in the
 * Cost block, so it tracks the HUD triangle budget (`caps.triangleBudget`)
 * rather than borrowing REPAIR_TRIANGLE_CAP, which exists for a completely
 * different reason (how much geometry the WASM repair engine can chew on the
 * main thread). Read at call time — capabilities are detected at boot, after
 * this module is imported.
 */
export function costTriangleCap() {
  return caps.triangleBudget > 0 ? caps.triangleBudget : REPAIR_TRIANGLE_CAP;
}

/**
 * Cheap triangle count across every unit/part — `getIndices().length` reads
 * only, never `getVerticesData` or any per-vertex work. `quote()` calls this
 * FIRST and bails out before `unitVolumesMM3`/`overlappingPairs` ever run
 * when the scene is above `costTriangleCap()`, so a huge scene never pays
 * for the full per-vertex pass just to discover it should show "—".
 *
 * @param {import('./ExportContext.js').ExportContext} ctx
 * @returns {number}
 */
export function totalTriangles(ctx) {
  let tris = 0;
  for (const unit of ctx.units ?? []) {
    for (const part of unit.parts ?? []) {
      const idx = part.mesh?.getIndices?.();
      if (idx?.length) tris += idx.length / 3;
    }
  }
  return tris;
}

/**
 * World-space (BU) position buffer → a NEW Float32Array, one vertex per
 * TransformCoordinates call. Identity when the mesh carries no matrix (a
 * duck-typed test double, or a not-yet-attached node) — the raw local
 * positions are used as-is rather than throwing, since volume is a
 * best-effort estimate, not an export-blocking computation.
 */
function _toWorld(positions, matrix) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v = matrix
      ? BABYLON.Vector3.TransformCoordinates(
          new BABYLON.Vector3(positions[i], positions[i + 1], positions[i + 2]), matrix)
      : { x: positions[i], y: positions[i + 1], z: positions[i + 2] };
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}

/** True when any part of `unit` carries an open (holes/nonManifold) result in the validation cache. */
function _hasOpenResult(state, unit) {
  const cache = state?.scene?.validation ?? {};
  for (const part of unit.parts ?? []) {
    const entry = cache[part.meshId];
    if (entry?.results?.some(r => r.type === 'holes' || r.type === 'nonManifold')) return true;
  }
  return false;
}

/**
 * True when every part of `unit` has a FRESH validation-cache entry.
 *
 * CIA F5 / I11: "no cache entry" is not "watertight" — it is "nobody has
 * checked". Treating it as watertight made the quote read as an exact number
 * for geometry whose volume may be meaningless (an open shell's signed volume
 * is arbitrary). Same semantics as PrintReadiness' `validation-pending`: a
 * missing OR stale entry counts as not validated.
 */
function _isValidated(state, unit) {
  const cache = state?.scene?.validation ?? {};
  const parts = unit.parts ?? [];
  if (!parts.length) return false;
  return parts.every(part => {
    const entry = cache[part.meshId];
    return !!entry && !entry.stale;
  });
}

/**
 * Per-unit volume in print-space mm³. Each part's LOCAL positions are
 * transformed by its own world matrix (BU), then pivot-anchored ratio-scaled
 * and converted to mm with `ctx.unitFactor` (mirrors PrintPrep.flattenWorld's
 * exact bake math), then mapped into print space. A unit's parts are summed
 * BEFORE taking the absolute value — consistently-wound parts of one logical
 * object accumulate correctly; the abs() only guards the unit total.
 *
 * @param {import('./ExportContext.js').ExportContext} ctx
 * @returns {Map<string, {volumeMM3:number, triangles:number, watertight:boolean, validated:boolean}>}
 */
export function unitVolumesMM3(ctx) {
  // World matrices at REST — the import pop must not scale the quote.
  return withRestTransform(() => _unitVolumesMM3Now(ctx));
}

function _unitVolumesMM3Now(ctx) {
  const out = new Map();
  for (const unit of ctx.units ?? []) {
    let vol = 0;
    let tris = 0;
    for (const part of unit.parts ?? []) {
      const mesh = part.mesh;
      if (!mesh?.getVerticesData) continue;
      mesh.computeWorldMatrix?.(true);
      const local = mesh.getVerticesData('position');
      if (!local?.length) continue;
      const idx = printIndices(mesh);
      const world = _toWorld(local, mesh.getWorldMatrix?.());
      const mm = new Float32Array(world.length);
      for (let i = 0; i < world.length; i += 3) {
        mm[i]     = ((world[i]     - ctx.pivot.x) * ctx.ratioFactor + ctx.pivot.x) * ctx.unitFactor;
        mm[i + 1] = ((world[i + 1] - ctx.pivot.y) * ctx.ratioFactor + ctx.pivot.y) * ctx.unitFactor;
        mm[i + 2] = ((world[i + 2] - ctx.pivot.z) * ctx.ratioFactor + ctx.pivot.z) * ctx.unitFactor;
      }
      vol += signedVolume(positionsToPrintSpace(mm), idx);
      tris += idx.length / 3;
    }
    const watertight = !_hasOpenResult(ctx.state, unit);
    const validated = _isValidated(ctx.state, unit);
    out.set(unit.logicalId, { volumeMM3: Math.abs(vol), triangles: tris, watertight, validated });
  }
  return out;
}

/** Union world AABB (print-space mm) of one unit's parts, or null when it has none. */
function _unitBoundsMM(ctx, unit) {
  const { pivot: p, ratioFactor: r, unitFactor: u } = ctx;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const scale = (v, pivot) => ((v - pivot) * r + pivot) * u;
  let found = false;
  for (const part of unit.parts ?? []) {
    const mesh = part.mesh;
    mesh?.computeWorldMatrix?.(true);
    const box = mesh?.getBoundingInfo?.()?.boundingBox;
    if (!box?.minimumWorld || !box?.maximumWorld) continue;
    const lo = box.minimumWorld;
    const hi = box.maximumWorld;
    const a = toPrintSpace(scale(lo.x, p.x), scale(lo.y, p.y), scale(lo.z, p.z));
    const b = toPrintSpace(scale(hi.x, p.x), scale(hi.y, p.y), scale(hi.z, p.z));
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], a[axis], b[axis]);
      max[axis] = Math.max(max[axis], a[axis], b[axis]);
    }
    found = true;
  }
  return found ? { min, max } : null;
}

/**
 * AABB intersection with a tolerance that EXCLUDES merely touching boxes.
 *
 * M6: the epsilon's sign was inverted (`a.max + eps < b.min`), which made two
 * parts placed flush against each other — the normal case for a kitbash or a
 * bed layout — count as an overlapping pair and marked every such quote
 * approximate for no reason. Boxes must interpenetrate by more than `eps` to
 * count: `a.max - eps < b.min` ⇒ separated.
 */
function _aabbOverlap(a, b, eps) {
  for (let axis = 0; axis < 3; axis++) {
    if (a.max[axis] - eps < b.min[axis]) return false;
    if (b.max[axis] - eps < a.min[axis]) return false;
  }
  return true;
}

/**
 * Pairs of logical units whose print-space AABBs intersect (0.01 mm
 * epsilon). NEVER used to subtract volume — only to flag the quote
 * `approximate` with an `overlap:N` reason.
 *
 * @param {import('./ExportContext.js').ExportContext} ctx
 * @returns {Array<[string, string]>} logicalId pairs
 */
export function overlappingPairs(ctx) {
  return withRestTransform(() => _overlappingPairsNow(ctx));
}

function _overlappingPairsNow(ctx) {
  const boxes = (ctx.units ?? [])
    .map(unit => ({ id: unit.logicalId, box: _unitBoundsMM(ctx, unit) }))
    .filter(entry => entry.box);
  const pairs = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (_aabbOverlap(boxes[i].box, boxes[j].box, AABB_EPSILON_MM)) {
        pairs.push([boxes[i].id, boxes[j].id]);
      }
    }
  }
  return pairs;
}

/**
 * Material-cost quote for the whole export set. `s` (settings) values of 0
 * mean "use the material default" — see config/default-settings.json `cost`.
 * `total` is `null` (never 0) when density or price cannot be resolved.
 *
 * `geometry` (optional, I10) lets a caller that already computed
 * `unitVolumesMM3`/`overlappingPairs` for this exact ctx hand them back in
 * instead of paying for the whole per-vertex pass again — the Cost block's
 * live `input` preview recomputes only the money that way.
 *
 * @param {import('./ExportContext.js').ExportContext} ctx
 * @param {{pricePerGram?:number, supportPricePerGram?:number, supportPercent?:number, currency?:string}} s
 * @param {{densityGcm3?:number, pricePerGram?:number, supportDensityGcm3?:number, supportPricePerGram?:number, defaultSupportPercent?:number}|null} material
 * @param {{vols?:Map, pairs?:Array}|null} [geometry] pre-computed geometry for this ctx
 */
export function quote(ctx, s, material, geometry = null) {
  const currency = s?.currency || 'USD';
  // Triangle-count gate FIRST — cheap array-length reads only. Above the cap,
  // bail out before unitVolumesMM3/overlappingPairs ever touch a vertex
  // buffer (a huge scene must never pay for the full per-vertex pass just to
  // show "—").
  if (totalTriangles(ctx) > costTriangleCap()) {
    return {
      volumeCM3: null, grams: null, materialCost: null, supportGrams: null,
      supportCost: null, total: null, currency, approximate: true, overlaps: 0,
      reasons: ['tooBig'],
    };
  }

  const vols = geometry?.vols ?? unitVolumesMM3(ctx);
  const pairs = geometry?.pairs ?? overlappingPairs(ctx);
  const volumeCM3 = [...vols.values()].reduce((a, v) => a + v.volumeMM3, 0) / 1000;

  const density = material?.densityGcm3 || null;
  const price = s?.pricePerGram || material?.pricePerGram || 0;
  const sDensity = material?.supportDensityGcm3 ?? density;
  const sPrice = s?.supportPricePerGram || material?.supportPricePerGram || price;
  const pct = s?.supportPercent || material?.defaultSupportPercent || 0;

  const grams = density ? volumeCM3 * density : null;
  const supportGrams = grams != null && sDensity ? volumeCM3 * (pct / 100) * sDensity : null;

  const reasons = [];
  const open = [...vols.values()].filter(v => !v.watertight).length;
  // A part nobody has validated (or whose result went stale after an edit) is
  // NOT evidence of watertightness — say so rather than quoting a number as
  // if it were exact (CIA F5 / I11).
  const unchecked = [...vols.values()].filter(v => !v.validated).length;
  if (open) reasons.push(`notWatertight:${open}`);
  if (unchecked) reasons.push(`notValidated:${unchecked}`);
  if (pairs.length) reasons.push(`overlap:${pairs.length}`);
  if (!density) reasons.push('noDensity');
  if (!price) reasons.push('noPrice');

  const materialCost = grams != null && price ? grams * price : null;
  const supportCost = supportGrams != null && sPrice ? supportGrams * sPrice : null;
  const total = materialCost != null && supportCost != null ? materialCost + supportCost : null;

  return {
    volumeCM3,
    grams,
    materialCost,
    supportGrams,
    supportCost,
    total,
    currency,
    approximate: reasons.length > 0,
    overlaps: pairs.length,
    reasons,
  };
}
