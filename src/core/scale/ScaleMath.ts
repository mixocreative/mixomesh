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

export const SOURCE_UNIT_FACTORS: Record<SourceUnit, number> = {
  millimeters: 0.001,
  centimeters: 0.01,
  meters: 1,
  inches: 0.0254,
  feet: 0.3048,
};

export const DEFAULT_SOURCE_UNIT: SourceUnit = 'millimeters';

export function parseScaleRatioText(value: unknown): number | null {
  const s = String(value ?? '').trim();
  let match = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const left = Number.parseFloat(match[1] ?? '');
    const right = Number.parseFloat(match[2] ?? '');
    return left > 0 && right > 0 ? right / left : null;
  }
  match = s.match(/^(\d+(?:\.\d+)?)$/);
  if (match) {
    const ratio = Number.parseFloat(match[1] ?? '');
    return ratio > 0 ? ratio : null;
  }
  return null;
}

export function formatScaleRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '1:1';
  if (Math.abs(ratio - 1) < 1e-9) return '1:1';
  if (ratio > 1) {
    const rounded = Math.round(ratio);
    return Math.abs(ratio - rounded) < 1e-6 ? `1:${rounded}` : `1:${Number(ratio.toFixed(3))}`;
  }
  const inverse = 1 / ratio;
  const rounded = Math.round(inverse);
  return Math.abs(inverse - rounded) < 1e-6 ? `${rounded}:1` : `${Number(inverse.toFixed(3))}:1`;
}

export function computeSceneNormalizationScale(authoredScale: AuthoredScale, sceneScale: SceneScale): number {
  return SOURCE_UNIT_FACTORS[authoredScale.sourceUnit]
    * (positiveOrOne(authoredScale.authoredRatio) / positiveOrOne(sceneScale.sceneRatio));
}

export function computePrintExportScale(sceneScale: SceneScale, printScale: PrintScale): number {
  return (positiveOrOne(sceneScale.sceneRatio) / positiveOrOne(printScale.printRatio)) * 1000;
}

export function computeSceneScaleRebakeFactor(previousSceneRatio: number, nextSceneRatio: number): number {
  return positiveOrOne(previousSceneRatio) / positiveOrOne(nextSceneRatio);
}

function positiveOrOne(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}
