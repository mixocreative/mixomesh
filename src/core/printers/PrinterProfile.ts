export type PrinterProfile = {
  id: string;
  displayName: string;
  vendor: string;
  bed: {
    x: number | null;
    y: number | null;
    z: number | null;
  };
};

export const DEFAULT_PRINTER_ID = 'mimaki-3duj-553';
export const DEFAULT_MIMAKI_3DUJ_553_BED = { x: 508, y: 508, z: 305 } as const;
