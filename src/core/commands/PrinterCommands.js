// Print-settings commands (task 1.3, Decision 32, Blueprint §12).
//
// ApplyPrinterProfileCommand — selecting a printer (and Printer default ↺)
// sets `targetPrinterId` + every profile-driven field to that profile's
// suggested defaults in ONE undo step. SetPrintSettingsCommand — a user edit
// of a per-project print setting (format, split-by-material, OBJ axis, 3MF
// flavour, bed, …); each edit is its own history entry, so Ctrl+Z after
// Printer default restores the overrides. SetReferenceObjectCommand — the
// explicit export reference (`print.referenceObjectId`, Decision 25).

import { setState, getState, markDirty } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { MeshValidator } from '../MeshValidator.js';
import { getPrinterProfile, printerProfileExists } from '../print/PrinterProfiles.js';
import { profileDefaults, isFiniteBed } from '../print/PrintProfileSettings.js';
import { SILENT } from './support.js';

/** The print-settings keys these commands may write (per-project, Decision 15). */
export const PRINT_SETTING_KEYS = Object.freeze([
  'targetPrinterId', 'bedDimensions', 'exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour',
  'objBakeSolidTextures', 'individually', 'referenceObjectId',
]);

function _clonePatchValue(v) {
  return v && typeof v === 'object' ? { ...v } : v;
}

function _pick(print, keys) {
  const out = {};
  for (const k of keys) out[k] = _clonePatchValue(print?.[k] ?? null);
  return out;
}

/**
 * Write a print patch and run the side effects a bed change needs (floor
 * rebuild, bed-fit cache, live bed preview). Shared by execute and undo.
 */
function _applyPrintPatch(patch) {
  const prevBed = getState().print?.bedDimensions;
  setState(s => ({ ...s, print: { ...s.print, ...patch } }), SILENT);
  if ('bedDimensions' in patch) {
    const bed = getState().print.bedDimensions;
    const changed = ['x', 'y', 'z'].some(k => prevBed?.[k] !== bed?.[k]);
    if (changed) {
      SceneManager.rebuildBed?.();
      MeshValidator.invalidateAll?.();   // exceedsBed results depend on bed dims (A6)
      if (getState().scene?.overlays?.bedPreview) SceneManager.updateBedPreview?.(bed);
    }
  }
}

/** Generic undoable patch of `state.print` (per-project settings only). */
export class SetPrintSettingsCommand {
  /**
   * @param {Record<string, any>} patch  keys ⊂ PRINT_SETTING_KEYS
   * @param {string} [label]
   */
  constructor(patch, label = 'Change print setting') {
    const keys = Object.keys(patch ?? {}).filter(k => PRINT_SETTING_KEYS.includes(k));
    this.label = label;
    this._next = Object.fromEntries(keys.map(k => [k, _clonePatchValue(patch[k])]));
    this._prev = _pick(getState().print, keys);
  }
  execute() { _applyPrintPatch(this._next); markDirty(); }
  undo() { _applyPrintPatch(this._prev); }
}

/**
 * Select a printer AND apply its suggested defaults (export format,
 * split-by-material, OBJ axis, 3MF flavour, bed) as one undo step. Also the
 * Printer default ↺ action (same printer → reverts every override). A
 * profile without a finite bed (Custom) keeps the current bed.
 */
export class ApplyPrinterProfileCommand extends SetPrintSettingsCommand {
  /** @param {string} printerId */
  constructor(printerId) {
    const id = printerProfileExists(printerId) ? printerId : getState().print?.targetPrinterId;
    const profile = getPrinterProfile(id);
    const d = profileDefaults(profile);
    const patch = {
      targetPrinterId: profile.id,
      exportFormat: d.exportFormat,
      splitByMaterial: d.splitByMaterial,
      objAxis: d.objAxis,
      threeMFFlavour: d.threeMFFlavour,
      bedDimensions: isFiniteBed(d.bedDimensions) ? d.bedDimensions : { ...getState().print.bedDimensions },
    };
    super(patch, `Printer: ${profile.displayName}`);
    this.printerId = profile.id;
  }
}

/** Set the explicit export reference (null = first printable object). */
export class SetReferenceObjectCommand extends SetPrintSettingsCommand {
  /** @param {string|null} objectId */
  constructor(objectId) {
    super({ referenceObjectId: objectId ?? null }, 'Change export reference');
  }
}
