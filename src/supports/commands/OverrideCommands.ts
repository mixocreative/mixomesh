/**
 * Per-support shape settings (tip, contact, neck, foot: `SHAPE_KEYS`). Set merges a patch into each
 * support's own values (`parseShapeOverride` drops unknown keys and clamps lengths); Reset removes
 * the supports' own values so they follow the object again.
 */
import { parseShapeOverride, type ShapeOverride } from '@mixo-geocore/host/core/supports/settings';
import { t } from '../../i18n/index.js';
import type { ObjectSupports } from '../model';
import { SupportEditCommand } from './SupportEditCommand';

export class SetOverrideCommand extends SupportEditCommand {
  private readonly ids: readonly string[];
  private readonly patch: ShapeOverride;

  constructor(objectId: string, ids: readonly string[], patch: ShapeOverride) {
    super(objectId, t('history.supportOverride'));
    this.ids = [...new Set(ids)];
    this.patch = parseShapeOverride(patch);
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    const overrides = { ...prev.overrides };
    for (const id of this.ids) overrides[id] = { ...overrides[id], ...this.patch };
    return { ...prev, overrides };
  }
}

export class ResetOverrideCommand extends SupportEditCommand {
  private readonly ids: readonly string[];

  constructor(objectId: string, ids: readonly string[]) {
    super(objectId, t('history.supportResetOverride'));
    this.ids = [...new Set(ids)];
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    const overrides = { ...prev.overrides };
    for (const id of this.ids) delete overrides[id];
    return { ...prev, overrides };
  }
}
