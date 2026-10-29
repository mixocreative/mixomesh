/**
 * Reads and edits of `object.supports` for the panels (plan P3.4). Reads go through `useStore` on
 * the events that change the record; every edit is one support command through HistoryManager
 * (`commitSupportEdits`), so the settings, the overrides and the tips share one undo stack (D21).
 */
import { useMemo } from 'react';
import { SHAPE_KEYS, type LiveSupportSettings, type PresetName, type SettingKey, type ShapeKey, type ShapeOverride } from '@mixo-geocore/host/core/supports/settings';
import { customisedAmong, shapePatch, shapeView, type ShapeView } from '@mixo-geocore/editing/shapeEdit';
import { EVENTS } from '../../core/events.js';
import { useStore } from '../../react/index.ts';
import { emptySupports, isBuilt, type ObjectSupports } from '../../supports/model';
import { readSupports, supportsOwner } from '../../supports/store';
import { cachedPlacement } from '../../supports/supportCache';
import {
  ApplyPresetCommand, ChangeSettingsCommand, DeleteSupportsCommand, LiftForSupportsCommand, ResetOverrideCommand, SetOverrideCommand, commitSupportEdits,
} from '../../supports/commands';

/** The events that change `object.supports` (a write, an undo, a load). */
export const RECORD_EVENTS = [
  EVENTS.SUPPORTS_CHANGED, EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW, EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED,
  EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE,
];

/** The record of `objectId`, or undefined when it has none yet. */
export function useSupportsRecord(objectId: string | undefined): ObjectSupports | undefined {
  return useStore(RECORD_EVENTS, (s) => (objectId ? s.scene.objects[supportsOwner(objectId, s.scene.objects)]?.supports : undefined) as ObjectSupports | undefined);
}

/** Ids of the supports on show: the automatic ones not deleted, then the hand-added ones. */
export function liveContactIds(objectId: string | undefined, supports: ObjectSupports | undefined): string[] {
  if (!objectId || !supports) return [];
  const deleted = new Set(supports.deleted);
  const auto = (cachedPlacement(objectId) ?? []).map((p) => p.id).filter((id) => !deleted.has(id));
  return [...auto, ...supports.manual.map((p) => p.id)];
}

export interface ShapeScope {
  settings: LiveSupportSettings;
  /** What the shape fields show: the defaults, or the selected supports' own values over them. */
  view: ShapeView;
  /** The selected supports that exist (the ids an edit writes to). */
  selected: string[];
  /** Of those, the ones with settings of their own. */
  customisedSelected: string[];
  /** All supports with settings of their own, and all on show. */
  customised: string[];
  total: number;
}

export function useShapeScope(objectId: string | undefined, selection: ReadonlySet<string>): { record: ObjectSupports | undefined; scope: ShapeScope } {
  const record = useSupportsRecord(objectId);
  const scope = useMemo(() => {
    const settings = record?.settings ?? emptySupports().settings;
    const overrides = record?.overrides ?? {};
    const live = liveContactIds(objectId, record);
    const selected = live.filter((id) => selection.has(id));
    return {
      settings,
      view: shapeView(settings, overrides, selected),
      selected,
      customisedSelected: customisedAmong(overrides, selected),
      customised: customisedAmong(overrides, live),
      total: live.length,
    };
  }, [objectId, record, selection]);
  return { record, scope };
}

export const isShapeKey = (key: SettingKey): key is ShapeKey => (SHAPE_KEYS as readonly string[]).includes(key);

/**
 * One committed field value. With supports selected, a tip / neck / foot key goes to their own
 * overrides (only where it differs from what they show); every other key is object-wide.
 */
export function commitSetting<K extends SettingKey>(objectId: string, scope: Pick<ShapeScope, 'view' | 'selected'>, key: K, value: LiveSupportSettings[K]): boolean {
  if (scope.selected.length > 0 && isShapeKey(key)) {
    const patch = shapePatch(scope.view, key, value as never) as ShapeOverride | undefined;
    if (!patch) return false;
    commitSupportEdits([new SetOverrideCommand(objectId, scope.selected, patch)]);
    return true;
  }
  const change = new ChangeSettingsCommand(objectId, { [key]: value });
  // Lift height moves the model: the lift and the settings change are one undo step (P3 lift decision).
  if (key === 'liftHeight' && isBuilt(readSupports(objectId))) {
    const lift = new LiftForSupportsCommand(objectId, value as number);
    commitSupportEdits(lift.moves ? [change, lift] : [change], change.label);
    return true;
  }
  commitSupportEdits([change]);
  return true;
}

export function commitPreset(objectId: string, preset: PresetName): void {
  commitSupportEdits([new ApplyPresetCommand(objectId, preset)]);
}

export function commitReset(objectId: string, ids: readonly string[]): void {
  commitSupportEdits([new ResetOverrideCommand(objectId, ids)]);
}

export function commitDelete(objectId: string, ids: readonly string[]): void {
  commitSupportEdits([new DeleteSupportsCommand(objectId, ids)]);
}

export { isBuilt };
