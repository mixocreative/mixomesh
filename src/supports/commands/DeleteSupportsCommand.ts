/**
 * Delete supports by contact id (a click, a brush selection, Delete): a manual one leaves the
 * manual list with its own settings; an automatic one is recorded in `deleted`, so it stays gone
 * across regenerations (its id encodes its position and is rekeyed with the hand work).
 */
import { t } from '../../i18n/index.js';
import type { ObjectSupports } from '../model';
import { SupportEditCommand } from './SupportEditCommand';

export class DeleteSupportsCommand extends SupportEditCommand {
  private readonly ids: readonly string[];

  constructor(objectId: string, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    super(objectId, unique.length === 1 ? t('history.supportDelete') : t('history.supportDeleteCount', { n: unique.length }));
    this.ids = unique;
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    const manualIds = new Set(prev.manual.map((p) => p.id));
    const removedManual = new Set(this.ids.filter((id) => manualIds.has(id)));
    const deleted = [...prev.deleted];
    for (const id of this.ids) if (!removedManual.has(id) && !deleted.includes(id)) deleted.push(id);
    const overrides = { ...prev.overrides };
    for (const id of removedManual) delete overrides[id];
    return { ...prev, manual: prev.manual.filter((p) => !removedManual.has(p.id)), deleted, overrides };
  }
}
