/**
 * One brush stroke of the Support area tool: its stamps (laid by `nextStamp` / `stampsAlong` of
 * mixo-geocore zones while dragging) appended in order, one undo step per stroke. Paint = no-support
 * zone, Erase clears it (the engine's generic policy, plan P3 contract).
 */
import type { ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import { t } from '../../i18n/index.js';
import { appendStamps, type ObjectSupports } from '../model';
import { SupportEditCommand } from './SupportEditCommand';

export class StampStrokeCommand extends SupportEditCommand {
  private readonly stamps: readonly ZoneStamp[];

  constructor(objectId: string, stamps: readonly ZoneStamp[]) {
    const erase = stamps.length > 0 && stamps.every((s) => s.kind === 'erase');
    super(objectId, erase ? t('history.supportZoneErase') : t('history.supportZonePaint'));
    this.stamps = stamps.map((s) => ({ kind: s.kind, radius: s.radius, center: [...s.center], normal: [...s.normal] }));
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    return { ...prev, stamps: appendStamps(prev.stamps, this.stamps) };
  }
}
