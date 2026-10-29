import type { DentalTuning } from './dentalTuning';
import { profileData } from './alignerProfiles';

/** The area controls an aligner type starts with (its profile file). */
export function defaultDentalTuning(profileId: string): DentalTuning {
  const { positionMm, stripWidthMm, density } = profileData(profileId).defaults;
  return { positionMm, stripWidthMm, density };
}

/**
 * The tuning every two-contour project used before it was saved with one: the first profile
 * defaults (setback 0.2 mm, strip width 1 mm, density 1), as a position. A project saved without a
 * tuning is read with it, so its saved strip still reproduces.
 */
export const UNSAVED_TUNING: Readonly<DentalTuning> = { positionMm: 0.7, stripWidthMm: 1, density: 1 };

/** A tuning as older projects saved it: the strip began `setbackMm` from the edge. */
export interface SetbackTuning {
  setbackMm: number;
  stripWidthMm: number;
  density: number;
}

/**
 * Bounded operator controls (the profile's limits; UI limits, not validated clinical ranges). An older
 * saved tuning (`setbackMm`) is read as the same area: its middle line is the setback plus half the width.
 */
export function parseDentalTuning(input: DentalTuning | SetbackTuning, profileId: string): DentalTuning {
  const { defaults } = profileData(profileId);
  const { stripWidthMm, density } = input;
  const positionMm = 'setbackMm' in input ? input.setbackMm + stripWidthMm / 2 : input.positionMm;
  if (![positionMm, stripWidthMm, density].every(Number.isFinite) ||
    positionMm < defaults.positionMinMm || positionMm > defaults.positionMaxMm || stripWidthMm < defaults.stripWidthMinMm || stripWidthMm > defaults.stripWidthMaxMm ||
    density < defaults.densityMin || density > defaults.densityMax) throw new TypeError('Invalid dental strip or spacing settings');
  return { positionMm, stripWidthMm, density };
}
