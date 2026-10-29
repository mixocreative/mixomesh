import type { TriangleMesh } from '../core/analysis/types';
import type { DentalRegionProposal } from './dentalRegion';
import { dentalInternals } from './dentalEngine';
import { tuningArray } from './dentalRegion';
import type { DentalTuning } from './dentalTuning';

type Region = Extract<DentalRegionProposal, { kind: 'proposal' }>;
/** Per-face 0/1 masks of the four diagnostic strips: each side of the outer and of the inner (opening) curve. */
export type DentalDiagnosticBands = { kind: 'proposal'; outerOpeningSide: Uint8Array; outerOtherSide: Uint8Array;
  innerOpeningSide: Uint8Array; innerOtherSide: Uint8Array };
type BandResult = DentalDiagnosticBands | { kind: 'inconclusive'; reason: string };

/**
 * Diagnostic strips on both sides of each curve (Rust `dental_side_bands`, Node test package only). Uses the old face cut
 * only to label sides for inspection; it does not determine which side is non-fitting or allow
 * contacts.
 */
export function diagnosticDentalSideBands(mesh: TriangleMesh, region: Region,
  settings: { setback: number; width: number }): BandResult {
  const result = dentalInternals().dental_side_bands(mesh.positions, mesh.indices, region.allowedFaces, region.outerEdges,
    region.openingEdges, settings.setback, settings.width);
  try {
    if (!result.ok()) return { kind: 'inconclusive', reason: result.reason() };
    return { kind: 'proposal', outerOpeningSide: result.take_band(0), outerOtherSide: result.take_band(1),
      innerOpeningSide: result.take_band(2), innerOtherSide: result.take_band(3) };
  } finally {
    result.free();
  }
}

/** The area a tuning gives on a profile as signed contour distances `[low, high]` mm (Rust `Tuning::band`, Node test package only). */
export function dentalAreaBand(tuning: DentalTuning, profile: string): [number, number] {
  const [low, high] = dentalInternals().dental_area_band(tuningArray(tuning), profile);
  return [low!, high!];
}
