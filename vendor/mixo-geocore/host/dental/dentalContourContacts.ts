import { dentalInternals } from './dentalEngine';
import type { TriangleMesh } from '../core/analysis/types';

type Vec3 = [number, number, number];
export type DiagnosticContourContact = {
  /** Production detector sets this; older saved policies and standalone diagnostics may omit it. */
  rim?: 'outer' | 'opening';
  face: number;
  position: Vec3;
  normal: Vec3;
  distanceAlongContour: number;
  distanceFromContour: number;
};
export type DiagnosticContactSample =
  | { kind: 'proposal'; contacts: DiagnosticContourContact[]; skippedSamples: number; perimeter: number }
  | { kind: 'inconclusive'; reason: string };

/** Contacts from the flat arrays the Rust calls return (face, position + normal, along + from). */
export function decodeContacts(faces: Uint32Array, points: Float64Array, distances: Float64Array, rims?: Uint8Array): DiagnosticContourContact[] {
  return Array.from(faces, (face, at) => ({
    ...(rims ? { rim: rims[at] === 0 ? 'outer' as const : 'opening' as const } : {}),
    face,
    position: [points[at * 6]!, points[at * 6 + 1]!, points[at * 6 + 2]!] as Vec3,
    normal: [points[at * 6 + 3]!, points[at * 6 + 4]!, points[at * 6 + 5]!] as Vec3,
    distanceAlongContour: distances[at * 2]!,
    distanceFromContour: distances[at * 2 + 1]!,
  }));
}

/**
 * Diagnostic arclength sampler (Rust `dental_sample_contacts`, Node test package only): even steps of
 * `L / max(3, round(L / spacing))`, `phaseFraction` of a step in (default 0). The mask is an input from a
 * separate side-band detector, not a safety certificate. Search stays locally connected on the
 * mesh: it does not prove a collision-free support body, correct anatomy, or an acceptable
 * first-layer island.
 */
export function sampleDiagnosticContourContacts(mesh: TriangleMesh, contour: Uint32Array,
  sideBand: Uint8Array, settings: { spacing: number; maxSearchDistance: number; phaseFraction?: number; minSeparation?: number }): DiagnosticContactSample {
  const result = dentalInternals().dental_sample_contacts(mesh.positions, mesh.indices, contour, sideBand,
    settings.spacing, settings.maxSearchDistance, settings.phaseFraction ?? Number.NaN, settings.minSeparation ?? 0);
  try {
    if (!result.ok()) return { kind: 'inconclusive', reason: result.reason() };
    return { kind: 'proposal', contacts: decodeContacts(result.faces(), result.points(), result.distances()),
      skippedSamples: result.skipped_samples(), perimeter: result.perimeter() };
  } finally {
    result.free();
  }
}
