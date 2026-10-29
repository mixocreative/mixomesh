/**
 * Fix on a check finding (port of mixoDental `useFixSpot`, plan P3.5): the camera frames the spot,
 * the Add tool waits, and the support added near it is followed through to the re-check that says
 * whether the spot is covered. The spot belongs to one visit of the mode.
 */
import { atSpot, coverRadius, recheckStatus, type FixSpot } from '@mixo-geocore/editing/check';
import type { Vector } from '@mixo-geocore/host/core/vec3';
import { t } from '../../i18n/index.js';
import { readSupports } from '../store';
import { notify } from './notices';
import { statusText } from './statusText';

let waiting: FixSpot | undefined;
let rechecking: FixSpot | undefined;

/** A finding was sent to Fix: a support added within its cover radius covers it. */
export function setFixSpot(unitId: string, position: Vector, area: number): void {
  const spacing = readSupports(unitId)?.settings.scatterSpacing ?? 2;
  waiting = { unitId, position, radius: coverRadius(spacing, area) };
  rechecking = undefined;
  notify({ message: t('supportLive.fixWaiting') });
}

/** A support was added at `position` (support frame) of `unitId`. */
export function fixSpotAdded(unitId: string, position: Vector | undefined): boolean {
  if (!waiting || !position || waiting.unitId !== unitId || !atSpot(position, waiting)) return false;
  rechecking = waiting;
  waiting = undefined;
  notify({ message: t('supportLive.fixRechecking') });
  return true;
}

/** The re-check after that support landed: say whether the spot is covered. */
export function fixSpotChecked(unitId: string, findings: readonly { position: Vector }[]): void {
  if (!rechecking || rechecking.unitId !== unitId) return;
  const spot = rechecking;
  rechecking = undefined;
  notify({ message: statusText(recheckStatus(spot, findings), t) });
}

export function clearFixSpot(): void {
  waiting = undefined;
  rechecking = undefined;
}
