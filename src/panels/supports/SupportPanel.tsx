/**
 * Support settings (plan P3.4): presets Light / Middle / Heavy / Custom, tip, neck, pillar, foot,
 * lift height and preview mode, with the engine's `settingLimits` as the clamps. Editing a key a
 * preset owns flips the preset to Custom (`updateSetting`). With supports selected, the tip / neck /
 * foot fields show and write those supports' own values (per-support overrides), with Reset and
 * Select customised; every other field stays object-wide.
 */
import { useState, type ReactNode } from 'react';
import { settingLimits, type LiveSupportSettings, type PresetName, type RoofMode, type SettingKey } from '@mixo-geocore/host/core/supports/settings';
import { Button, Check, NumberField, Section, Segmented, TextField, Toggle, useToasts } from '../../kit/index.ts';
import { useStore, useT } from '../../react/index.ts';
import { EVENTS } from '../../core/events.js';
import { labelTextFor, sanitizeLabel } from '../../supports/label';
import { supportsOwner } from '../../supports/store';
import { RAFT_WALL_ANGLE_MAX } from '../../supports/live/jobInputs';
import { undo } from '../../core/HistoryManager.js';
import { commitPreset, commitReset, commitSetting, useShapeScope, type ShapeScope } from './supportData';
import { supportSession, useSession } from './sessionStore';

type NumberKey = { [K in SettingKey]: LiveSupportSettings[K] extends number ? K : never }[SettingKey];
type ChoiceKey = 'contactShape' | 'tipSection' | 'tipProfile';
type When = (s: LiveSupportSettings) => boolean;

type ToggleKey = 'scatterAutoTree' | 'trussEnabled' | 'raftEnabled' | 'labelEnabled';

interface NumberDef { kind: 'number'; key: NumberKey; label: string; unit?: 'mm' | 'deg' | '%'; step: number; when?: When }
interface ChoiceDef { kind: 'choice'; key: ChoiceKey; label: string; options: readonly { value: string; label: string }[] }
/** A feature switch (D12: a feature is a toggle button). */
interface ToggleDef { kind: 'toggle'; key: ToggleKey; label: string; hint: string }
/** The raft label text (A-Z 0-9 -, 8 characters). */
interface TextDef { kind: 'text'; key: 'labelText'; label: string; when?: When }
/** A sub-option of the roof / cage (D12: a sub-option is a checkbox). */
interface CheckDef { kind: 'check'; key: 'diagonalEnabled' | 'storeyEncloseCeiling'; label: string; hint: string; when?: When }
/** Off / Roof / Cage: one mode at a time (the engine's single `roofMode`). */
interface ModeDef { kind: 'roofMode'; label: string }
type FieldDef = NumberDef | ChoiceDef | ToggleDef | TextDef | CheckDef | ModeDef;

const mm = (key: NumberKey, label: string, step: number, when?: When): NumberDef => ({ kind: 'number', key, label, unit: 'mm', step, ...(when ? { when } : {}) });
const sphere: When = (s) => s.contactShape === 'SPHERE';
const deg = (key: NumberKey, label: string, step: number, when?: When): NumberDef => ({ kind: 'number', key, label, unit: 'deg', step, ...(when ? { when } : {}) });
const treeOn: When = (s) => s.scatterAutoTree;
const braceOn: When = (s) => s.trussEnabled;
const raftOn: When = (s) => s.raftEnabled;
const labelOn: When = (s) => s.labelEnabled;
const roofOn: When = (s) => s.roofMode === 'ROOF';
const cageOn: When = (s) => s.roofMode === 'CAGE';
const structureOn: When = (s) => s.roofMode !== 'OFF';
const int = (key: NumberKey, label: string, when?: When): NumberDef => ({ kind: 'number', key, label, step: 1, ...(when ? { when } : {}) });

