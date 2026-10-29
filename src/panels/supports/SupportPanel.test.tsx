import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { openEdit, record, renderPanel, resetWorld } from './testHarness';
import { SupportPanel } from './SupportPanel';
import { supportSession } from './sessionStore';
import { emptySupports } from '../../supports/model';
import { undo } from '../../core/HistoryManager.js';

afterEach(cleanup);
beforeEach(() => { resetWorld(); openEdit(); });

const commit = (label: string, text: string) => {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('SupportPanel', () => {
  it('renders the presets, the fields and the lift height', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    expect(screen.getByRole('button', { name: 'Light' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Middle' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Heavy' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Custom' }) as HTMLButtonElement).disabled).toBe(true);
    for (const label of ['Contact diameter', 'Penetration', 'Neck length', 'Max neck angle', 'Pillar diameter', 'Foot diameter', 'Lift height']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByRole('group', { name: 'Tip shape' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Tip profile' })).toBeTruthy();
  });

  it('picking a preset applies it as one undo step', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
    expect(record().settings.preset).toBe('HEAVY');
    expect(screen.getByRole('button', { name: 'Heavy' }).getAttribute('aria-pressed')).toBe('true');
    act(() => undo());
    expect(record().settings.preset).toBe('MIDDLE');
  });

  it('editing a preset-owned key flips the preset to Custom', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    commit('Pillar diameter', '1.4');
    expect(record().settings.pillarDiameter).toBe(1.4);
    expect(record().settings.preset).toBe('CUSTOM');
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Middle' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clamps a typed value with the engine limits', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    commit('Max neck angle', '200');
    expect(record().settings.maxNeckAngle).toBe(89);
    commit('Lift height', '500');
    expect(record().settings.liftHeight).toBe(200);
  });

  it('choices write the setting; the contact shape swaps the diameter field', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    expect(record().settings.tipSection).toBe('SQUARE');
    fireEvent.click(screen.getByRole('button', { name: 'Sphere' }));
    expect(record().settings.contactShape).toBe('SPHERE');
    expect(screen.queryByLabelText('Penetration')).toBeNull();
    expect(screen.getByLabelText('Contact depth')).toBeTruthy();
    expect(screen.getByLabelText('Contact diameter')).toBeTruthy();
  });

  it('with a selection, tip edits write per-support overrides and the object stays untouched', () => {
    renderPanel(<SupportPanel objectId="obj" />);
    act(() => { supportSession.send({ type: 'paint', ids: ['auto-a', 'auto-b'], mode: 'select' }); });
    expect(screen.getByText('Support shape · 2 selected')).toBeTruthy();
    const defaults = record().settings.neckLength;
    commit('Neck length', '2.5');
    expect(record().overrides['auto-a']).toEqual({ neckLength: 2.5 });
    expect(record().overrides['auto-b']).toEqual({ neckLength: 2.5 });
    expect(record().overrides['auto-c']).toBeUndefined();
    expect(record().settings.neckLength).toBe(defaults);
    expect(record().settings.preset).toBe('MIDDLE');
    // The pillar is object-wide even with a selection.
    commit('Pillar diameter', '1.3');
    expect(record().settings.pillarDiameter).toBe(1.3);
    expect(record().overrides['auto-a']).toEqual({ neckLength: 2.5 });
  });

  it('Reset gives the selected supports the defaults again; Select customised picks them', () => {
    resetWorld({ ...emptySupports(), overrides: { 'auto-a': { neckLength: 2 }, 'auto-c': { neckLength: 3 } } });
    openEdit();
    renderPanel(<SupportPanel objectId="obj" />);
    expect(screen.getByText('2 of 3 customised')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select customised' }));
    expect([...supportSession.get().selection].sort()).toEqual(['auto-a', 'auto-c']);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(record().overrides).toEqual({});
    expect(within(document.body).getByText('Reset 2 supports to the defaults.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Object.keys(record().overrides).sort()).toEqual(['auto-a', 'auto-c']);
  });

  it('marks a field whose selected supports differ', () => {
    resetWorld({ ...emptySupports(), overrides: { 'auto-a': { neckLength: 3.3 } } });
    openEdit();
    renderPanel(<SupportPanel objectId="obj" />);
    act(() => { supportSession.send({ type: 'paint', ids: ['auto-a', 'auto-b'], mode: 'select' }); });
    expect(screen.getByLabelText('Neck length (mixed)')).toBeTruthy();
  });

  describe('structure sections (plan P5.1-P5.4)', () => {
    it('Tree: the toggle shows merge distance, branch descent and safe distance, clamped by the limits', () => {
      renderPanel(<SupportPanel objectId="obj" />);
      expect(screen.queryByLabelText('Merge distance')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Auto tree' }));
      expect(record().settings.scatterAutoTree).toBe(true);
      expect(screen.getByLabelText('Merge distance')).toBeTruthy();
      commit('Merge distance', '2500');
      expect(record().settings.scatterMergeDistance).toBe(1000);
      commit('Branch descent', '-4');
      expect(record().settings.scatterBranchDescent).toBe(-4);
      commit('Safe distance', '1.5');
      expect(record().settings.scatterSafeDistance).toBe(1.5);
      expect(record().settings.preset).toBe('CUSTOM');
    });

    it('Preset values: Heavy sets the merge distance to 4 mm and keeps the raft / brace defaults', () => {
      renderPanel(<SupportPanel objectId="obj" />);
      fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
      expect(record().settings.scatterMergeDistance).toBe(4);
      expect(record().settings.raftWallAngle).toBe(30);
      expect(record().settings.trussSpacing).toBe(2);
    });

    it('Brace: angle, spacing, min height and distance limit are clamped; the toggle hides them', () => {
      renderPanel(<SupportPanel objectId="obj" />);
      commit('Brace angle', '85');
      expect(record().settings.trussAngle).toBe(60);
      commit('Brace spacing', '3');
      commit('Min height', '4');
      commit('Distance limit', '50');
      expect(record().settings).toMatchObject({ trussSpacing: 3, trussMinHeight: 4, trussDistanceLimit: 50 });
      fireEvent.click(screen.getByRole('button', { name: 'Cross-braces' }));
      expect(record().settings.trussEnabled).toBe(false);
      expect(screen.queryByLabelText('Brace angle')).toBeNull();
    });

    it('Raft: parameters write through; off hides them', () => {
      renderPanel(<SupportPanel objectId="obj" />);
      commit('Floor thickness', '1.5');
      commit('Wall height', '2');
      commit('Wall thickness', '0.8');
      commit('Wall lean', '120');
      commit('Expand', '4');
      expect(record().settings).toMatchObject({ raftFloorThickness: 1.5, raftWallHeight: 2, raftWallThickness: 0.8, raftWallAngle: 89, raftExpandWidth: 4 });
      fireEvent.click(screen.getByRole('button', { name: 'Add raft' }));
      expect(record().settings.raftEnabled).toBe(false);
      expect(screen.queryByLabelText('Wall lean')).toBeNull();
    });

    it('Label: text is uppercased and limited to A-Z 0-9 - and 8 characters, with a hint for rejected characters; the default is the object name', () => {
      renderPanel(<SupportPanel objectId="obj" />);
      const text = screen.getByLabelText('Text') as HTMLInputElement;
      expect(text.placeholder).toBe('CROWN');
      fireEvent.change(text, { target: { value: 'ab_c 12!' } });
      expect(text.value).toBe('ABC12');
      expect(screen.getByText('Only letters A-Z, digits 0-9 and - are allowed, up to 8 characters.')).toBeTruthy();
      fireEvent.change(text, { target: { value: 'abc-1234567' } });
      expect(text.value).toBe('ABC-1234');
      fireEvent.keyDown(text, { key: 'Enter' });
      expect(record().settings.labelText).toBe('ABC-1234');
      commit('Size', '80');
      commit('Height', '0.05');
      expect(record().settings).toMatchObject({ labelSize: 50, labelHeight: 0.1 });
      fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
      expect(record().settings.labelEnabled).toBe(false);
      expect(screen.queryByLabelText('Text')).toBeNull();
    });
  });
});
