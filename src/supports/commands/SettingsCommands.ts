/**
 * Object-wide support settings. ChangeSettings writes keys through `updateSetting` (clamps, and
 * switches a preset to Custom when a preset key changes); ApplyPreset writes a preset's values over
 * the current settings (`applyPreset`). A lift change is a settings change; the caller batches it
 * with `LiftForSupportsCommand` (P3 lift decision).
 */
import { applyPreset, setRoofMode, updateSetting, type LiveSupportSettings, type PresetName, type RoofMode, type SettingKey } from '@mixo-geocore/host/core/supports/settings';
import { t } from '../../i18n/index.js';
import type { ObjectSupports } from '../model';
import { SupportEditCommand } from './SupportEditCommand';

export type SettingsPatch = { [K in SettingKey]?: LiveSupportSettings[K] };

export class ChangeSettingsCommand extends SupportEditCommand {
  private readonly patch: SettingsPatch;

  constructor(objectId: string, patch: SettingsPatch) {
    super(objectId, t('history.supportSettings'));
    this.patch = { ...patch };
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    let settings = prev.settings;
    for (const key of Object.keys(this.patch) as SettingKey[]) {
      // Roof / Cage seed their own defaults the first time a mode is picked (`setRoofMode`), then keep the user's values.
      settings = key === 'roofMode' ? setRoofMode(settings, this.patch.roofMode as RoofMode) : updateSetting(settings, key, this.patch[key] as never);
    }
    return { ...prev, settings };
  }
}

export class ApplyPresetCommand extends SupportEditCommand {
  private readonly preset: PresetName;

  constructor(objectId: string, preset: PresetName) {
    super(objectId, t('history.supportPreset', { name: t(`supports.preset.${preset}`) }));
    this.preset = preset;
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    return { ...prev, settings: applyPreset(this.preset, prev.settings) };
  }
}

/** Replace the whole settings object (Apply to all selected objects, plan P3.5). */
export class SetSettingsCommand extends SupportEditCommand {
  private readonly settings: LiveSupportSettings;

  constructor(objectId: string, settings: LiveSupportSettings) {
    super(objectId, t('history.supportSettings'));
    this.settings = JSON.parse(JSON.stringify(settings)) as LiveSupportSettings;
  }

  protected transition(prev: ObjectSupports): ObjectSupports {
    return { ...prev, settings: JSON.parse(JSON.stringify(this.settings)) as LiveSupportSettings };
  }
}