/** Groups in panel order. Labels are locale keys. */
export const GROUPS: readonly { id: string; title: string; fields: readonly FieldDef[] }[] = [
  {
    id: 'tip', title: 'supportPanel.group.tip', fields: [
      { kind: 'choice', key: 'tipSection', label: 'supportPanel.tipSection', options: [
        { value: 'ROUND', label: 'supportPanel.tipSection.round' }, { value: 'SQUARE', label: 'supportPanel.tipSection.square' }, { value: 'CROSS', label: 'supportPanel.tipSection.cross' }] },
      { kind: 'choice', key: 'tipProfile', label: 'supportPanel.tipProfile', options: [
        { value: 'TAPERED', label: 'supportPanel.tipProfile.tapered' }, { value: 'STRAIGHT', label: 'supportPanel.tipProfile.straight' }] },
      { kind: 'number', key: 'tipCrossWidth', label: 'supportPanel.crossWidth', unit: '%', step: 5, when: (s) => s.tipSection === 'CROSS' },
      { kind: 'choice', key: 'contactShape', label: 'supportPanel.contactShape', options: [
        { value: 'NONE', label: 'supportPanel.contactShape.none' }, { value: 'SPHERE', label: 'supportPanel.contactShape.sphere' }] },
      mm('pointDiameter', 'supportPanel.contactDiameter', 0.05, (s) => !sphere(s)),
      mm('touchDiameter', 'supportPanel.contactDiameter', 0.05, sphere),
      mm('pointDepth', 'supportPanel.penetration', 0.05, (s) => !sphere(s)),
      mm('touchDepth', 'supportPanel.contactDepth', 0.05, sphere),
    ],
  },
  {
    id: 'neck', title: 'supportPanel.group.neck', fields: [
      mm('neckDiameter', 'supportPanel.neckDiameter', 0.05, sphere),
      mm('neckLength', 'supportPanel.neckLength', 0.1),
      { kind: 'number', key: 'maxNeckAngle', label: 'supportPanel.neckAngle', unit: 'deg', step: 1 },
    ],
  },
  { id: 'pillar', title: 'supportPanel.group.pillar', fields: [mm('pillarDiameter', 'supportPanel.pillarDiameter', 0.05)] },
  { id: 'foot', title: 'supportPanel.group.foot', fields: [mm('baseDiameter', 'supportPanel.footDiameter', 0.1), mm('baseHeight', 'supportPanel.footHeight', 0.1)] },
  {
    id: 'tree', title: 'supportPanel.group.tree', fields: [
      { kind: 'toggle', key: 'scatterAutoTree', label: 'supportPanel.autoTree', hint: 'supportPanel.autoTreeHint' },
      mm('scatterMergeDistance', 'supportPanel.mergeDistance', 0.5, treeOn),
      mm('scatterBranchDescent', 'supportPanel.branchDescent', 0.5, treeOn),
      mm('scatterSafeDistance', 'supportPanel.safeDistance', 0.5, treeOn),
    ],
  },
  {
    id: 'brace', title: 'supportPanel.group.brace', fields: [
      { kind: 'toggle', key: 'trussEnabled', label: 'supportPanel.braces', hint: 'supportPanel.bracesHint' },
      deg('trussAngle', 'supportPanel.braceAngle', 1, braceOn),
      mm('trussSpacing', 'supportPanel.braceSpacing', 0.5, braceOn),
      mm('trussMinHeight', 'supportPanel.braceMinHeight', 0.5, braceOn),
      mm('trussDistanceLimit', 'supportPanel.braceDistanceLimit', 1, braceOn),
    ],
  },
  {
    id: 'raft', title: 'supportPanel.group.raft', fields: [
      { kind: 'toggle', key: 'raftEnabled', label: 'supportPanel.raft', hint: 'supportPanel.raftHint' },
      mm('raftFloorThickness', 'supportPanel.raftFloor', 0.1, raftOn),
      mm('raftWallHeight', 'supportPanel.raftWallHeight', 0.1, raftOn),
      mm('raftWallThickness', 'supportPanel.raftWallThickness', 0.1, raftOn),
      deg('raftWallAngle', 'supportPanel.raftWallAngle', 1, raftOn),
      mm('raftExpandWidth', 'supportPanel.raftExpand', 0.5, raftOn),
    ],
  },
  {
    id: 'label', title: 'supportPanel.group.label', fields: [
      { kind: 'toggle', key: 'labelEnabled', label: 'supportPanel.labelOn', hint: 'supportPanel.labelHint' },
      { kind: 'text', key: 'labelText', label: 'supportPanel.labelText', when: labelOn },
      mm('labelSize', 'supportPanel.labelSize', 0.5, labelOn),
      mm('labelHeight', 'supportPanel.labelHeight', 0.1, labelOn),
    ],
  },
  {
    // Roof and Cage are one engine mode (`roofMode`): never both. The columns are shared, so they sit under the mode.
    id: 'roof', title: 'supportPanel.group.roof', fields: [
      { kind: 'roofMode', label: 'supportPanel.roofMode' },
      mm('roofGap', 'supportPanel.roofGap', 0.5, roofOn),
      mm('cageSideGap', 'supportPanel.cageSideGap', 0.5, cageOn),
      mm('cageTopGap', 'supportPanel.cageTopGap', 0.5, cageOn),
      mm('cagePitch', 'supportPanel.cagePitch', 0.5, cageOn),
      mm('cageRingDiameter', 'supportPanel.cageRingDiameter', 0.1, cageOn),
      int('columnCount', 'supportPanel.columnCount', structureOn),
      mm('columnDiameter', 'supportPanel.columnDiameter', 0.1, structureOn),
      { kind: 'check', key: 'diagonalEnabled', label: 'supportPanel.crossBars', hint: 'supportPanel.crossBarsHint', when: structureOn },
      mm('diagonalDiameter', 'supportPanel.crossBarDiameter', 0.1, (s) => structureOn(s) && s.diagonalEnabled),
      int('braceConcentric', 'supportPanel.roofBraces', roofOn),
      mm('braceThickness', 'supportPanel.roofBraceDiameter', 0.1, roofOn),
      deg('braceAngle', 'supportPanel.roofBraceAngle', 1, roofOn),
      mm('storeyFloorThickness', 'supportPanel.roofThickness', 0.1, roofOn),
      { kind: 'check', key: 'storeyEncloseCeiling', label: 'supportPanel.solidRoof', hint: 'supportPanel.solidRoofHint', when: roofOn },
    ],
  },
];

