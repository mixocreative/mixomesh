import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TextField } from './TextField';

afterEach(cleanup);
const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);

describe('TextField', () => {
  it('shows the value and commits on Enter', () => {
    const done = vi.fn();
    render(<TextField label="Text" value="AB" onCommit={done} />);
    const el = screen.getByLabelText('Text') as HTMLInputElement;
    expect(el.value).toBe('AB');
    fireEvent.change(el, { target: { value: 'ABC' } });
    expect(done).not.toHaveBeenCalled();
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(done).toHaveBeenCalledWith('ABC');
  });
  it('filters typed text and shows the hint when characters were removed', () => {
    render(<TextField label="Text" value="" filter={upper} rejectedHint="A-Z 0-9 - only" onCommit={() => {}} />);
    const el = screen.getByLabelText('Text') as HTMLInputElement;
    fireEvent.change(el, { target: { value: 'ab c' } });
    expect(el.value).toBe('ABC');
    expect(screen.getByRole('status').textContent).toBe('A-Z 0-9 - only');
    fireEvent.change(el, { target: { value: 'ABCD' } });
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('Esc reverts and blur commits a changed text once', () => {
    const done = vi.fn();
    render(<TextField label="Text" value="X" onCommit={done} />);
    const el = screen.getByLabelText('Text') as HTMLInputElement;
    fireEvent.change(el, { target: { value: 'Y' } });
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(el.value).toBe('X');
    fireEvent.blur(el);
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(el, { target: { value: 'Z' } });
    fireEvent.blur(el);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
