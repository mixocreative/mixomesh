/**
 * Printer profile defaults vs per-project print settings (task 1.3,
 * Decision 32, Blueprint §12).
 *
 * The profile-driven fields are ordinary per-project settings on
 * `state.print`: `exportFormat`, `splitByMaterial`, `objAxis`,
 * `threeMFFlavour` and `bedDimensions`. There is no overrides map — a field is
 * "modified from printer default" when its EFFECTIVE value differs from the
 * selected profile's default, computed at read time so a later printers.json
 * edit is reflected honestly. A stored `null` means "follow the profile"
 * (the factory state, and every project saved before 1.3).
 *
 * Pure: no state reads, no DOM. ApplyPrinterProfileCommand, ExportContext
 * (`ctx.prefs`) and the Print panel all resolve through here so they cannot
 * drift.
 */

import { getPrinterProfile, PRINTER_OBJ_AXES, PRINTER_3MF_FLAVOURS } from './PrinterProfiles.js';
import { EXPORT_FORMATS } from './PrintReadiness.js';

/** The fields a printer profile sets (one undo step) and Printer default ↺ reverts. */
export const PROFILE_FIELDS = Object.freeze(['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour', 'bedDimensions']);

/** Writer keys the Export tab offers — every writer, always (AGENTS rule 6). */
export const FORMAT_KEYS = EXPORT_FORMATS;

/**
 * printers.json format id → writer key. `3mf-*` flavours share the one 3MF
 * writer (the flavour is its own setting); `obj-mtl` is the OBJ writer.
 * @param {string|null|undefined} printerFormat
 * @returns {'obj'|'3mf'|'stl'|'ply'|'wrl'|null}
 */
export function formatKeyOf(printerFormat) {
  if (!printerFormat) return null;
  if (printerFormat === 'obj-mtl' || printerFormat === 'obj') return 'obj';
  if (printerFormat.startsWith('3mf')) return '3mf';
  return FORMAT_KEYS.includes(printerFormat) ? /** @type {any} */ (printerFormat) : null;
}

/** True when every bed axis is a positive number (Custom rows carry nulls). */
export function isFiniteBed(bed) {
  return !!bed && ['x', 'y', 'z'].every(a => Number.isFinite(bed[a]) && bed[a] > 0);
}

/**
 * The profile's suggested value for every profile-driven field.
 * `splitByMaterial` mirrors the 3MF writer's own fallback (PrintPipeline:
 * on for `per-part` / `paint` colour modes). `bedDimensions` is null for a
 * profile without a finite bed (Custom) — the caller keeps the current bed.
 * @param {import('./PrinterProfiles.js').PrinterProfile} profile
 */
export function profileDefaults(profile) {
  const exp = profile?.export ?? {};
  const mode = profile?.colour?.mode;
  return {
    exportFormat: formatKeyOf(exp.recommended) ?? 'stl',
    splitByMaterial: !!exp.splitByMaterial || mode === 'per-part' || mode === 'paint',
    objAxis: PRINTER_OBJ_AXES.includes(exp.obj?.axis) ? exp.obj.axis : 'y-up',
    threeMFFlavour: PRINTER_3MF_FLAVOURS.includes(exp.threeMF?.flavour) ? exp.threeMF.flavour : 'core',
    bedDimensions: isFiniteBed(profile?.bed) ? { x: profile.bed.x, y: profile.bed.y, z: profile.bed.z } : null,
  };
}

/**
 * Effective value of every profile-driven field: the stored value when set
 * (and valid), else the profile default.
 * @param {Object} print   `state.print`
 * @param {import('./PrinterProfiles.js').PrinterProfile} [profile]
 */
export function effectivePrintSettings(print = {}, profile = getPrinterProfile(print?.targetPrinterId ?? null)) {
  const d = profileDefaults(profile);
  const p = print ?? {};
  return {
    exportFormat: FORMAT_KEYS.includes(p.exportFormat) ? p.exportFormat : d.exportFormat,
    splitByMaterial: typeof p.splitByMaterial === 'boolean' ? p.splitByMaterial : d.splitByMaterial,
    objAxis: PRINTER_OBJ_AXES.includes(p.objAxis) ? p.objAxis : d.objAxis,
    threeMFFlavour: PRINTER_3MF_FLAVOURS.includes(p.threeMFFlavour) ? p.threeMFFlavour : d.threeMFFlavour,
    bedDimensions: p.bedDimensions ?? d.bedDimensions,
  };
}

function _sameBed(a, b) {
  return ['x', 'y', 'z'].every(k => Number(a?.[k]) === Number(b?.[k]));
}

/**
 * Profile-driven fields whose effective value differs from the profile
 * default → `{ field: profileDefaultValue }` (the value goes in the
 * "modified" dot's tooltip). The bed only counts when the profile has a
 * finite bed (a Custom bed is always the user's own).
 * @returns {Record<string, any>}
 */
export function modifiedFields(print = {}, profile = getPrinterProfile(print?.targetPrinterId ?? null)) {
  const d = profileDefaults(profile);
  const eff = effectivePrintSettings(print, profile);
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of ['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour']) {
    if (eff[f] !== d[f]) out[f] = d[f];
  }
  if (d.bedDimensions && !_sameBed(eff.bedDimensions, d.bedDimensions)) out.bedDimensions = d.bedDimensions;
  return out;
}
