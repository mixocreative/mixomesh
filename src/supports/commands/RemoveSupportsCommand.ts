/**
 * "Remove all supports" (plan P3.5): the built supports of an object go away, the model and the hand
 * work (added supports, removals, per-support settings, zones) and the settings stay. The record is
 * unbuilt afterwards, so nothing rebuilds until Generate; the placement cache follows execute / undo.
 */
import { t } from '../../i18n/index.js';
import type { ObjectSupports } from '../model';
import { cachePlacement, cachedPlacement } from '../supportCache';
import { SupportEditCommand } from './SupportEditCommand';
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';

export class RemoveSupportsCommand extends SupportEditCommand {
  private prevPlacement: readonly SupportPoint[] | undefined;

  constructor(objectId: string) {
    super(objectId, t('history.supportRemoveAll'));
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    this.prevPlacement = cachedPlacement(this.objectId);
    return { ...prev, sourceHash: null, pose: null, placed: null, stale: null };
  }

  protected override afterWrite(side: 'execute' | 'undo'): void {
    cachePlacement(this.objectId, side === 'execute' ? undefined : this.prevPlacement);
  }
}
