import { getState } from '../StateManager.js';
import printersData from '../../config/printers.json' with { type: 'json' };

export const DEFAULT_PRINTER_ID = 'mimaki-3duj-553';
export const DEFAULT_MIMAKI_3DUJ_553_BED = { x: 508, y: 508, z: 305 };

export function getPrinterProfile(id = null) {
  const resolvedId = id || getState().print?.targetPrinterId || DEFAULT_PRINTER_ID;
  return printersData[resolvedId] || printersData[DEFAULT_PRINTER_ID];
}

export function getDefaultPrinterProfile() {
  return getPrinterProfile(DEFAULT_PRINTER_ID);
}

export function bedDimensionsForPrinter(id = null) {
  const bed = getPrinterProfile(id).bed || {};
  return {
    x: bed.x ?? DEFAULT_MIMAKI_3DUJ_553_BED.x,
    y: bed.y ?? DEFAULT_MIMAKI_3DUJ_553_BED.y,
    z: bed.z ?? DEFAULT_MIMAKI_3DUJ_553_BED.z,
  };
}

export function listPrinterProfiles() {
  return Object.entries(printersData).map(([id, profile]) => ({ id, ...profile }));
}

export function getPrinterProfileMap() {
  return printersData;
}

export function printerProfileExists(id) {
  return !!printersData[id];
}