/** A kit Section that keeps its own open / closed state. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return <Section title={title} collapsed={collapsed} onCollapsedChange={setCollapsed}>{children}</Section>;
}

const ROOF_MODES: readonly RoofMode[] = ['OFF', 'ROOF', 'CAGE'];
const PRESETS: readonly PresetName[] = ['LIGHT', 'MIDDLE', 'HEAVY'];
const CHOICES = { contactShape: ['NONE', 'SPHERE'], tipSection: ['ROUND', 'SQUARE', 'CROSS'] } as const;

/** A field with a rule shows when the rule holds for the settings, or for any value a mixed choice could take. */
function shown(field: FieldDef, scope: ShapeScope): boolean {
  if (field.kind === 'text' || field.kind === 'check') return field.when?.(scope.settings) ?? true;
  if (field.kind !== 'number' || !field.when) return true;
  let variants: LiveSupportSettings[] = [scope.settings];
  for (const key of ['contactShape', 'tipSection'] as const) {
    const fixed = scope.view[key];
    variants = fixed === undefined
      ? variants.flatMap((s) => CHOICES[key].map((v) => ({ ...s, [key]: v }) as LiveSupportSettings))
      : variants.map((s) => ({ ...s, [key]: fixed }) as LiveSupportSettings);
  }
  return variants.some(field.when);
}

