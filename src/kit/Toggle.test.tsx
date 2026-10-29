import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Toggle } from './Toggle';

afterEach(cleanup);

describe('Toggle', () => {
  it('exposes aria-pressed and flips on click', () => {
    const fn = vi.fn();
    render(<Toggle pressed={false} onChange={fn}>Grid</Toggle>);
    const b = screen.getByRole('button', { name: 'Grid' });
    expect(b.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledWith(true);
  });
  it('pressed toggles off; disabled does nothing', () => {
    const fn = vi.fn();
    const { rerender } = render(<Toggle pressed onChange={fn}>Grid</Toggle>);
    fireEvent.click(screen.getByText('Grid'));
    expect(fn).toHaveBeenCalledWith(false);
    fn.mockClear();
    rerender(<Toggle pressed onChange={fn} disabled>Grid</Toggle>);
    fireEvent.click(screen.getByText('Grid'));
    expect(fn).not.toHaveBeenCalled();
  });
});
