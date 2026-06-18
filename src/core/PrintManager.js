/**
 * PrintManager — public façade for the export subsystem.
 *
 * Re-exports the API surface used by UI (PrintPanel) and tests. ALL named
 * exports and the `PrintManager` namespace come from a single `API` object
 * so they cannot drift — adding a method touches one place.
 *
 * Implementation lives in:
 *   src/core/print/PrintPipeline.js    orchestrator + STL/3MF inline
 *   src/core/print/ExportContext.js    typedef, builder, preview, dimensions
 *   src/core/print/PrintNaming.js      filename helpers
 *   src/core/print/PrintPrep.js        per-mesh prep steps
 *   src/core/print/ObjWriter.js        OBJ + MTL + solid-PNG synthesis
 *   src/core/print/ThreeMFWriter.js    3MF colorgroup + materials-ext
 *   src/core/print/PrintPackaging.js   zip + save-picker
 *   src/core/print/PrintFormats.js     format registry
 *   src/core/print/ExportPlanner.js    pure filename math
 *   src/core/print/PrinterProfiles.js  bed dim profiles
 *   src/core/print/ExportTextures.js   texture/blob collection
 *
 * UI rule: PrintPanel imports ONLY from PrintManager for export concerns
 * (plus ScaleMath for pure UI helpers like formatScaleRatio). No reaching
 * across layers.
 */

import scalePresetData from '../config/scale-presets.json' with { type: 'json' };
import * as Pipeline from './print/PrintPipeline.js';
import * as Ctx from './print/ExportContext.js';

const API = Object.freeze({
  exportOBJ:            Pipeline.exportOBJ,
  exportSTL:            Pipeline.exportSTL,
  exportThreeMF:        Pipeline.exportThreeMF,
  getExportReference:   Ctx.getExportReference,
  getExportedDimensions: Ctx.getExportedDimensions,
  previewExportContext: Ctx.previewExportContext,
  BU_TO_MM:             Ctx.BU_TO_MM,
  SCALE_PRESETS:        scalePresetData,
});

export const {
  exportOBJ,
  exportSTL,
  exportThreeMF,
  getExportReference,
  getExportedDimensions,
  previewExportContext,
  BU_TO_MM,
  SCALE_PRESETS,
} = API;

export const PrintManager = API;
