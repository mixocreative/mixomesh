import { ALIGNER_PROFILES, DEFAULT_PROFILE_ID } from './alignerProfiles';
import { DEFAULT_DENTURE_PROFILE_ID, DENTURE_PROFILES } from './dentureProfiles';

/*
 * The dental product kind (PD.6, owner 2026-10-30): aligners and dentures are different products
 * with separate engine pipelines and profiles. The CALLER selects the kind (the batch asks once per
 * run, the app per unit); nothing here guesses it from a mesh. A shape check may later VERIFY the
 * choice and ask for a look, never switch it silently.
 */

/** The two dental product kinds the engine has a profile family for. */
export type DentalKind = 'aligner' | 'denture';

/** Every kind, in menu order. */
export const DENTAL_KINDS: readonly DentalKind[] = ['aligner', 'denture'];

/** Whether `value` names a dental kind (for parsing batch options and saved files). */
export const isDentalKind = (value: unknown): value is DentalKind => value === 'aligner' || value === 'denture';

/** The profile a new unit of `kind` starts with (the reference profile of that family). */
export function defaultProfileId(kind: DentalKind): string {
  return kind === 'denture' ? DEFAULT_DENTURE_PROFILE_ID : DEFAULT_PROFILE_ID;
}

/** The profile ids of `kind`, in card order. */
export function profileIdsOf(kind: DentalKind): string[] {
  return (kind === 'denture' ? DENTURE_PROFILES : ALIGNER_PROFILES).map((profile) => profile.id);
}

/** The kind a profile id belongs to, or undefined for an id neither family defines. */
export function kindOfProfile(profileId: string | undefined): DentalKind | undefined {
  if (ALIGNER_PROFILES.some((profile) => profile.id === profileId)) return 'aligner';
  if (DENTURE_PROFILES.some((profile) => profile.id === profileId)) return 'denture';
  return undefined;
}

/** The kind of `profileId`; throws for an unknown id (a caller passing the wrong family is a bug, not a fallback). */
export function requireKind(profileId: string): DentalKind {
  const kind = kindOfProfile(profileId);
  if (!kind) throw new TypeError(`unknown dental profile '${profileId}'`);
  return kind;
}
