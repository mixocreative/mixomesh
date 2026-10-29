/**
 * A fresh automatic placement landing on an object (Generate, Regenerate, or the regeneration of
 * stale supports on mode entry). The hand work follows the new contacts through the engine's
 * `rekey_hand_work` (mixo-geocore contactEdits `rekeyHandWork`, match radius = half the support
 * spacing as in mixosupports): manual contacts stay exactly as they are, each removal and each
 * per-support setting moves to the nearest new contact within the radius, one with no new contact
 * near is dropped and counted (`report`). The record takes the build's `sourceHash`, pose and
 * placement settings, and is no longer stale. The placement itself is runtime data
 * (`supportCache`): it follows execute and undo.
 */
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import { rekeyHandWork } from '@mixo-geocore/host/supports/contactEdits';
import { regenReport, type RegenReport } from '@mixo-geocore/editing/regenerate';
import { t } from '../../i18n/index.js';
import { cloneJson, placementSignature, type ObjectSupports, type SupportPose } from '../model';
import { cachePlacement, cachedPlacement } from '../supportCache';
import { SupportEditCommand } from './SupportEditCommand';

export interface RegenerateInput {
  /** The new automatic placement, support frame. */
  points: readonly SupportPoint[];
  /** `sourceHash` of the geometry the placement ran on. */
  sourceHash: string;
  /** Lead pose the placement ran at. */
  pose: SupportPose;
}

export class RegenerateRekeyCommand extends SupportEditCommand {
  /** What became of the hand work (after the first execute), for the Regenerate toast. */
  report: RegenReport | undefined;
  private readonly input: RegenerateInput;
  private prevPlacement: readonly SupportPoint[] | undefined;

  constructor(objectId: string, input: RegenerateInput) {
    super(objectId, t('history.supportRegenerate'));
    this.input = { points: cloneJson(input.points), sourceHash: input.sourceHash, pose: cloneJson(input.pose) };
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    this.prevPlacement = cachedPlacement(this.objectId);
    const matchRadius = prev.settings.scatterSpacing / 2;
    const handWork = rekeyHandWork(prev.deleted, prev.overrides, new Set(prev.manual.map((p) => p.id)), this.input.points, matchRadius);
    this.report = regenReport(prev.manual.length, handWork);
    return {
      ...prev,
      deleted: handWork.deleted,
      overrides: handWork.overrides,
      sourceHash: this.input.sourceHash,
      pose: cloneJson(this.input.pose),
      placed: placementSignature(prev.settings),
      stale: null,
    };
  }

  protected override afterWrite(side: 'execute' | 'undo'): void {
    cachePlacement(this.objectId, side === 'execute' ? this.input.points : this.prevPlacement);
  }
}
