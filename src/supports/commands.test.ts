// Plan P3.1: every support command does and undoes as exactly one HistoryManager step, and
// object.supports stays JSON-safe and round-trips through JSON unchanged.
import './testEnv';
/* eslint-disable @typescript-eslint/no-explicit-any -- state.scene.objects is untyped JS state */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import type { ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import { getState, setState } from '../core/StateManager.js';
import { clear, getRedoLabel, getUndoLabel, redo, undo } from '../core/HistoryManager.js';
import { t } from '../i18n/index.js';
import {
  AddSupportCommand, ApplyPresetCommand, ChangeSettingsCommand, DeleteSupportsCommand, LiftForSupportsCommand,
  ResetOverrideCommand, SetOverrideCommand, StampStrokeCommand, commitSupportEdits, type LiftScene, type WorldTransform,
} from './commands';
import { emptySupports, packStamps, readStamps, type ObjectSupports } from './model';
import { readSupports } from './store';

const auto = (id: string, position: [number, number, number]): SupportPoint => ({ id, regionId: 0, position, normal: [0, -1, 0], source: 'interior' });
const AUTO = [auto('auto-a', [0, -5, 0]), auto('auto-b', [3, -5, 0]), auto('auto-c', [6, -5, 0])];

function object(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, visible: true, locked: false, logicalObjectId: null, isInternalPart: false, ...extra };
}

/** Scene: logical object `lead` (+ internal part `part`), and a plain object `other`. */
function resetScene(supports?: ObjectSupports) {
  clear();
  setState((s: any) => ({
    ...s,
    scene: {
      ...s.scene,
      objects: {
        lead: object('lead', { logicalObjectId: 'lead', ...(supports ? { supports } : {}) }),
        part: object('part', { logicalObjectId: 'lead', isInternalPart: true }),
        other: object('other'),
      },
    },
  }), { silent: true });
}

const objects = () => JSON.parse(JSON.stringify(getState().scene.objects));

/** Push one command: one new undo step labelled `label`; undo restores the objects exactly; redo re-applies. */
function oneStep(run: () => void, label: string) {
  const before = objects();
  const stepsBefore = getUndoLabel();
  run();
  const after = objects();
  expect(getUndoLabel()).toBe(label);
  expect(after).not.toEqual(before);
  // Round-trip through JSON unchanged (D19).
  const record = getState().scene.objects.lead.supports ?? getState().scene.objects.other.supports;
  expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  undo();
  expect(objects()).toEqual(before);
  expect(getUndoLabel()).toBe(stepsBefore);
  expect(getRedoLabel()).toBe(label);
  redo();
  expect(objects()).toEqual(after);
  return after;
}

