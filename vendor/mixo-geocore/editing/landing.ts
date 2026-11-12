import type { PlacementResult } from '../host/core/analysis/types';
import type { JobTransform } from '../host/core/jobs';
import type { LiveSupportSettings } from '../host/core/supports/settings';
import { regenReport, type RegenReport } from './regenerate';
import type { PrintUnit, SceneCommand } from '../host/state/projectTypes';
import { placementCommands, placementSignature } from '../host/supports/unitSupports';

/** A finished placement job: the unit's orientation and settings it ran with, and what it found. */
export interface FinishedPlacement {
  unitId: string;
  orientation: JobTransform;
  settings: LiveSupportSettings;
  result: Pick<PlacementResult, 'points' | 'regions' | 'buried'>;
}

/** What landed on one unit; `report` is set for a regeneration (the unit had supports) and says what became of its hand work. */
export interface LandedUnit {
  name: string;
  placed: number;
  report?: RegenReport;
  /**
   * Contacts the overlap rule left out, for standing on a face buried inside another mesh of this
   * same object (engine 67). Carried so the status line can say it: they never reach the build, so
   * no "supports left out" count mentions them, and an operator looking at an overlap with no
   * supports would otherwise be given no reason.
   */
  buried?: number;
}

/**
 * Applies finished placements to the scene as it is now, all in one batch (one undo step, so one
 * Undo brings back every object regenerated together). A unit gone since lands nothing; one
 * rotated since is listed in `again` to be placed anew for its new orientation.
 */
export function landPlacements(units: readonly PrintUnit[], finished: readonly FinishedPlacement[]): { commands: SceneCommand[]; landed: LandedUnit[]; again: PrintUnit[] } {
  const commands: SceneCommand[] = [];
  const landed: LandedUnit[] = [];
  const again: PrintUnit[] = [];
  for (const { unitId, orientation, settings, result } of finished) {
    const now = units.find((unit) => unit.id === unitId);
    if (!now) continue;
    const matchRadius = settings.scatterSpacing / 2;
    const applied = placementCommands(now, orientation, result, settings.liftHeight, matchRadius, placementSignature(settings));
    if (!applied) {
      again.push(now);
      continue;
    }
    commands.push(...applied.commands);
    landed.push({
      name: now.name,
      placed: result.points.length,
      ...(now.supports ? { report: regenReport(now.manual.length, applied.handWork) } : {}),
      ...(result.buried?.length ? { buried: result.buried.length } : {}),
    });
  }
  return { commands, landed, again };
}
