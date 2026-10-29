import type { DentalRim } from './dental';
import type { DentalRegionProposal } from './dentalRegion';
import type { DentalTuning } from './dentalTuning';
import type { SurfaceStamp } from '../core/supports/zones';

/** One unit-local brush dab that changes where automatic dental supports may attach. */
export interface DentalAllowStamp extends SurfaceStamp<'allow' | 'erase'> {}

/** Dental-only structural choices. Older projects without this field use both structures. */
export interface DentalStructure {
  treeEnabled: boolean;
  bracesEnabled: boolean;
}

/** Tree and Brace on unless the aligner's own switches turn them off (Rust `dental_policy` applies them). */
export const defaultDentalStructure: Readonly<DentalStructure> = { treeEnabled: true, bracesEnabled: true };

/** The accepted detector footprint plus user edits. This is separate from no-support zones. */
interface DentalPolicyBase {
  /** The aligner type (profile file id) the area was detected and is recomputed with. */
  profileId: string;
  rim: DentalRim;
  stamps: readonly DentalAllowStamp[];
}

/**
 * Old saved policies stay readable but cannot inherit the two-contour permission implicitly.
 * `origin: 'manual-area'` is the policy of an area painted from scratch because detection found
 * none (the app's (mixodental) `src/dental/manualArea.ts`): only the paint permits, never the cavity footprint.
 */
export type DentalPolicy =
  | (DentalPolicyBase & { kind?: 'legacy'; origin?: 'manual-area' })
  | (DentalPolicyBase & { kind: 'two-contour'; region: Extract<DentalRegionProposal, { kind: 'proposal' }>;
    /** Absent on older projects: reproduce the original defaults exactly. */
    tuning?: DentalTuning;
    structure?: DentalStructure });

/** The exact preview footprint; old or malformed saved policies show no approved faces. */
export function dentalContactMask(policy: DentalPolicy, faceCount: number): Uint8Array {
  const mask = policy.kind === 'two-contour' ? policy.region.contactFaces : undefined;
  return mask?.length === faceCount ? mask : new Uint8Array(faceCount);
}

/** Whether the permitted area is the operator's own paint (no area was detected). */
export function isManualArea(policy: DentalPolicy): boolean {
  return policy.kind !== 'two-contour' && policy.origin === 'manual-area';
}
