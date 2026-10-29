import type { TriangleMesh } from '../core/analysis/types';
import type { DentalRegionProposal } from './dentalRegion';
import { dentalInternals } from './dentalEngine';
import { decodeContacts, type DiagnosticContourContact } from './dentalContourContacts';

type Region = Extract<DentalRegionProposal, { kind: 'proposal' }>;

export interface DentalContactFootprintSettings {
  /** The area: faces whose signed contour distance lies in `[low, high]` mm (negative across the edge). */
  low: number;
  high: number;
  outerSpacing: number;
  innerSpacing: number;
  maxSearchDistance: number;
  /** Where the even samples sit within each step, as a fraction of it: omitted (0) the primaries, 0.5 halfway between. */
  samplePhaseFraction?: number;
  /** No two contacts (either contour) closer than this, 3D mm; 0 turns it off. */
  minTipSeparation: number;
  /** Tips a support cannot reach from below `up` (the plate normal, mesh frame) move up to `moveMm` past the area (Rust `footprint::Facing`). */
  fromBelow?: { up: [number, number, number]; maxUp: number; moveMm: number };
}

export type DentalContactFootprint =
  | { kind: 'proposal'; contactFaces: Uint8Array; outerContacts: DiagnosticContourContact[];
    innerContacts: DiagnosticContourContact[] }
  | { kind: 'inconclusive'; reason: string };

/**
 * The narrow contact candidate for a region's contours (Rust `dental_footprint`, Node test package
 * only; production takes it inside `dental_policy`). The old broad
 * face cut only distinguishes the two sides of each ridge. This proposal is not a production
 * permission: contact approach, secondary landings, and body paths still need to be checked
 * before a support is built.
 */
export function proposeDentalContactFootprint(mesh: TriangleMesh, region: Region,
  settings: DentalContactFootprintSettings): DentalContactFootprint {
  const result = dentalInternals().dental_footprint(mesh.positions, mesh.indices, region.allowedFaces, region.outerEdges, region.openingEdges,
    Float64Array.of(settings.low, settings.high, settings.outerSpacing, settings.innerSpacing, settings.maxSearchDistance,
      settings.samplePhaseFraction ?? Number.NaN, settings.minTipSeparation,
      ...(settings.fromBelow ? [...settings.fromBelow.up, settings.fromBelow.maxUp, settings.fromBelow.moveMm] : [])));
  try {
    if (!result.ok()) return { kind: 'inconclusive', reason: result.reason() };
    const contacts = decodeContacts(result.contact_faces_of(), result.contact_points(), result.contact_distances(), result.contact_rims());
    const strip = (rim: 'outer' | 'opening') => contacts.filter((contact) => contact.rim === rim).map(({ rim: _rim, ...contact }) => contact);
    return { kind: 'proposal', contactFaces: result.take_contact_faces(), outerContacts: strip('outer'), innerContacts: strip('opening') };
  } finally {
    result.free();
  }
}
