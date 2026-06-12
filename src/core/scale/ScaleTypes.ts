// Shared scale vocabulary — TYPE-ONLY module (no runtime twin to drift).
// Runtime math lives in ScaleMath.js; these shapes are consumed by the typed
// contract modules (ImportPipeline.ts / ExportPipeline.ts) and any future TS.

export type SourceUnit = 'millimeters' | 'centimeters' | 'meters' | 'inches' | 'feet';

export type AuthoredScale = {
  sourceUnit: SourceUnit;
  authoredRatio: number;
  detectedFrom: 'gltf-extras' | 'file-metadata' | 'default' | 'user';
  confirmedByUser: boolean;
};

export type SceneScale = {
  sceneRatio: number;
};

export type PrintScale = {
  printRatio: number;
};
