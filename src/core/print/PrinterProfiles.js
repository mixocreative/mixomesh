import { getState } from '../StateManager.js';
import printersData from '../../config/printers.json' with { type: 'json' };

/**
 * @typedef {'obj-mtl'|'3mf-textured'|'3mf-colorgroup'|'3mf-bambu'|'3mf-prusa'|'stl'|'ply'|'wrl'} PrinterFormat
 * @typedef {'uv-inkjet'|'polyjet'|'mjf'|'fdm'|'fdm-multi'|'resin'|'sls'} PrinterProcess
 * @typedef {'texture'|'vertex'|'per-part'|'paint'|'none'} PrinterColourMode
 * @typedef {Object} PrinterProfile  printers.json v2 row (Blueprint section 12), normalised.
 * @property {string} id
 * @property {string} displayName
 * @property {string} vendor
 * @property {PrinterProcess} process
 * @property {{x:number|null,y:number|null,z:number|null}} bed  mm; nulls (Custom) fall back to the Mimaki default helper
 * @property {{mode:PrinterColourMode,maxTextureSize:number,maxTexturesPerObject:number,alpha:boolean}} colour
 * @property {{recommended:PrinterFormat,splitByMaterial:boolean,obj:{axis:'y-up'|'z-up'},threeMF:{flavour:'core'|'bambu'|'prusa',metadata:boolean}}} export
 * @property {{requireWatertight:boolean,minWallMM:number,minFeatureMM:number}} validation
 * @property {string} defaultMaterialId
 */

export const PRINTER_PROCESSES = ['uv-inkjet', 'polyjet', 'mjf', 'fdm', 'fdm-multi', 'resin', 'sls'];
export const PRINTER_COLOUR_MODES = ['texture', 'vertex', 'per-part', 'paint', 'none'];
export const PRINTER_FORMATS = ['obj-mtl', '3mf-textured', '3mf-colorgroup', '3mf-bambu', '3mf-prusa', 'stl', 'ply', 'wrl'];
export const PRINTER_3MF_FLAVOURS = ['core', 'bambu', 'prusa'];
export const PRINTER_OBJ_AXES = ['y-up', 'z-up'];

export const DEFAULT_PRINTER_ID = 'mimaki-3duj-553';

/**
 * Fill every v2 field a v1 row (displayName/vendor/bed/defaultMaterialId) lacks.
 * Defaults describe a plain single-colour FDM printer that recommends STL.
 * @returns {PrinterProfile}
 */
export function normalizePrinterProfile(id, row = {}) {
  const r = row || {};
  const colour = r.colour || {};
  const exp = r.export || {};
  const val = r.validation || {};
  const recommended = exp.recommended || 'stl';
  return {
    id,
    displayName: r.displayName ?? id,
    vendor: r.vendor ?? '—',
    process: r.process ?? 'fdm',
    bed: { x: r.bed?.x ?? null, y: r.bed?.y ?? null, z: r.bed?.z ?? null },
    colour: {
      mode: colour.mode ?? 'none',
      maxTextureSize: colour.maxTextureSize ?? 0,
      maxTexturesPerObject: colour.maxTexturesPerObject ?? 0,
      alpha: colour.alpha ?? false,
    },
    export: {
      recommended,
      splitByMaterial: exp.splitByMaterial ?? false,
      obj: { axis: exp.obj?.axis ?? 'y-up' },
      threeMF: {
        flavour: exp.threeMF?.flavour ?? 'core',
        metadata: exp.threeMF?.metadata ?? true,
      },
    },
    validation: {
      requireWatertight: val.requireWatertight ?? true,
      minWallMM: val.minWallMM ?? 0.8,
      minFeatureMM: val.minFeatureMM ?? 0.4,
    },
    defaultMaterialId: r.defaultMaterialId ?? 'pla',
  };
}

const _normalized = Object.fromEntries(
  Object.entries(printersData).map(([id, row]) => [id, normalizePrinterProfile(id, row)]));

export function getPrinterProfile(id = null) {
  const resolvedId = id || getState().print?.targetPrinterId || DEFAULT_PRINTER_ID;
  return _normalized[resolvedId] || _normalized[DEFAULT_PRINTER_ID];
}

export function listPrinterProfiles() {
  return Object.values(_normalized).map(profile => ({ ...profile }));
}

export function printerProfileExists(id) {
  return !!_normalized[id];
}
