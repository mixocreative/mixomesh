export type PrinterFormat = '3mf-materials-ext' | '3mf-colorgroup' | 'obj+mtl' | 'stl';
export type PrinterColorMode = 'texture-uv' | 'solid-per-part' | 'none';
export type ExportPrepStep =
  | 'fallbackMaterial'
  | 'flattenWorld'
  | 'preserveUVs'
  | 'preserveTextures'
  | 'collapseToSolidColor'
  | 'synthesizeSolidColorPNG'
  | 'weld'
  | 'repairWinding';

export type PrinterProfile = {
  id: string;
  displayName: string;
  vendor: string;
  format: PrinterFormat;
  color: {
    mode: PrinterColorMode;
    colorSpace?: 'sRGB';
  };
  texture: null | {
    maxSize: number;
    encoding: 'png';
  };
  bed: {
    x: number | null;
    y: number | null;
    z: number | null;
  };
  axis: {
    up: 'Y' | 'Z';
    winding: 'cw' | 'ccw';
  };
  unit: 'millimeter';
  prep: ExportPrepStep[];
};

export const DEFAULT_PRINTER_ID = 'mimaki-3duj-553';
export const DEFAULT_MIMAKI_3DUJ_553_BED = { x: 508, y: 508, z: 305 } as const;
