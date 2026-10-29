import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { openEdit, record, renderPanel, resetWorld } from './testHarness';
import { EditBar, engagedKey } from './EditBar';
import { supportSession } from './sessionStore';
import { gesture } from '@mixo-geocore/editing/gesture';

afterEach(cleanup);
beforeEach(() => { resetWorld(); openEdit(); });

const engaged = () => screen.getByTestId('engaged-tool').textContent;

describe('EditBar', () => {
  it('names the engaged tool with what a click does', () => {
    renderPanel(<EditBar objectId="obj" />);
    expect(engaged()).toBe('Click the model to add a support');
    fireEvent.click(screen.getByRole('button', { name: 'Removes' }));
    expect(engaged()).toBe('Click a support to remove it');
    fireEvent.click(screen.getByRole('button', { name: /^Select/ }));
    expect(engaged()).toBe('Click a support to select it');
    fireEvent.click(screen.getByRole('button', { name: 'Drag over' }));
    expect(engaged()).toBe('Drag over supports to select them');
    fireEvent.click(screen.getByRole('button', { name: 'Unselect' }));
    expect(engaged()).toBe('Drag over supports to unselect them');
  });

  it('every gesture has a name key', () => {
    expect(engagedKey(gesture(supportSession.get()))).toBe('supportPanel.engaged.add');
    expect(engagedKey({ kind: 'none' })).toBe('supportPanel.engaged.none');
  });

  it('the Add | Remove switch and Click reach belong to the Add tool', () => {
    renderPanel(<EditBar objectId="obj" />);
    expect(screen.getByRole('group', { name: 'A click' })).toBeTruthy();
    const reach = screen.getByLabelText('Click reach') as HTMLInputElement;
    fireEvent.change(reach, { target: { value: '3' } });
    fireEvent.keyDown(reach, { key: 'Enter' });
    expect(record().settings.eraseRadius).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: /^Select/ }));
    expect(screen.queryByRole('group', { name: 'A click' })).toBeNull();
    expect(screen.queryByLabelText('Click reach')).toBeNull();
  });

  it('Drag over offers a circle of 8 to 80 px, default 24', () => {
    renderPanel(<EditBar objectId="obj" />);
    fireEvent.click(screen.getByRole('button', { name: /^Select/ }));
    expect(screen.queryByLabelText('Circle size')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Drag over' }));
    const slider = screen.getByLabelText('Circle size') as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(['8', '80', '24']);
    fireEvent.change(slider, { target: { value: '48' } });
    expect(supportSession.get().brushRadius).toBe(48);
    expect(supportSession.get().brushSizing).toBe(true);
    fireEvent.pointerUp(slider);
    expect(supportSession.get().brushSizing).toBe(false);
  });

  it('selected supports show their count; Delete removes them as one undoable step with a toast', () => {
    renderPanel(<EditBar objectId="obj" />);
    act(() => { supportSession.send({ type: 'paint', ids: ['auto-a', 'auto-b'], mode: 'select' }); });
    expect(screen.getByText('2 supports selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    expect([...record().deleted].sort()).toEqual(['auto-a', 'auto-b']);
    expect(supportSession.get().selection.size).toBe(0);
    expect(screen.getByText('Deleted 2 supports.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(record().deleted).toEqual([]);
  });

  it('turning the mode toggle off leaves the tools hidden', () => {
    renderPanel(<EditBar objectId="obj" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit supports' }));
    expect(supportSession.get().mode).toBe('off');
    expect(screen.queryByTestId('engaged-tool')).toBeNull();
  });
});
