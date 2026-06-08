import type { PrintScale, SceneScale } from '../core/scale/ScaleMath';
import type { PrinterProfile } from '../core/printers/PrinterProfile';

export type DimensionsMM = {
  x: number;
  y: number;
  z: number;
};

export type ExportRequest = {
  selectedOnly: boolean;
  individually: boolean;
  sceneScale: SceneScale;
  printScale: PrintScale;
  printer: PrinterProfile;
};

export type ExportMesh<TMesh = unknown> = {
  scenePartId: string;
  displayName: string;
  mesh: TMesh;
};

export type ExportPackage =
  | {
      kind: 'blob';
      filename: string;
      mime: string;
      data: Blob | string | ArrayBuffer | Uint8Array;
    }
  | {
      kind: 'zip';
      filename: string;
      mime: string;
      entries: Array<{ path: string; data: Blob | string | ArrayBuffer | Uint8Array }>;
    };

export type ExportPlan<TMesh = unknown> = {
  request: ExportRequest;
  printExportScale: number;
  filenameSuffix: string;
  meshes: ExportMesh<TMesh>[];
};
