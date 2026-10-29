import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Check } from './Check';

afterEach(cleanup);

describe('Check', () => {
  it('is a labelled checkbox that reports the new state', () => {
    const fn = vi.fn();
    render(<Check label="Snap" checked={false} onChange={fn} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Snap' }));
    expect(fn).toHaveBeenCalledWith(true);
  });
  it('disabled does not fire', () => {
    const fn = vi.fn();
    render(<Check label="Snap" checked disabled onChange={fn} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });
});
