import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Segmented } from './Segmented';

afterEach(cleanup);

const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C', disabled: true }] as const;

describe('Segmented', () => {
  it('renders a named group with the chosen option pressed', () => {
    render(<Segmented label="Mode" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Mode' })).toBeTruthy();
    expect(screen.getByText('B').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('A').getAttribute('aria-pressed')).toBe('false');
  });
  it('click and arrow keys choose, skipping disabled options', () => {
    const fn = vi.fn();
    render(<Segmented label="Mode" options={opts} value="b" onChange={fn} />);
    fireEvent.click(screen.getByText('A'));
    expect(fn).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(screen.getByText('B'), { key: 'ArrowRight' });
    expect(fn).toHaveBeenLastCalledWith('a'); // wraps past disabled C
    fireEvent.keyDown(screen.getByText('B'), { key: 'ArrowLeft' });
    expect(fn).toHaveBeenLastCalledWith('a');
  });
  it('group disabled blocks clicks; only the chosen segment is a tab stop', () => {
    const fn = vi.fn();
    const { rerender } = render(<Segmented label="Mode" options={opts} value="a" onChange={fn} />);
    expect(screen.getByText('A').tabIndex).toBe(0);
    expect(screen.getByText('B').tabIndex).toBe(-1);
    rerender(<Segmented label="Mode" options={opts} value="a" onChange={fn} disabled />);
    fireEvent.click(screen.getByText('B'));
    expect(fn).not.toHaveBeenCalled();
  });
});