export function SupportPanel({ objectId }: { objectId: string | undefined }) {
  const tt = useT();
  const session = useSession();
  const toasts = useToasts();
  const { record, scope } = useShapeScope(objectId, session.selection);
  const { settings, view } = scope;
  const selectedCount = scope.selected.length;
  const disabled = !objectId;
  const objectName = useStore([EVENTS.OBJECT_RENAMED, EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW],
    (st) => (objectId ? String(st.scene.objects[supportsOwner(objectId, st.scene.objects)]?.name ?? '') : ''));
  const viewValue = (key: string): unknown => (view as Record<string, unknown>)[key];
  const edit = <K extends SettingKey>(key: K, value: LiveSupportSettings[K]) => { if (objectId) commitSetting(objectId, scope, key, value); };

  const renderField = (field: FieldDef) => {
    if (!shown(field, scope)) return null;
    if (field.kind === 'toggle') {
      return (
        <div key={field.key} className="field-row">
          <label>{tt(field.label)}</label>
          <Toggle pressed={settings[field.key]} disabled={disabled} title={tt(field.hint)} aria-label={tt(field.label)}
            onChange={(on) => edit(field.key, on)}>
            {tt(settings[field.key] ? 'supportPanel.on' : 'supportPanel.off')}
          </Toggle>
        </div>
      );
    }
    if (field.kind === 'roofMode') {
      return (
        <div key="roofMode" className="field-row">
          <label>{tt(field.label)}</label>
          <Segmented<string> label={tt(field.label)} value={settings.roofMode} disabled={disabled}
            options={ROOF_MODES.map((m) => ({ value: m, label: tt(`supportPanel.roof.${m}`), title: tt(`supportPanel.roofHint.${m}`) }))}
            onChange={(v) => edit('roofMode', v as RoofMode)} />
        </div>
      );
    }
    if (field.kind === 'check') {
      return (
        <div key={field.key} className="field-row">
          <Check checked={settings[field.key]} disabled={disabled} title={tt(field.hint)} label={tt(field.label)}
            onChange={(on) => edit(field.key, on)} />
        </div>
      );
    }
    if (field.kind === 'text') {
      return (
        <TextField key={field.key} label={tt(field.label)} value={settings.labelText} disabled={disabled}
          filter={sanitizeLabel} placeholder={labelTextFor('', objectName)}
          rejectedHint={tt('supportPanel.labelRejected')} onCommit={(v) => edit('labelText', v)} />
      );
    }
    const isShape = field.key in view;
    const mixed = selectedCount > 0 && isShape && viewValue(field.key) === undefined;
    const label = tt(field.label);
    const shownLabel = mixed ? tt('supportPanel.mixed', { label }) : label;
    if (field.kind === 'choice') {
      const current = isShape ? viewValue(field.key) : settings[field.key];
      return (
        <div key={field.key} className="field-row">
          <label>{shownLabel}</label>
          <Segmented<string> label={label} value={String(current ?? '')} disabled={disabled}
            options={field.options.map((o) => ({ value: o.value, label: tt(o.label) }))}
            onChange={(v) => edit(field.key, v as never)} />
        </div>
      );
    }
    const limits = settingLimits[field.key];
    const value = (isShape ? viewValue(field.key) : undefined) ?? settings[field.key];
    return (
      <NumberField key={field.key} label={shownLabel} unit={field.unit} step={field.step}
        min={limits.min} max={field.key === 'raftWallAngle' ? Math.min(limits.max, RAFT_WALL_ANGLE_MAX) : limits.max} disabled={disabled} value={value as number}
        onCommit={(v) => edit(field.key, v as never)} />
    );
  };

  const resetSelected = () => {
    if (!objectId || scope.customisedSelected.length === 0) return;
    const ids = scope.customisedSelected;
    commitReset(objectId, ids);
    toasts.push({ message: tt('supportPanel.toast.reset', { n: ids.length }), action: { label: tt('supportPanel.undo'), onClick: () => undo() }, timeoutMs: 6000 });
  };
  const selectCustomised = () => supportSession.send({ type: 'paint', ids: scope.customised, mode: 'select' });

  return (
    <div className="sp-settings" data-testid="support-panel">
      <div className="field-row">
        <label>{tt('supportPanel.preset')}</label>
        <div className="segmented" role="group" aria-label={tt('supportPanel.preset')}>
          {PRESETS.map((p) => (
            <button key={p} type="button" aria-pressed={settings.preset === p} disabled={disabled}
              onClick={() => objectId && commitPreset(objectId, p)}>{tt(`supports.preset.${p}`)}</button>
          ))}
          <button type="button" aria-pressed={settings.preset === 'CUSTOM'} disabled
            title={tt('supportPanel.customHint')}>{tt('supports.preset.CUSTOM')}</button>
        </div>
      </div>

      <div className="sp-band" role="status">
        <span>{selectedCount > 0 ? tt('supportPanel.shapeSelected', { n: selectedCount }) : tt('supportPanel.shapeDefaults')}</span>
        {scope.total > 0 && <small>{tt('supportPanel.customisedCount', { n: scope.customised.length, total: scope.total })}</small>}
        <span className="sp-band-actions">
          {selectedCount > 0 && (
            <Button onClick={resetSelected} disabled={scope.customisedSelected.length === 0} title={tt('supportPanel.resetHint')}>{tt('supportPanel.reset')}</Button>
          )}
          {scope.customised.length > 0 && (
            <Button onClick={selectCustomised} title={tt('supportPanel.selectCustomisedHint')}>{tt('supportPanel.selectCustomised')}</Button>
          )}
        </span>
      </div>

      {GROUPS.map((group) => <Group key={group.id} title={tt(group.title)}>{group.fields.map(renderField)}</Group>)}

      <Group title={tt('supportPanel.group.object')}>
        <NumberField label={tt('supportPanel.liftHeight')} unit="mm" step={0.5} min={settingLimits.liftHeight.min}
          max={settingLimits.liftHeight.max} value={settings.liftHeight} disabled={disabled}
          onCommit={(v) => edit('liftHeight', v)} />
        <div className="field-row">
          <label>{tt('supportPanel.previewMode')}</label>
          <Segmented<string> label={tt('supportPanel.previewMode')} value={settings.previewMode} disabled={disabled}
            options={[{ value: 'FULL', label: tt('supportPanel.preview.full') }, { value: 'ONLY_TIP', label: tt('supportPanel.preview.tips') }]}
            onChange={(v) => edit('previewMode', v as never)} />
        </div>
      </Group>
      {record === undefined && <p className="mx-hint">{tt('supportPanel.noSupportsYet')}</p>}
    </div>
  );
}
