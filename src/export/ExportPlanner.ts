import { computePrintExportScale } from '../core/scale/ScaleMath';
import type { PrintScale, SceneScale } from '../core/scale/ScaleMath';
import { getPrinterProfile } from '../core/printers/PrinterProfiles';
import type { PrinterProfile } from '../core/printers/PrinterProfile';
import type { ExportMesh, ExportPlan, ExportRequest } from './ExportPipeline';

export type BuildExportPlanInput<TMesh = unknown> = {
  projectName: string;
  printerId: string;
  sceneScale: SceneScale;
  printScale: PrintScale;
  selectedOnly?: boolean;
  individually?: boolean;
  meshes: ExportMesh<TMesh>[];
};

export function buildExportPlan<TMesh = unknown>(input: BuildExportPlanInput<TMesh>): ExportPlan<TMesh> {
  const printer = getPrinterProfile(input.printerId);
  const request: ExportRequest = {
    selectedOnly: input.selectedOnly === true,
    individually: input.individually === true,
    sceneScale: input.sceneScale,
    printScale: input.printScale,
    printer,
  };
  return {
    request,
    printExportScale: computePrintExportScale(input.sceneScale, input.printScale),
    filenameSuffix: scaleFilenameSuffix(input.sceneScale, input.printScale),
    meshes: input.meshes,
  };
}

export function scaleFilenameSuffix(sceneScale: SceneScale, printScale: PrintScale): string {
  return `_r${ratioToken(sceneScale.sceneRatio)}to${ratioToken(printScale.printRatio)}`;
}

export function exportBaseName(projectName: string, sceneScale: SceneScale, printScale: PrintScale): string {
  return `${safeFilenameStem(projectName || 'Untitled')}${scaleFilenameSuffix(sceneScale, printScale)}`;
}

export function profilePreservesTextures(profile: PrinterProfile): boolean {
  return profile.color.mode === 'texture-uv'
    && profile.prep.includes('preserveUVs')
    && profile.prep.includes('preserveTextures');
}

export function profileUsesSolidPartColors(profile: PrinterProfile): boolean {
  return profile.color.mode === 'solid-per-part'
    || profile.prep.includes('collapseToSolidColor');
}

function ratioToken(ratio: number): string {
  const value = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))).replace('.', 'p');
}

function safeFilenameStem(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return cleaned || 'Untitled';
}