const built = (): ObjectSupports => ({
  ...emptySupports(),
  sourceHash: 'h', pose: { rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, revision: 3,
});

describe('support commands: one HistoryManager step each', () => {
  beforeEach(() => resetScene(built()));

  it('labels are locale keys that resolve (not the key itself)', () => {
    expect(t('history.supportAdd')).toBe('Add support');
    expect(t('history.supportDeleteCount', { n: 2 })).toBe('Delete supports (2)');
    expect(t('history.liftForSupports')).toBe('Lift for supports');
  });

  it('supports live on the lead: a command on a part writes the lead', () => {
    commitSupportEdits([new DeleteSupportsCommand('part', ['auto-a'])]);
    expect(getState().scene.objects.part.supports).toBeUndefined();
    expect(readSupports('part')!.deleted).toEqual(['auto-a']);
  });

  it('AddSupport at a free spot adds one manual tip', () => {
    const cmd = new AddSupportCommand('lead', { point: [20, -5, 0], normal: [0, -1, 0], worldNormal: [0, -1, 0], minFromUpDeg: 0, candidates: AUTO, createId: () => 'manual-1' });
    const after = oneStep(() => commitSupportEdits([cmd]), t('history.supportAdd'));
    expect(after.lead.supports.manual.map((p: SupportPoint) => p.id)).toEqual(['manual-1']);
    expect(after.lead.supports.deleted).toEqual([]);
    expect(cmd.plan!.status).toBe('added');
  });

  it('AddSupport near an automatic tip snaps onto it and deletes that tip in the same step', () => {
    const cmd = new AddSupportCommand('lead', { point: [3.4, -5, 0], normal: [0, -1, 0], worldNormal: [0, -1, 0], minFromUpDeg: 0, candidates: AUTO, createId: () => 'manual-2' });
    const after = oneStep(() => commitSupportEdits([cmd]), t('history.supportAdd'));
    expect(after.lead.supports.manual[0].position).toEqual([3, -5, 0]);
    expect(after.lead.supports.deleted).toEqual(['auto-b']);
  });

  it('AddSupport does not snap to a tip already removed', () => {
    resetScene({ ...built(), deleted: ['auto-b'] });
    const cmd = new AddSupportCommand('lead', { point: [3.4, -5, 0], normal: [0, -1, 0], worldNormal: [0, -1, 0], minFromUpDeg: 0, candidates: AUTO, createId: () => 'm' });
    commitSupportEdits([cmd]);
    expect(cmd.plan!.removeId).toBeUndefined();
    expect(readSupports('lead')!.manual[0]!.position).toEqual([3.4, -5, 0]);
  });

  it('DeleteSupports: automatic ids go to deleted, manual ones leave with their settings', () => {
    resetScene({ ...built(), manual: [auto('manual-x', [1, -5, 1])], overrides: { 'manual-x': { neckDiameter: 0.5 }, 'auto-c': { neckDiameter: 0.6 } } });
    const after = oneStep(() => commitSupportEdits([new DeleteSupportsCommand('lead', ['auto-a', 'manual-x', 'auto-a'])]), t('history.supportDeleteCount', { n: 2 }));
    expect(after.lead.supports.deleted).toEqual(['auto-a']);
    expect(after.lead.supports.manual).toEqual([]);
    expect(after.lead.supports.overrides).toEqual({ 'auto-c': { neckDiameter: 0.6 } });
  });

  it('StampStroke appends a whole stroke as one step (paint and erase)', () => {
    const stamp = (kind: 'paint' | 'erase', x: number): ZoneStamp => ({ kind, center: [x, -5, 0], radius: 1.5, normal: [0, -1, 0] });
    const paint = oneStep(() => commitSupportEdits([new StampStrokeCommand('lead', [stamp('paint', 0), stamp('paint', 0.75), stamp('paint', 1.5)])]), t('history.supportZonePaint'));
    expect(readStamps(paint.lead.supports.stamps)).toHaveLength(3);
    const erase = oneStep(() => commitSupportEdits([new StampStrokeCommand('lead', [stamp('erase', 0)])]), t('history.supportZoneErase'));
    expect(readStamps(erase.lead.supports.stamps).map((s) => s.kind)).toEqual(['paint', 'paint', 'paint', 'erase']);
  });

  it('SetOverride merges a sanitised patch; ResetOverride removes it', () => {
    const set = oneStep(() => commitSupportEdits([new SetOverrideCommand('lead', ['auto-a', 'auto-b'], { neckDiameter: 0.5, bogus: 1 } as never)]), t('history.supportOverride'));
    expect(set.lead.supports.overrides).toEqual({ 'auto-a': { neckDiameter: 0.5 }, 'auto-b': { neckDiameter: 0.5 } });
    const reset = oneStep(() => commitSupportEdits([new ResetOverrideCommand('lead', ['auto-a'])]), t('history.supportResetOverride'));
    expect(reset.lead.supports.overrides).toEqual({ 'auto-b': { neckDiameter: 0.5 } });
  });

  it('ChangeSettings writes through updateSetting (a preset key makes the preset Custom)', () => {
    const after = oneStep(() => commitSupportEdits([new ChangeSettingsCommand('lead', { neckDiameter: 0.9, liftHeight: 7 })]), t('history.supportSettings'));
    expect(after.lead.supports.settings.neckDiameter).toBe(0.9);
    expect(after.lead.supports.settings.liftHeight).toBe(7);
    expect(after.lead.supports.settings.preset).toBe('CUSTOM');
  });

  it('ApplyPreset writes the preset values and name', () => {
    const after = oneStep(() => commitSupportEdits([new ApplyPresetCommand('lead', 'HEAVY')]), t('history.supportPreset', { name: t('supports.preset.HEAVY') }));
    expect(after.lead.supports.settings.preset).toBe('HEAVY');
  });

  it('the first edit of an object without supports creates the record; undo removes it again', () => {
    resetScene();
    const after = oneStep(() => commitSupportEdits([new ApplyPresetCommand('other', 'LIGHT')]), t('history.supportPreset', { name: t('supports.preset.LIGHT') }));
    expect(after.other.supports.settings.preset).toBe('LIGHT');
    undo();
    expect('supports' in getState().scene.objects.other).toBe(false);
  });

  it('every edit takes a fresh revision, never reused after undo', () => {
    commitSupportEdits([new DeleteSupportsCommand('lead', ['auto-a'])]);
    const r1 = readSupports('lead')!.revision;
    undo();
    commitSupportEdits([new DeleteSupportsCommand('lead', ['auto-b'])]);
    const r2 = readSupports('lead')!.revision;
    expect(r1).toBeGreaterThan(3);
    expect(r2).toBeGreaterThan(r1);
  });

  it('a gesture over several objects is one batch step; chained edits of one object compose', () => {
    resetScene();
    const label = t('history.supportPreset', { name: t('supports.preset.MIDDLE') });
    const after = oneStep(() => commitSupportEdits([
      new ApplyPresetCommand('lead', 'MIDDLE'),
      new ApplyPresetCommand('other', 'MIDDLE'),
      new ChangeSettingsCommand('lead', { liftHeight: 4 }),
    ], label), label);
    expect(after.lead.supports.settings.liftHeight).toBe(4);
    expect(after.other.supports.settings.preset).toBe('MIDDLE');
  });

  it('LiftForSupports moves every part so the lowest point stands the lift above the bed', () => {
    const transforms: Record<string, WorldTransform> = {
      lead: { position: { x: 0.01, y: -0.002, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scaling: { x: 1, y: 1, z: 1 } },
      part: { position: { x: 0.01, y: -0.002, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scaling: { x: 1, y: 1, z: 1 } },
    };
    const scene: LiftScene = {
      parts: () => ['lead', 'part'],
      minY: () => transforms.lead!.position.y - 0.001,   // geometry reaches 1 mm under the origin
      capture: (id) => structuredClone(transforms[id]!),
      apply: (snapshot) => { for (const [id, tr] of Object.entries(snapshot)) transforms[id] = structuredClone(tr); },
    };
    const initial = structuredClone(transforms);
    const cmd = new LiftForSupportsCommand('part', 5, scene);
    expect(cmd.moves).toBe(true);
    commitSupportEdits([cmd]);
    expect(getUndoLabel()).toBe(t('history.liftForSupports'));
    expect(transforms.lead!.position.y - 0.001).toBeCloseTo(0.005, 9);
    expect(transforms.part!.position.y).toBeCloseTo(transforms.lead!.position.y, 12);
    expect(transforms.lead!.position.x).toBe(0.01);
    undo();
    expect(transforms).toEqual(initial);
  });
});

describe('object.supports JSON', () => {
  it('a full record, stamps past the base64 limit included, round-trips through JSON unchanged', () => {
    const stamps: ZoneStamp[] = Array.from({ length: 2000 }, (_, k) => ({ kind: k % 3 ? 'paint' : 'erase', center: [k * 0.1, -5 + 1 / 3, Math.PI], radius: 1.5, normal: [0, -1, 1e-17] }));
    const record: ObjectSupports = {
      ...built(),
      deleted: ['auto-1_2_3'],
      manual: [auto('manual-1', [1 / 3, -5, 2])],
      overrides: { 'manual-1': { tipSection: 'CROSS', neckDiameter: 0.45 } },
      stamps: packStamps(stamps),
      placed: { scatterSpacing: 2, scatterFacingDown: true },
      stale: 'pose',
    };
    expect(typeof record.stamps.data).toBe('string');   // 14000 numbers > 10k: base64
    const back = JSON.parse(JSON.stringify(record));
    expect(back).toEqual(record);
    expect(readStamps(back.stamps)).toEqual(stamps);
    expect(readStamps(packStamps(stamps.slice(0, 10))).length).toBe(10);
    expect(Array.isArray(packStamps(stamps.slice(0, 10)).data)).toBe(true);
  });
});
