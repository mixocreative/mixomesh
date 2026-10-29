import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RangeField } from './RangeField';

afterEach(cleanup);

const base = { label: 'Size', min: 0, max: 10, step: 0.5 };

describe('RangeField', () => {
  it('renders slider and number with the value', () => {
    render(<RangeField {...base} value={2.5} unit="mm" onCommit={() => {}} />);
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('2.5');
    expect((screen.getByLabelText('Size value') as HTMLInputElement).value).toBe('2.5');
  });
  it('slider: onInput while moving, onCommit once on release', () => {
    const live = vi.fn();
    const done = vi.fn();
    render(<RangeField {...base} value={2} onInput={live} onCommit={done} />);
    const s = screen.getByLabelText('Size');
    fireEvent.change(s, { target: { value: '4' } });
    fireEvent.change(s, { target: { value: '6' } });
    expect(live).toHaveBeenCalledTimes(2);
    expect(done).not.toHaveBeenCalled();
    fireEvent.pointerUp(s);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(6);
    fireEvent.pointerUp(s);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('keyboard on slider commits on key up', () => {
    const done = vi.fn();
    render(<RangeField {...base} value={2} onCommit={done} />);
    const s = screen.getByLabelText('Size');
    fireEvent.change(s, { target: { value: '2.5' } });
    fireEvent.keyUp(s, { key: 'ArrowRight' });
    expect(done).toHaveBeenCalledWith(2.5);
  });
  it('typed number clamps and commits on Enter', () => {
    const done = vi.fn();
    render(<RangeField {...base} value={2} unit="mm" onCommit={done} />);
    const n = screen.getByLabelText('Size value');
    fireEvent.change(n, { target: { value: '99mm' } });
    fireEvent.keyDown(n, { key: 'Enter' });
    expect(done).toHaveBeenCalledWith(10);
  });
});
