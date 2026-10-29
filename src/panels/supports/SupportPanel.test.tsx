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
});
