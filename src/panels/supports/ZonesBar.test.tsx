import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { openEdit, renderPanel, resetWorld } from './testHarness';
import { ZonesBar } from './ZonesBar';
import { supportSession } from './sessionStore';
import { supportUi } from './supportUi';

afterEach(cleanup);
beforeEach(() => { resetWorld(); openEdit(); });

describe('ZonesBar', () => {
  it('is a toggle that leaves Edit and opens the brush (Paint, radius 2 mm)', () => {
    renderPanel(<ZonesBar />);
    expect(screen.queryByRole('group', { name: 'Brush' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Support area' }));
    expect(supportSession.get().mode).toBe('zones');
    expect(screen.getByRole('status').textContent).toBe('Drag on the model to paint a no-support zone');
    const radius = screen.getByLabelText('Brush radius') as HTMLInputElement;
    expect(radius.value).toBe('2');
  });

  it('switches Paint | Erase and sets the radius', () => {
    renderPanel(<ZonesBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Support area' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase' }));
    expect(supportSession.get().zoneKind).toBe('erase');
    fireEvent.change(screen.getByLabelText('Brush radius'), { target: { value: '5' } });
    expect(supportSession.get().zoneRadius).toBe(5);
  });

  it('turning it off returns to Edit; the bottom-view note goes away in Bottom view', () => {
    renderPanel(<ZonesBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Support area' }));
    expect(screen.getByRole('note').textContent).toMatch(/Bottom view/);
    fireEvent.click(screen.getByRole('button', { name: 'Support area' }));
    expect(supportSession.get().mode).toBe('edit');
    fireEvent.click(screen.getByRole('button', { name: 'Support area' }));
    act(() => supportUi.set({ bottomView: true }));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
