import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ColorField } from './ColorField';

afterEach(cleanup);

describe('ColorField', () => {
  it('shows value and hex readout', () => {
    render(<ColorField label="Tint" value="#7f0019" onCommit={() => {}} />);
    expect((screen.getByLabelText('Tint') as HTMLInputElement).value).toBe('#7f0019');
    expect(screen.getByText('#7F0019')).toBeTruthy();
  });
  it('input event is live (onInput), change commits (onCommit)', () => {
    const live = vi.fn();
    const done = vi.fn();
    render(<ColorField label="Tint" value="#7f0019" onInput={live} onCommit={done} />);
    const el = screen.getByLabelText('Tint');
    fireEvent.input(el, { target: { value: '#112233' } });
    expect(live).toHaveBeenCalledWith('#112233');
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(el, { target: { value: '#445566' } });
    expect(done).toHaveBeenCalledWith('#445566');
  });
});
