import printersJson from '../../config/printers.json' with { type: 'json' };
import {
  DEFAULT_MIMAKI_3DUJ_553_BED,
  DEFAULT_PRINTER_ID,
  type ExportPrepStep,
  type PrinterColorMode,
  type PrinterFormat,
  type PrinterProfile,
} from './PrinterProfile';

type PrinterProfileMap = Record<string, PrinterProfile>;

const FORMAT_VALUES = new Set<PrinterFormat>(['3mf-materials-ext', '3mf-colorgroup', 'obj+mtl', 'stl']);
const COLOR_MODE_VALUES = new Set<PrinterColorMode>(['texture-uv', 'solid-per-part', 'none']);
const PREP_VALUES = new Set<ExportPrepStep>([
  'fallbackMaterial',
  'flattenWorld',
  'preserveUVs',
  'preserveTextures',
  'collapseToSolidColor',
  'synthesizeSolidColorPNG',
  'weld',
  'repairWinding',
]);

export const PRINTER_PROFILES: PrinterProfileMap = validatePrinterProfiles(printersJson);

export function getPrinterProfile(id: string | null | undefined): PrinterProfile {
  return PRINTER_PROFILES[id ?? ''] ?? PRINTER_PROFILES[DEFAULT_PRINTER_ID];
}

export function getDefaultPrinterProfile(): PrinterProfile {
  return getPrinterProfile(DEFAULT_PRINTER_ID);
}

export function bedDimensionsForPrinter(id: string | null | undefined): { x: number; y: number; z: number } {
  const bed = getPrinterProfile(id).bed;
  return {
    x: bed.x ?? DEFAULT_MIMAKI_3DUJ_553_BED.x,
    y: bed.y ?? DEFAULT_MIMAKI_3DUJ_553_BED.y,
    z: bed.z ?? DEFAULT_MIMAKI_3DUJ_553_BED.z,
  };
}

function validatePrinterProfiles(value: unknown): PrinterProfileMap {
  if (!isRecord(value)) throw new Error('Printer profile config must be an object.');
  const out: PrinterProfileMap = {};
  for (const [id, raw] of Object.entries(value)) {
    out[id] = validatePrinterProfile(id, raw);
  }
  if (!out[DEFAULT_PRINTER_ID]) {
    throw new Error(`Default printer profile missing: ${DEFAULT_PRINTER_ID}`);
  }
  return out;
}

function validatePrinterProfile(id: string, value: unknown): PrinterProfile {
  if (!isRecord(value)) throw new Error(`Printer profile ${id} must be an object.`);
  const format = value.format;
  if (typeof format !== 'string' || !FORMAT_VALUES.has(format as PrinterFormat)) {
    throw new Error(`Printer profile ${id} has unsupported format.`);
  }
  const printerFormat = format as PrinterFormat;
  const color = value.color;
  if (!isRecord(color) || typeof color.mode !== 'string' || !COLOR_MODE_VALUES.has(color.mode as PrinterColorMode)) {
    throw new Error(`Printer profile ${id} has unsupported color mode.`);
  }
  const printerColorMode = color.mode as PrinterColorMode;
  const bed = value.bed;
  if (!isRecord(bed)) throw new Error(`Printer profile ${id} has no bed dimensions.`);
  const axis = value.axis;
  if (!isRecord(axis) || (axis.up !== 'Y' && axis.up !== 'Z') || (axis.winding !== 'cw' && axis.winding !== 'ccw')) {
    throw new Error(`Printer profile ${id} has unsupported axis settings.`);
  }
  const prep = value.prep;
  if (!Array.isArray(prep) || !prep.every(step => typeof step === 'string' && PREP_VALUES.has(step as ExportPrepStep))) {
    throw new Error(`Printer profile ${id} has unsupported prep steps.`);
  }

  return {
    id,
    displayName: stringField(value.displayName, id),
    vendor: stringField(value.vendor, 'Unknown'),
    format: printerFormat,
    color: {
      mode: printerColorMode,
      colorSpace: color.colorSpace === 'sRGB' ? 'sRGB' : undefined,
    },
    texture: validateTexture(value.texture),
    bed: {
      x: nullableNumber(bed.x),
      y: nullableNumber(bed.y),
      z: nullableNumber(bed.z),
    },
    axis: {
      up: axis.up,
      winding: axis.winding,
    },
    unit: 'millimeter',
    prep: prep as ExportPrepStep[],
  };
}

function validateTexture(value: unknown): PrinterProfile['texture'] {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error('Printer texture config must be an object.');
  const maxSize = nullableNumber(value.maxSize);
  if (maxSize == null || maxSize <= 0 || value.encoding !== 'png') {
    throw new Error('Printer texture config must declare positive PNG maxSize.');
  }
  return { maxSize, encoding: 'png' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
