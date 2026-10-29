/**
 * Add one support (the Add tool). `planAddTip` (mixo-geocore editing) decides where it lands: at
 * the click, or snapped onto the nearest shown automatic / suggested tip within Click reach, in
 * which case that tip's id is deleted in the same step so the two never stand together.
 */
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import { planAddTip, type AddTipInput, type AddTipPlan } from '@mixo-geocore/editing/addTip';
import { t } from '../../i18n/index.js';
import type { ObjectSupports } from '../model';
import { SupportEditCommand } from './SupportEditCommand';

export type AddSupportInput = Omit<AddTipInput, 'removed' | 'createId' | 'reach' | 'candidates'> & {
  /** Automatic contacts and suggested tips on show, support frame. */
  candidates: readonly SupportPoint[];
  /** Click reach in mm; default the object's `eraseRadius` (mixosupports addTip). */
  reach?: number;
  /** Id for the new manual tip; default `manual-<uuid>`. */
  createId?: () => string;
};

export class AddSupportCommand extends SupportEditCommand {
  /** The landed plan (after the first execute): the contact, the snapped-to id, the status code. */
  plan: AddTipPlan | undefined;
  private readonly input: AddSupportInput;

  constructor(objectId: string, input: AddSupportInput) {
    super(objectId, t('history.supportAdd'));
    this.input = input;
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    const plan = planAddTip({
      ...this.input,
      reach: this.input.reach ?? prev.settings.eraseRadius,
      removed: new Set(prev.deleted),
      createId: this.input.createId ?? (() => `manual-${crypto.randomUUID()}`),
    });
    this.plan = plan;
    const deleted = plan.removeId && !prev.deleted.includes(plan.removeId) ? [...prev.deleted, plan.removeId] : prev.deleted;
    return { ...prev, manual: [...prev.manual, plan.contact], deleted };
  }
}
